"""Общее для разборщиков кода (ТЗ §6.2): чей файл, на каком он стеке, куда ведёт импорт.

Стек файла определяется по манифесту пакета-владельца и расширению, а не по содержимому
вслепую: владелец файла — ближайший вверх по дереву каталог с манифестом сборки того же
языка (requirements/*.txt считаются манифестом каталога выше, manifests.py). Разборщик
FastAPI читает только файлы пакетов, у которых в зависимостях есть fastapi или starlette;
разборщик параметров Python — файлы любого пакета Python. Индексы считаются один раз за
запуск и лежат в Files.memo.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Iterator
from typing import cast

from archmap_scan import paths, texts
from archmap_scan.context import Context
from archmap_scan.model import Package
from archmap_scan.parsers import manifests
from archmap_scan.walk import (
    CODE_SKIP_DIRS,
    TEST_HELPER,
    TOOL_CONFIG,
    TOOLING_DIR,
    Files,
    tooling_kind,
)

PYTHON, NODE, GO, RUBY = "Python", "Node.js", "Go", "Ruby"
DOTNET, JAVA, RUST, KOTLIN = ".NET", "Java", "Rust", "Kotlin"

LANG_EXTS: dict[str, tuple[str, ...]] = {
    PYTHON: (".py",),
    NODE: (".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx"),
    GO: (".go",),
    RUBY: (".rb",),  # только классы воркеров Sidekiq (ТЗ §15 п. 13 В3)
    DOTNET: (".cs",),
    JAVA: (".java",),
    # Файлы Kotlin у пакетов Gradle с плагином Kotlin (ТЗ §15 п. 17): .kts — сценарии сборки.
    KOTLIN: (".kt",),
    RUST: (".rs",),  # только параметры конфигурации (ТЗ §15 п. 14 И2)
}
# Собранный и сжатый код, объявления типов: исполняемого кода продукта там нет.
_GENERATED_SUFFIXES = (".min.js", ".bundle.js", ".d.ts", ".d.mts", ".d.cts")


def packages(files: Files, ctx: Context) -> list[Package]:
    """Манифесты сборки репозитория (один разбор на запуск)."""
    memo = files.memo.get("packages")
    if memo is None:
        memo = manifests.parse(files, ctx).packages
        files.memo["packages"] = memo
    return cast(list[Package], memo)


def _index(files: Files, ctx: Context) -> dict[tuple[str, str], list[Package]]:
    memo = files.memo.get("package-index")
    if memo is None:
        index: dict[tuple[str, str], list[Package]] = {}
        for pkg in packages(files, ctx):
            index.setdefault((pkg.language, pkg.dir), []).append(pkg)
        memo = files.memo["package-index"] = index
    return cast(dict[tuple[str, str], list[Package]], memo)


def owner_packages(files: Files, ctx: Context, rel: str, language: str) -> list[Package]:
    """Манифесты языка в ближайшем вверх по дереву каталоге файла rel (пусто — нет)."""
    index = _index(files, ctx)
    folder = paths.parent(rel)
    for _ in range(64):
        found = index.get((language, folder))
        if found:
            return found
        if not folder:
            break
        folder = paths.parent(folder)
    return []


def deps_of(files: Files, ctx: Context, rel: str, language: str) -> frozenset[str]:
    return frozenset(d for p in owner_packages(files, ctx, rel, language) for d in p.deps)


def _matches(deps: Iterable[str], wanted: frozenset[str] | None) -> bool:
    """Есть ли среди зависимостей одна из wanted: точно (без учёта регистра) или модуль Go
    с версией (github.com/segmentio/kafka-go/v2)."""
    if wanted is None:
        return True
    for dep in deps:
        low = dep.lower()
        if low in wanted or any(low.startswith(w + "/v") for w in wanted):
            return True
    return False


def stack_present(
    files: Files, ctx: Context, language: str, wanted: frozenset[str] | None = None,
) -> bool:
    """Есть ли в репозитории пакет языка (с одной из зависимостей wanted, если задано)."""
    return any(
        p.language == language and _matches(p.deps, wanted) for p in packages(files, ctx)
    )


def is_code_file(rel: str, language: str) -> bool:
    low = rel.lower()
    if not low.endswith(LANG_EXTS[language]) or low.endswith(_GENERATED_SUFFIXES):
        return False
    return not any(seg in CODE_SKIP_DIRS for seg in rel.split("/")[:-1])


def code_files(
    files: Files, ctx: Context, language: str, wanted: frozenset[str] | None = None,
) -> list[str]:
    """Файлы кода языка, ближайший пакет которых на нужном стеке (wanted — зависимости,
    хотя бы одна из которых нужна; None — любой пакет этого языка). Код в каталогах для
    разработки сюда не попадает, а пропуск считается в покрытии (ТЗ §4): это одно место
    отбора для всех разборщиков яруса кода."""
    out: list[str] = []
    for rel in files.paths:
        if not is_code_file(rel, language):
            continue
        pkgs = owner_packages(files, ctx, rel, language)
        if not pkgs or not _matches((d for p in pkgs for d in p.deps), wanted):
            continue
        if not files.skip_dev_code(rel):
            out.append(rel)
    return out


_TOOLING_REASONS = {
    TOOLING_DIR: texts.REASON_TOOLING_DIR,
    TOOL_CONFIG: texts.REASON_TOOL_CONFIG,
    TEST_HELPER: texts.REASON_TEST_HELPER,
}


def tooling_reason(rel: str) -> str | None:
    """Файл кода в служебном каталоге или конфиг инструмента (ТЗ §13.1): причина для
    hints.unassigned, иначе None. Такой файл читается как обычный (code_files его не
    отсеивает: гарантии, что кода сервиса там нет, нет), но его записи сборка кладёт в
    подсказки, а не в факты и точки входа (codefacts.py). Одно место правила для всех
    разборщиков яруса кода."""
    kind = tooling_kind(rel)
    return _TOOLING_REASONS.get(kind) if kind is not None else None


def _paths(files: Files) -> frozenset[str]:
    memo = files.memo.get("paths")
    if memo is None:
        memo = files.memo["paths"] = frozenset(files.paths)
    return cast(frozenset[str], memo)


def _module_index(files: Files) -> dict[str, list[str]]:
    """Модуль Python по хвосту пути: «orders.api.routes» → [«services/orders/orders/api/
    routes.py»]. Пакет — его __init__.py."""
    memo = files.memo.get("py-modules")
    if memo is None:
        index: dict[str, list[str]] = {}
        for rel in files.paths:
            if not rel.endswith(".py"):
                continue
            parts = rel[:-3].split("/")
            if parts[-1] == "__init__":
                parts = parts[:-1]
            for i in range(len(parts)):
                index.setdefault(".".join(parts[i:]), []).append(rel)
        memo = files.memo["py-modules"] = index
    return cast(dict[str, list[str]], memo)


def _common(a: str, b: str) -> int:
    n = 0
    for x, y in zip(a.split("/"), b.split("/"), strict=False):
        if x != y:
            break
        n += 1
    return n


def resolve_module(files: Files, from_rel: str, module: str, level: int = 0) -> str | None:
    """Файл модуля Python, импортированного из from_rel: относительный импорт (level > 0)
    от каталога файла, абсолютный — по хвосту пути, ближайший к from_rel. Несколько
    одинаково близких кандидатов — None: куда ведёт импорт, не известно."""
    if level > 0:
        base = paths.parent(from_rel)
        for _ in range(level - 1):
            base = paths.parent(base)
        stem = "/".join(p for p in [base, *module.split(".")] if p)
        present = _paths(files)
        for cand in (stem + ".py", (stem + "/" if stem else "") + "__init__.py"):
            if cand in present:
                return cand
        return None
    found = _module_index(files).get(module, [])
    if not found:
        return None
    ranked = sorted(found, key=lambda c: -_common(c, from_rel))
    if len(ranked) > 1 and _common(ranked[0], from_rel) == _common(ranked[1], from_rel):
        return None
    return ranked[0]


def sources(
    files: Files, ctx: Context, language: str, wanted: frozenset[str] | None = None,
    needles: tuple[str, ...] = (), pattern: re.Pattern[str] | None = None,
) -> Iterator[tuple[str, str]]:
    """(файл, текст) кода языка на нужном стеке. needles и pattern — дешёвый отбор до
    разбора: файл без единой подстроки из needles и без совпадения pattern пропускается.
    Тексты кода в кэше обхода не остаются: их много, а читает их каждый разборщик сам."""
    for rel in code_files(files, ctx, language, wanted):
        text = files.read(rel, keep=False)
        if text is None:
            continue
        if (needles or pattern is not None) and not any(n in text for n in needles):
            if pattern is None or pattern.search(text) is None:
                continue
        yield rel, text


def has_dep(files: Files, ctx: Context, rel: str, language: str, dep: str) -> bool:
    """В манифесте пакета файла есть зависимость dep."""
    return _matches(deps_of(files, ctx, rel, language), frozenset({dep}))


def depends(deps: Iterable[str], dep: str) -> bool:
    """Среди зависимостей есть dep (модуль Go — и с версией в пути)."""
    return _matches(deps, frozenset({dep}))
