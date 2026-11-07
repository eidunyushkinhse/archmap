"""Манифесты сборки (ТЗ §6.1): имя пакета, зависимости (имена без версий), язык.

package.json, pyproject.toml, requirements*.txt, Pipfile, go.mod, Cargo.toml, pom.xml,
build.gradle*, Gemfile, composer.json, mix.exs, *.csproj и *.sln (.NET). Из них — технология контейнера (язык и
фреймворк по словарю), опознание стеков для статусов «не умею», клиентские библиотеки как
подсказка вида зависимости и рабочие области монорепо (workspaces).
"""

from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET  # noqa: N817
from typing import Any

from archmap_scan import paths, texts, tomlite, vocab
from archmap_scan.context import Context
from archmap_scan.model import Findings, Loc, Package, unparsed_hint
from archmap_scan.walk import Files

# Предел манифеста сборки: чистый Python-разборщик TOML тратит на 2 МБ четверть секунды, а
# настоящие манифесты в сотни раз меньше.
MAX_MANIFEST_CHARS = 512 * 1024

NAME = "manifests"
_REQ_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
# Пометка pip-compile в комментарии после пакета: «via пакет», «via -r requirements.in» или
# «via» с перечнем в следующих строках комментария.
_VIA = re.compile(r"via\b(.*)")
_GEM = re.compile(r"""^\s*gem\s+["']([^"']+)["']""")
_MIX_APP = re.compile(r"app:\s*:([A-Za-z0-9_]+)")
_MIX_DEP = re.compile(r"\{:([A-Za-z0-9_]+)\s*,")
_GRADLE_COORD = re.compile(r"""["']([\w.-]+):([\w.-]+)(?::[^"'\s]*)?["']""")
_GRADLE_SPRING = re.compile(r"org\.springframework\.boot")
# Плагин Kotlin в сборке Gradle: kotlin("jvm") в Kotlin DSL или org.jetbrains.kotlin (ТЗ §15
# п. 12 С5: fraud-detection OpenTelemetry Demo на Kotlin получал Java).
_GRADLE_KOTLIN = re.compile(r"\bkotlin\(\s*[\"']jvm[\"']\s*\)|org\.jetbrains\.kotlin")
_PACKAGE_REF = re.compile(r"<PackageReference[ \t\r\n]+Include=\"([^\"\n]{1,200})\"")
_WEB_SDK = re.compile(r"Sdk=\"Microsoft\.NET\.Sdk\.Web\"")


def _in_requirements_dir(rel: str) -> bool:
    """requirements/prod.txt и подобные: каталог зависимостей пакета, а не свой пакет."""
    return rel.endswith(".txt") and paths.name(paths.parent(rel)) == "requirements"


def kind_of(rel: str) -> str | None:
    """Вид манифеста по имени файла (ключ словаря vocab.MANIFEST_LANGUAGE)."""
    name = paths.name(rel)
    if name in vocab.MANIFEST_LANGUAGE:
        return name
    if (name.startswith("requirements") and name.endswith(".txt")) or _in_requirements_dir(rel):
        return "requirements.txt"
    if name in ("build.gradle.kts",):
        return "build.gradle"
    low = name.lower()
    if low.endswith(".csproj") and len(low) > len(".csproj"):
        return "csproj"
    if low.endswith(".sln") and len(low) > len(".sln"):
        return "sln"
    return None


def _norm(name: str) -> str:
    return name.strip().lower().replace("_", "-")


def _req_name(spec: str) -> str | None:
    m = _REQ_NAME.match(spec.strip())
    return _norm(m.group(0)) if m else None


def _line_of(text: str, needle: str) -> int | None:
    idx = text.find(needle)
    return text.count("\n", 0, idx) + 1 if idx >= 0 else None


def _package_json(rel: str, text: str) -> Package:
    data = json.loads(text)
    pkg = Package(path=rel, dir=paths.parent(rel), kind="package.json", language="Node.js")
    if not isinstance(data, dict):
        return pkg
    name = data.get("name")
    if isinstance(name, str) and name.strip():
        pkg.name = name.strip()
        line = _line_of(text, '"name"')
        pkg.name_loc = Loc(rel, line) if line else None
    deps: list[str] = []
    for key in ("dependencies", "peerDependencies"):
        block = data.get(key)
        if isinstance(block, dict):
            deps += [str(d).lower() for d in block]
    pkg.deps = tuple(dict.fromkeys(deps))
    work = data.get("workspaces")
    if isinstance(work, dict):
        work = work.get("packages")
    if isinstance(work, list):
        pkg.workspaces = tuple(str(w) for w in work if isinstance(w, str))
    return pkg


