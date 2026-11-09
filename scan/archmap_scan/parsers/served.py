"""Код, который отдаёт файл OpenAPI (ТЗ §15 п. 15 Н1): литерал с базовым именем файла.

Для каждого файла OpenAPI вне каталогов документации ищется строковый литерал, равный его
базовому имени или кончающийся на «/имя» ("swagger.json", "static/openapi.yaml"), в коде
всех языков, которые сборщик знает: Python — по дереву ast, остальные — по маске
codetext (литерал в комментарии не считается). У файла Go с таким литералом дальше
собираются файлы Go, которые импортируют его пакет, до трёх шагов по импортам внутри
модулей репозитория (go.mod): от util/swagger к server/server.go и к cmd/argocd-server/.
Кому достаётся файл OpenAPI, решает сборка (openapi_owner.served) по владельцам этих файлов.

Пределы: 100 литералов на файл кода, 2000 файлов-импортёров на литерал (больше — импортёры
не считаются), заголовок файла Go до первого объявления не длиннее 200 тыс. знаков.
"""

from __future__ import annotations

import ast
import re

from archmap_scan import clike, codebase, codetext, gocode, paths, pyast
from archmap_scan.context import Context
from archmap_scan.model import Findings, Loc, ServedRef
from archmap_scan.parsers import openapi
from archmap_scan.walk import Files

NAME = "openapi-served"
_MASKS = {
    codebase.NODE: codetext.JS, codebase.GO: codetext.GO, codebase.DOTNET: codetext.CS,
    codebase.JAVA: codetext.JAVA, codebase.RUST: codetext.RUST, codebase.RUBY: codetext.RUBY,
}
_QUOTES = ("'", '"', "`")
_MAX_REFS = 100
_MAX_LITERAL = 2000
_MAX_DEPTH = 3
_MAX_IMPORTERS = 2000
_MAX_HEADER = 200_000
# Конец заголовка файла Go: первое объявление с начала строки (импорты стоят до него).
_DECLARATION = re.compile(r"^(?:func|type|var|const)\b", re.MULTILINE)


def _named(value: str, names: frozenset[str]) -> str | None:
    """Базовое имя файла OpenAPI, которое называет значение литерала, или None."""
    base = value.rsplit("/", 1)[-1]
    return base if base in names else None


def _python(rel: str, text: str, names: frozenset[str]) -> list[ServedRef]:
    tree = pyast.parse(text)
    if tree is None:
        return []
    out: list[ServedRef] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            base = _named(node.value, names)
            if base is not None:
                out.append(ServedRef(base, Loc(rel, node.lineno)))
                if len(out) >= _MAX_REFS:
                    break
    return out


def _masked(code: codetext.Code, rel: str, names: frozenset[str]) -> list[ServedRef]:
    """Литералы с именем по маске: имя в тексте, перед ним в маске кавычка и одни пробелы
    (содержимое литерала), сразу за ним та же кавычка; у комментария в маске кавычек нет.
    На каждое имя смотрится не больше clike.MAX_READS вхождений."""
    text, mask = code.text, code.mask
    out: list[ServedRef] = []
    for name in sorted(names):
        start = text.find(name)
        tries = 0
        while start != -1 and len(out) < _MAX_REFS and tries < clike.MAX_READS:
            tries += 1
            end = start + len(name)
            lo = max(0, start - _MAX_LITERAL)
            quote = max(mask.rfind(q, lo, start) for q in _QUOTES)
            if (
                quote >= 0 and text[quote] == mask[quote]
                and mask.count(" ", quote + 1, start) == start - quote - 1
                and mask[end:end + 1] == mask[quote]
                and (start == quote + 1 or text[start - 1] == "/")
            ):
                out.append(ServedRef(name, Loc(rel, code.line(start))))
            start = text.find(name, end)
    return out


def _modules(files: Files, ctx: Context) -> list[tuple[str, str]]:
    """Модули Go репозитория: (путь модуля, каталог go.mod), длинные пути первыми."""
    mods = [
        (p.name, p.dir) for p in codebase.packages(files, ctx)
        if p.kind == "go.mod" and p.name
    ]
    return sorted(mods, key=lambda m: -len(m[0]))


def _package_dir(imp: str, modules: list[tuple[str, str]]) -> str | None:
    for name, folder in modules:
        if imp == name or imp.startswith(name + "/"):
            rest = imp[len(name) + 1:]
            return "/".join(p for p in (folder, rest) if p)
    return None


def _importers(files: Files, ctx: Context) -> dict[str, list[str]]:
    """Каталог пакета Go → файлы Go, которые его импортируют (внутри модулей репозитория)."""
    modules = _modules(files, ctx)
    out: dict[str, list[str]] = {}
    if not modules:
        return out
    for rel, text in codebase.sources(files, ctx, codebase.GO):
        decl = _DECLARATION.search(text, 0, _MAX_HEADER)
        header = text[:decl.start() if decl is not None else min(len(text), _MAX_HEADER)]
        try:
            mask = codetext.mask(header, codetext.GO)
        except codetext.TooDense:
            continue
        own = paths.parent(rel)
        for _, imp in gocode.imports(header, mask):
            folder = _package_dir(imp, modules)
            if folder is not None and folder != own:
                out.setdefault(folder, []).append(rel)
    return out


def _reach(folder: str, index: dict[str, list[str]]) -> tuple[str, ...] | None:
    """Файлы, импортирующие пакет folder, и импортёры их пакетов (до _MAX_DEPTH шагов)."""
    found: set[str] = set()
    seen = {folder}
    frontier = [folder]
    for _ in range(_MAX_DEPTH):
        nxt: list[str] = []
        for d in frontier:
            for rel in index.get(d, ()):
                if rel in found:
                    continue
                found.add(rel)
                if len(found) > _MAX_IMPORTERS:
                    return None
                parent = paths.parent(rel)
                if parent not in seen:
                    seen.add(parent)
                    nxt.append(parent)
        frontier = nxt
    return tuple(sorted(found))


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    names = frozenset(paths.name(rel) for rel in files.select(openapi.is_candidate))
    if not names:
        return found
    found.applied.add(NAME)
    needles = tuple(sorted(names))
    refs: list[ServedRef] = []
    for rel, text in codebase.sources(files, ctx, codebase.PYTHON, None, needles):
        if not clike.in_test_dir(rel):
            refs += _python(rel, text, names)
    for lang, kind in _MASKS.items():
        for rel, text in codebase.sources(files, ctx, lang, None, needles):
            if clike.in_test_dir(rel):
                continue
            code = codetext.load(files, rel, text, kind)
            if code is not None:
                refs += _masked(code, rel, names)
    if any(r.loc.path.endswith(".go") for r in refs):
        index = _importers(files, ctx)
        for ref in refs:
            if ref.loc.path.endswith(".go"):
                ref.importers = _reach(paths.parent(ref.loc.path), index)
    found.served = refs
    return found
