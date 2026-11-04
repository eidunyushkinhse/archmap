"""supervisor (ТЗ §6.1): секции [program:имя] в *.conf, *.conf.template*, *.ini, включая
шаблоны erb и jinja. Разбор построчный: шаблонные вставки не исполняются, а программа с
именем из шаблона уходит в подсказки (имя известно только при развёртывании)."""

from __future__ import annotations

from archmap_scan import paths, texts, vocab
from archmap_scan.context import Context
from archmap_scan.model import Findings, Hint, Loc, Unit
from archmap_scan.walk import Files

NAME = "supervisor"
_TEMPLATE_MARKS = ("<%", "{{", "{%", "${", "%(")


def is_candidate(rel: str) -> bool:
    low = paths.name(rel).lower()
    return low.endswith((".conf", ".ini")) or ".conf.template" in low


def is_template(text: str) -> bool:
    return any(mark in text for mark in _TEMPLATE_MARKS)


def parse_text(rel: str, text: str, found: Findings) -> None:
    current: Unit | None = None
    last_key = ""
    for no, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith((";", "#")):
            continue
        if line.startswith("[") and "]" in line:
            current, last_key = None, ""
            header = line[1:line.index("]")].strip()
            if not header.startswith("program:"):
                continue
            name = header[len("program:"):].strip()
            if not name:
                continue
            if is_template(name):
                found.hints.append(Hint("dynamic_names", {
                    "kind": "container", "name": name, "reason": texts.REASON_TEMPLATE_NAME,
                    "source": str(Loc(rel, no)),
                }))
                continue
            current = Unit(name=name, parser=NAME, loc=Loc(rel, no))
            found.units.append(current)
            continue
        if current is None:
            continue
        if raw[:1] in (" ", "\t") and last_key == "command" and current.command:
            current.command = f"{current.command} {line}"
            continue
        key, eq, value = line.partition("=")
        if not eq:
            continue
        last_key = key.strip().lower()
        if last_key == "command":
            current.command = " ".join(value.split())
            current.command_loc = Loc(rel, no)
            current.role = vocab.role_by_command(current.command)
        elif last_key == "numprocs" and value.strip().isdigit():
            current.replicas = int(value.strip())


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    for rel in files.select(is_candidate):
        text = files.read(rel)
        if text is None or "[program:" not in text:
            continue
        parse_text(rel, text, found)
    return found
