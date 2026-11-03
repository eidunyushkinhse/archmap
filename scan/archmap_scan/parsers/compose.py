"""docker-compose*.y*ml и compose*.y*ml (ТЗ §6.1).

Сервис compose — кандидат в объект: имя, образ, каталог сборки, команда, переменные
окружения (имена; значения только ради адресов зависимостей), depends_on. Сервисы под
profiles и сервисы, которые есть только в файлах для разработки (dev, local), в схему не
идут, а перечисляются в подсказках. extends, include и подстановки ${VAR} не раскрываются.
Один сервис в нескольких файлах (основной и override) — один кандидат: поля поздних файлов
перекрывают ранние, как у самого compose.
"""

from __future__ import annotations

import re
from typing import Any

from archmap_scan import paths, texts
from archmap_scan.context import Context
from archmap_scan.model import EnvVar, Findings, Hint, Loc, Unit
from archmap_scan.walk import Files, is_compose_name, name_tokens
from archmap_scan.yamlload import BadYaml, LineDict, LineList, YamlTooLarge, load

NAME = "compose"
_DEV_TOKENS = frozenset({"dev", "local", "development"})
# Подстановка переменной compose: ${VAR}, ${VAR:-x}, $VAR (но не экранированное $$).
_DYNAMIC = re.compile(r"\$\{|\$[A-Za-z_]")


def _is_base(name: str) -> bool:
    """Основной файл проекта compose (а не override, prod, dev)."""
    return name.lower() in {
        "compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml",
    }


def _order(rel: str) -> tuple[str, int, str]:
    return (paths.parent(rel), 0 if _is_base(paths.name(rel)) else 1, rel)


def is_dynamic(value: str) -> bool:
    return _DYNAMIC.search(value.replace("$$", "")) is not None


def _env(svc: LineDict, rel: str, out: list[EnvVar]) -> None:
    env = svc.get("environment")
    if isinstance(env, LineDict):
        for key, value in env.items():
            loc = Loc(rel, env.line_of(key))
            text = None if value is None else _scalar(value)
            out.append(EnvVar(str(key), loc, text, text is not None and is_dynamic(text)))
    elif isinstance(env, LineList):
        for i, item in enumerate(env):
            if not isinstance(item, str) or not item.strip():
                continue
            key, eq, value = item.partition("=")
            loc = Loc(rel, env.line_at(i))
            text = value if eq else None
            out.append(EnvVar(key.strip(), loc, text, text is not None and is_dynamic(text)))