def _pyproject(rel: str, text: str) -> Package:
    doc = tomlite.parse(text)
    pkg = Package(path=rel, dir=paths.parent(rel), kind="pyproject.toml", language="Python")
    for table in ("project", "tool.poetry"):
        name = doc.get(table, "name")
        if isinstance(name, str) and name.strip():
            pkg.name = name.strip()
            line = doc.line(table, "name")
            pkg.name_loc = Loc(rel, line) if line else None
            break
    deps: list[str] = []
    listed = doc.get("project", "dependencies")
    if isinstance(listed, list):
        deps += [n for n in (_req_name(str(d)) for d in listed) if n]
    # Группы зависимостей PEP 735 и необязательные зависимости: фреймворк бывает только
    # там (Zulip держит Django в [dependency-groups] prod).
    for table in ("dependency-groups", "project.optional-dependencies"):
        for group in doc.keys(table):
            items = doc.get(table, group)
            if isinstance(items, list):
                deps += [n for n in (_req_name(d) for d in items if isinstance(d, str)) if n]
    deps += [_norm(k) for k in doc.keys("tool.poetry.dependencies") if _norm(k) != "python"]
    pkg.deps = tuple(dict.fromkeys(deps))
    return pkg


def _requirements(rel: str, text: str) -> Package:
    """Зависимости requirements*.txt. Файл pip-compile (uv pip compile) после строки пакета
    пишет «# via …»: пакет, который тянет другой пакет, транзитивный и фреймворк не задаёт
    (Locust тянет Flask, ТЗ §15 п. 10 А7). Прямой пакет помечен «# via -r файл» или «-c
    файл», а строка без пометки — прямая, как в обычном requirements.txt."""
    deps: list[str] = []
    via: dict[str, list[str]] = {}
    current: str | None = None
    block = False
    for raw in text.splitlines():
        code, mark, comment = raw.partition("#")
        line = code.strip()
        if line:
            current, block = None, False
            if not line.startswith("-") and "://" not in line:
                current = _req_name(line)
                if current:
                    deps.append(current)
        if not mark or current is None:
            continue
        m = _VIA.match(comment.strip())
        if m is not None:
            rest = m.group(1).strip()
            if rest:
                via.setdefault(current, []).append(rest)
            block = not rest
        elif block and not line and comment.strip():
            via.setdefault(current, []).append(comment.strip())
    transitive = {
        name for name, items in via.items()
        if not any(item.startswith(("-r", "-c")) for item in items)
    }
    deps = [d for d in deps if d not in transitive]
    # requirements/prod.txt — манифест пакета каталогом выше (ТЗ §6.1, находка на Zulip).
    folder = paths.parent(rel)
    if _in_requirements_dir(rel):
        folder = paths.parent(folder)
    return Package(path=rel, dir=folder, kind="requirements.txt",
                   language="Python", deps=tuple(dict.fromkeys(deps)))


def _pipfile(rel: str, text: str) -> Package:
    doc = tomlite.parse(text)
    deps = [_norm(k) for k in doc.keys("packages")]
    return Package(path=rel, dir=paths.parent(rel), kind="Pipfile", language="Python",
                   deps=tuple(dict.fromkeys(deps)))


def _go_mod(rel: str, text: str) -> Package:
    pkg = Package(path=rel, dir=paths.parent(rel), kind="go.mod", language="Go")
    deps: list[str] = []
    block = False
    for no, raw in enumerate(text.splitlines(), start=1):
        line = raw.split("//", 1)[0].strip()
        if line.startswith("module ") and pkg.name is None:
            pkg.name = line[len("module "):].strip().strip('"')
            pkg.name_loc = Loc(rel, no)
        elif line.startswith("require ("):
            block = True
        elif block and line == ")":
            block = False
        elif "// indirect" in raw:
            # Транзитивная зависимость: стек по ней не опознаётся (ТЗ §15 п. 10 А12, viper
            # у Argo CD только в hack/tools/go.mod с пометкой indirect).
            continue
        elif block and line:
            deps.append(line.split()[0].lower())
        elif line.startswith("require "):
            parts = line.split()
            if len(parts) >= 2:
                deps.append(parts[1].lower())
    pkg.deps = tuple(dict.fromkeys(deps))
    return pkg


def _cargo(rel: str, text: str) -> Package:
    doc = tomlite.parse(text)
    pkg = Package(path=rel, dir=paths.parent(rel), kind="Cargo.toml", language="Rust")
    name = doc.get("package", "name")
    if isinstance(name, str):
        pkg.name = name
        line = doc.line("package", "name")
        pkg.name_loc = Loc(rel, line) if line else None
    pkg.deps = tuple(dict.fromkeys(_norm(k) for k in doc.keys("dependencies")))
    return pkg


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _pom(rel: str, text: str) -> Package:
    pkg = Package(path=rel, dir=paths.parent(rel), kind="pom.xml", language="Java")
    # Сущности XML («billion laughs») не разбираем вовсе: в pom.xml их не бывает.
    if "<!ENTITY" in text or "<!DOCTYPE" in text:
        raise ValueError("pom.xml с объявлениями DOCTYPE не разбирается")
    root = ET.fromstring(text)
    deps: list[str] = []
    for child in root:
        tag = _local(child.tag)
        if tag == "artifactId" and child.text:
            pkg.name = child.text.strip()
        elif tag == "parent":
            for sub in child:
                if _local(sub.tag) == "artifactId" and sub.text:
                    deps.append(sub.text.strip().lower())
    for el in root.iter():
        if _local(el.tag) in ("dependency", "plugin"):
            for sub in el:
                if _local(sub.tag) == "artifactId" and sub.text:
                    deps.append(sub.text.strip().lower())
    if pkg.name:
        start = text.find("</parent>")
        idx = text.find("<artifactId>", start if start >= 0 else 0)
        pkg.name_loc = Loc(rel, text.count("\n", 0, idx) + 1) if idx >= 0 else None
    pkg.deps = tuple(dict.fromkeys(deps))
    return pkg


