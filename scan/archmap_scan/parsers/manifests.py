"""Манифесты сборки (ТЗ §6.1): имя пакета, зависимости (имена без версий), язык.

package.json, pyproject.toml, requirements*.txt, Pipfile, go.mod, Cargo.toml, pom.xml,
build.gradle*, Gemfile, composer.json, mix.exs. Из них — технология контейнера (язык и
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
from archmap_scan.model import Findings, Hint, Loc, Package
from archmap_scan.walk import Files

NAME = "manifests"
_REQ_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
_GEM = re.compile(r"""^\s*gem\s+["']([^"']+)["']""")
_MIX_APP = re.compile(r"app:\s*:([A-Za-z0-9_]+)")
_MIX_DEP = re.compile(r"\{:([A-Za-z0-9_]+)\s*,")
_GRADLE_COORD = re.compile(r"""["']([\w.-]+):([\w.-]+)(?::[^"'\s]*)?["']""")
_GRADLE_SPRING = re.compile(r"org\.springframework\.boot")


def kind_of(rel: str) -> str | None:
    """Вид манифеста по имени файла (ключ словаря vocab.MANIFEST_LANGUAGE)."""
    name = paths.name(rel)
    if name in vocab.MANIFEST_LANGUAGE:
        return name
    if name.startswith("requirements") and name.endswith(".txt"):
        return "requirements.txt"
    if name in ("build.gradle.kts",):
        return "build.gradle"
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
    deps += [_norm(k) for k in doc.keys("tool.poetry.dependencies") if _norm(k) != "python"]
    pkg.deps = tuple(dict.fromkeys(deps))
    return pkg


def _requirements(rel: str, text: str) -> Package:
    deps: list[str] = []
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or line.startswith("-") or "://" in line:
            continue
        name = _req_name(line)
        if name:
            deps.append(name)
    return Package(path=rel, dir=paths.parent(rel), kind="requirements.txt",
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
    return Package(path=rel, dir=paths.parent(rel), kind="build.gradle", language="Java",
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
}


# Файлы, по которым опознаётся стек без разборщика в этой версии (ТЗ §6.2, §6.4).
def _markers(files: Files, found: Findings) -> None:
    for rel in files.paths:
        name = paths.name(rel)
        stack: tuple[str, str] | None = None
        if name == "crontab" or paths.name(paths.parent(rel)) == "cron.d":
            stack = ("schedules", "crontab")
        elif name == "schema.prisma":
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
        try:
            pkg = _READERS[kind](rel, text)
        except (ValueError, RecursionError, ET.ParseError):
            found.hints.append(Hint("unparsed", {"path": rel, "reason": texts.REASON_BAD_MANIFEST}))
            continue
        found.packages.append(pkg)
    return found
