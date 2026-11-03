"""Dockerfile* (ТЗ §6.1): базовые образы стадий (язык), каталог файла (код контейнера),
CMD и ENTRYPOINT (команда для точек входа).

Строки с переносом «\\» склеиваются, комментарии пропускаются. FROM со ссылкой на прежнюю
стадию («FROM build AS final») берёт образ той стадии. Аргументы ${VAR} не подставляются:
по имени образа до подстановки язык виден и так (python:${PY} → python).
"""

from __future__ import annotations

import json

from archmap_scan import paths
from archmap_scan.context import Context
from archmap_scan.model import Dockerfile, Findings, Loc
from archmap_scan.walk import Files

NAME = "dockerfile"


def is_dockerfile(rel: str) -> bool:
    low = paths.name(rel).lower()
    return (
        low == "dockerfile"
        or low.startswith(("dockerfile.", "dockerfile-"))
        or low.endswith((".dockerfile", "-dockerfile"))
    )


def _logical_lines(text: str) -> list[tuple[int, str]]:
    """(номер первой строки, инструкция) со склейкой переносов «\\»."""
    out: list[tuple[int, str]] = []
    buf: list[str] = []
    start = 0
    for no, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not buf and (not line or line.startswith("#")):
            continue
        if buf and line.startswith("#"):
            continue
        if not buf:
            start = no
        if line.endswith("\\"):
            buf.append(line[:-1].strip())
            continue
        buf.append(line)
        out.append((start, " ".join(p for p in buf if p)))
        buf = []
    if buf:
        out.append((start, " ".join(p for p in buf if p)))
    return out


def _exec_form(value: str) -> str:
    """CMD ["a", "b"] → «a b»; оболочечная форма как есть."""
    value = value.strip()
    if value.startswith("["):
        try:
            items = json.loads(value)
        except ValueError:
            return value
        if isinstance(items, list):
            return " ".join(str(i) for i in items)
    return value


def parse_text(rel: str, text: str) -> Dockerfile | None:
    images: list[str] = []
    stages: dict[str, str] = {}
    from_line = 0
    cmd: tuple[int, str] | None = None
    entry: tuple[int, str] | None = None
    for no, line in _logical_lines(text):
        word, _, rest = line.partition(" ")
        op = word.upper()
        if op == "FROM":
            args = [a for a in rest.split() if not a.startswith("--")]
            if not args:
                continue
            image = stages.get(args[0].lower(), args[0])
            images.append(image)
            if len(args) >= 3 and args[1].upper() == "AS":
                stages[args[2].lower()] = image
            if not from_line:
                from_line = no
        elif op == "CMD":
            cmd = (no, _exec_form(rest))
        elif op == "ENTRYPOINT":
            entry = (no, _exec_form(rest))
    if not images:
        return None
    command: str | None = None
    command_line = 0
    picked = entry or cmd
    if entry is not None and cmd is not None:
        command, command_line = f"{entry[1]} {cmd[1]}", entry[0]
    elif picked is not None:
        command_line, command = picked
    return Dockerfile(
        path=rel,
        dir=paths.parent(rel),
        images=images,
        from_loc=Loc(rel, from_line),
        command=command,
        command_loc=Loc(rel, command_line) if command else None,
    )


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    for rel in files.select(is_dockerfile):
        text = files.read(rel)
        if text is None:
            continue
        info = parse_text(rel, text)
        if info is not None:
            found.dockerfiles.append(info)
    return found