def _gradle(rel: str, text: str) -> Package:
    deps = [m.group(2).lower() for m in _GRADLE_COORD.finditer(text)]
    if _GRADLE_SPRING.search(text):
        deps.append("spring-boot")
    language = "Kotlin" if _GRADLE_KOTLIN.search(text) else "Java"
    return Package(path=rel, dir=paths.parent(rel), kind="build.gradle", language=language,
                   deps=tuple(dict.fromkeys(deps)))


def _gemfile(rel: str, text: str) -> Package:
    deps = [m.group(1).lower() for line in text.splitlines() if (m := _GEM.match(line))]
    return Package(path=rel, dir=paths.parent(rel), kind="Gemfile", language="Ruby",
                   deps=tuple(dict.fromkeys(deps)))


def _composer(rel: str, text: str) -> Package:
    data = json.loads(text)
    pkg = Package(path=rel, dir=paths.parent(rel), kind="composer.json", language="PHP")
    if not isinstance(data, dict):
        return pkg
    name = data.get("name")
    if isinstance(name, str):
        pkg.name = name
        line = _line_of(text, '"name"')
        pkg.name_loc = Loc(rel, line) if line else None
    req = data.get("require")
    if isinstance(req, dict):
        pkg.deps = tuple(
            str(k).lower() for k in req if k != "php" and not str(k).startswith("ext-")
        )
    return pkg


def _mix(rel: str, text: str) -> Package:
    pkg = Package(path=rel, dir=paths.parent(rel), kind="mix.exs", language="Elixir")
    m = _MIX_APP.search(text)
    if m:
        pkg.name = m.group(1)
        pkg.name_loc = Loc(rel, text.count("\n", 0, m.start()) + 1)
    pkg.deps = tuple(dict.fromkeys(m.group(1).lower() for m in _MIX_DEP.finditer(text)))
    return pkg


def _csproj(rel: str, text: str) -> Package:
    """Проект .NET: имена PackageReference и признак веб-проекта (Sdk Microsoft.NET.Sdk.Web)."""
    deps = [m.group(1).lower() for m in _PACKAGE_REF.finditer(text)]
    if _WEB_SDK.search(text) is not None:
        deps.insert(0, "microsoft.net.sdk.web")
    return Package(path=rel, dir=paths.parent(rel), kind="csproj", language=".NET",
                   deps=tuple(dict.fromkeys(deps)))


def _sln(rel: str, text: str) -> Package:
    """Решение .NET: только признак языка, зависимости — в проектах."""
    return Package(path=rel, dir=paths.parent(rel), kind="sln", language=".NET", deps=())


_READERS: dict[str, Any] = {
    "package.json": _package_json,
    "pyproject.toml": _pyproject,
    "requirements.txt": _requirements,
    "Pipfile": _pipfile,
    "go.mod": _go_mod,
    "Cargo.toml": _cargo,
    "pom.xml": _pom,
    "build.gradle": _gradle,
    "Gemfile": _gemfile,
    "composer.json": _composer,
    "mix.exs": _mix,
    "csproj": _csproj,
    "sln": _sln,
}


# Файлы, по которым опознаётся стек без разборщика в этой версии (ТЗ §6.2, §6.4).
def _markers(files: Files, found: Findings) -> None:
    for rel in files.paths:
        name = paths.name(rel)
        stack: tuple[str, str] | None = None
        if name == "schema.prisma":
            stack = ("tables", "Prisma")
        elif rel.endswith("db/schema.rb") or rel == "schema.rb":
            stack = ("tables", "Rails schema.rb")
        if stack is not None:
            fam, label = stack
            items = found.unsupported.setdefault(fam, [])
            if label not in items:
                items.append(label)


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    _markers(files, found)
    for rel in files.select(lambda p: kind_of(p) is not None):
        kind = kind_of(rel)
        text = files.read(rel)
        if text is None or kind is None:
            continue
        if len(text) > MAX_MANIFEST_CHARS:
            found.hints.append(unparsed_hint(rel, texts.REASON_MANIFEST_TOO_LARGE))
            continue
        try:
            pkg = _READERS[kind](rel, text)
        except (ValueError, RecursionError, ET.ParseError):
            found.hints.append(unparsed_hint(rel, texts.REASON_BAD_MANIFEST))
            continue
        found.packages.append(pkg)
    return found