def _scalar(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _command(svc: LineDict) -> tuple[str | None, int | None]:
    for key in ("command", "entrypoint"):
        value = svc.get(key)
        if isinstance(value, str) and value.strip():
            return " ".join(value.split()), svc.line_of(key)
        if isinstance(value, list) and value:
            return " ".join(_scalar(v) for v in value), svc.line_of(key)
    return None, None


def _depends(svc: LineDict, rel: str) -> list[tuple[str, Loc]]:
    dep = svc.get("depends_on")
    out: list[tuple[str, Loc]] = []
    if isinstance(dep, LineList):
        out = [(str(d), Loc(rel, dep.line_at(i))) for i, d in enumerate(dep) if d]
    elif isinstance(dep, LineDict):
        out = [(str(d), Loc(rel, dep.line_of(d))) for d in dep]
    return out


def _build(svc: LineDict, rel: str, name: str, found: Findings) -> tuple[str | None, str | None]:
    build = svc.get("build")
    if build is None:
        return None, None
    context: Any = "."
    dockerfile: Any = "Dockerfile"
    if isinstance(build, str):
        context = build
    elif isinstance(build, LineDict):
        context = build.get("context", ".")
        dockerfile = build.get("dockerfile", "Dockerfile")
    if not isinstance(context, str) or "://" in context or context.startswith("git@"):
        return None, None
    folder = paths.join(paths.parent(rel), context)
    if folder is None:
        found.hints.append(Hint("unassigned", {
            "kind": "container", "name": name, "reason": texts.REASON_BUILD_OUTSIDE,
            "source": str(Loc(rel, svc.line_of("build"))),
        }))
        return None, None
    docker = paths.join(folder, dockerfile) if isinstance(dockerfile, str) else None
    return folder, docker


def _services(doc: LineDict) -> LineDict | None:
    services = doc.get("services")
    if isinstance(services, LineDict):
        return services
    # Формат compose первой версии: сервисы прямо в корне документа.
    if "services" not in doc and "version" not in doc and doc and all(
        isinstance(v, LineDict) and ("image" in v or "build" in v) for v in doc.values()
    ):
        return doc
    return None


def _unit(name: str, svc: LineDict, rel: str, line: int, found: Findings) -> Unit:
    image = svc.get("image")
    folder, docker = _build(svc, rel, name, found)
    command, cmd_line = _command(svc)
    unit = Unit(
        name=name,
        parser=NAME,
        loc=Loc(rel, line),
        image=image if isinstance(image, str) else None,
        build_dir=folder,
        dockerfile=docker,
        command=command,
        command_loc=Loc(rel, cmd_line) if cmd_line else None,
        host=name,
    )
    _env(svc, rel, unit.env)
    unit.depends_on = _depends(svc, rel)
    for key, reason in (("extends", texts.REASON_EXTENDS), ("env_file", texts.REASON_ENV_FILE)):
        if key in svc:
            found.hints.append(Hint("unassigned", {
                "kind": "container", "name": name, "reason": reason,
                "source": str(Loc(rel, svc.line_of(key))),
            }))
    return unit


def _merge(into: Unit, other: Unit) -> None:
    """Поздний файл перекрывает поля раннего, переменные и зависимости складываются."""
    into.image = other.image or into.image
    if other.build_dir is not None:
        into.build_dir, into.dockerfile = other.build_dir, other.dockerfile
    if other.command:
        into.command, into.command_loc = other.command, other.command_loc
    names = {e.name for e in other.env}
    into.env = [e for e in into.env if e.name not in names] + other.env
    seen = {d for d, _ in into.depends_on}
    into.depends_on += [(d, loc) for d, loc in other.depends_on if d not in seen]
    into.extra_locs.append(other.loc)


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    units: dict[str, Unit] = {}
    dev_only: dict[str, Loc] = {}
    # Файлы для разработки (dev, local) читаются после остальных и в схему не добавляют
    # ничего: их сервисы, которых нет в основных файлах, уходят в подсказки.
    ordered = sorted(files.select(lambda p: is_compose_name(paths.name(p))), key=_order)
    dev_files = [r for r in ordered if name_tokens(paths.name(r)) & _DEV_TOKENS]
    for rel in [r for r in ordered if r not in dev_files] + dev_files:
        services = _load_services(files, rel, found)
        if services is None:
            continue
        dev = rel in dev_files
        for key, svc in services.items():
            if not isinstance(svc, LineDict):
                continue
            name = str(key)
            line = services.line_of(key)
            profiles = svc.get("profiles")
            if isinstance(profiles, list) and profiles:
                found.hints.append(Hint("profiles", {
                    "service": name, "profiles": sorted(str(p) for p in profiles),
                    "reason": texts.REASON_PROFILE, "source": str(Loc(rel, line)),
                }))
                continue
            if dev:
                if name not in units:
                    dev_only.setdefault(name, Loc(rel, line))
                continue
            unit = _unit(name, svc, rel, line, found)
            if name in units:
                _merge(units[name], unit)
            else:
                units[name] = unit
    for name, loc in dev_only.items():
        found.hints.append(Hint("profiles", {
            "service": name, "profiles": [], "reason": texts.REASON_DEV_FILE,
            "source": str(loc),
        }))
    found.units.extend(units.values())
    for unit in found.units:
        for var in unit.env:
            if var.dynamic:
                found.hints.append(Hint("dynamic_names", {
                    "object": unit.name, "name": var.name,
                    "reason": texts.REASON_DYNAMIC_VALUE, "source": str(var.loc),
                }))
    return found


def _load_services(files: Files, rel: str, found: Findings) -> LineDict | None:
    text = files.read(rel)
    if text is None:
        return None
    try:
        doc = load(text)
    except YamlTooLarge:
        files.refuse(rel)
        return None
    except BadYaml:
        found.hints.append(Hint("unparsed", {"path": rel, "reason": texts.REASON_BAD_YAML}))
        return None
    if not isinstance(doc, LineDict):
        return None
    if "include" in doc:
        found.hints.append(Hint("unassigned", {
            "kind": "compose", "name": paths.name(rel), "reason": texts.REASON_INCLUDE,
            "source": str(Loc(rel, doc.line_of("include"))),
        }))
    return _services(doc)
