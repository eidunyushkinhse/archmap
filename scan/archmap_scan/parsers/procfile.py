"""Procfile (ТЗ §6.1): строка «имя: команда» — контейнер. web — сервис, остальные —
воркер или планировщик по слову в команде. Каталог Procfile — каталог кода процессов.
Фаза выпуска release процессом не считается и уходит в подсказки. Procfile разработки
(признак по месту и форме или запуск менеджером процессов разработки из Makefile или
скрипта, walk.dev_procfile: goreman у Argo CD) даёт кандидатов с признаком разработки
(Unit.dev), их судьбу решает сборка по ступени политики (ТЗ §15 п. 10 Б1, Б2)."""

from __future__ import annotations

import re

from archmap_scan import paths, texts, vocab
from archmap_scan.context import Context
from archmap_scan.model import Findings, Hint, Loc, Unit
from archmap_scan.walk import Files, dev_procfile, dev_sign

NAME = "procfile"
_PROC = re.compile(r"[A-Za-z0-9_-]+")


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    for rel in files.select(lambda p: paths.name(p) == "Procfile"):
        text = files.read(rel)
        if text is None:
            continue
        sign = dev_sign(rel) or dev_procfile(files, rel)
        for no, raw in enumerate(text.splitlines(), start=1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            name, sep, command = line.partition(":")
            name = name.strip()
            command = " ".join(command.split())
            if not sep or not command or _PROC.fullmatch(name) is None:
                continue
            loc = Loc(rel, no)
            if name == "release":
                found.hints.append(Hint("unassigned", {
                    "kind": "container", "name": name, "reason": texts.REASON_RELEASE_PHASE,
                    "source": str(loc),
                }))
                continue
            if name == "web":
                role = vocab.ROLE_SERVICE
            else:
                role = vocab.role_by_command(command) or vocab.ROLE_WORKER
            found.units.append(Unit(
                name=name, parser=NAME, loc=loc, command=command, command_loc=loc,
                role=role, home_dir=paths.parent(rel), dev=sign,
            ))
    return found
