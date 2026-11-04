"""systemd (ТЗ §6.1): юнит *.service — контейнер, команда из ExecStart. Имя юнита — имя
файла без «.service» (у шаблона «name@.service» без «@»). Description не пишется:
описаний сборщик не выдумывает и не переносит."""

from __future__ import annotations

from archmap_scan import paths, vocab
from archmap_scan.context import Context
from archmap_scan.model import Findings, Loc, Unit
from archmap_scan.walk import Files

NAME = "systemd"


def parse_text(rel: str, text: str) -> Unit | None:
    section = ""
    has_unit = False
    unit = Unit(name=paths.name(rel)[: -len(".service")].rstrip("@"), parser=NAME,
                loc=Loc(rel, 1))
    for no, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith((";", "#")):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1].strip().lower()
            has_unit = has_unit or section in ("unit", "service")
            if section == "service":
                unit.loc = Loc(rel, no)
            continue
        key, eq, value = line.partition("=")
        if section == "service" and eq and key.strip() == "ExecStart" and unit.command is None:
            unit.command = " ".join(value.strip().lstrip("-@+!:").split())
            unit.command_loc = Loc(rel, no)
            unit.role = vocab.role_by_command(unit.command)
    if not has_unit or not unit.name:
        return None
    return unit


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    for rel in files.select(lambda p: p.endswith(".service")):
        text = files.read(rel)
        if text is None:
            continue
        unit = parse_text(rel, text)
        if unit is not None:
            found.units.append(unit)
    return found
