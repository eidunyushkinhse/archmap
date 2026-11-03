"""Реестр разборщиков по семьям фактов (ТЗ §6): один на сборщик, по нему считается покрытие.

Разборщик — модуль archmap_scan/parsers/<имя>.py с функцией parse(files, ctx) -> Findings,
без состояния. Падение разборщика не валит запуск: его семьи получают статус error, а
остальное пишется (ТЗ §3).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from archmap_scan.context import Context
from archmap_scan.model import Findings
from archmap_scan.walk import Files

# Семьи покрытия в порядке отчёта (ТЗ §8).
FAMILIES: tuple[str, ...] = (
    "containers", "databases", "brokers", "edges", "tables", "config", "channels",
    "http_routes", "workers", "schedules",
)


@dataclass(frozen=True)
class ParserSpec:
    name: str
    families: tuple[str, ...]
    parse: Callable[[Files, Context], Findings]


PARSERS: tuple[ParserSpec, ...] = ()


def parsers_for(family: str) -> list[str]:
    """Имена разборщиков семьи в порядке реестра."""
    return [p.name for p in PARSERS if family in p.families]


def collect(files: Files, ctx: Context) -> tuple[Findings, dict[str, str]]:
    """Запустить все разборщики. Второе — упавшие: имя разборщика → текст ошибки."""
    found = Findings()
    errors: dict[str, str] = {}
    for spec in PARSERS:
        try:
            part = spec.parse(files, ctx)
        except Exception as exc:  # падение одного не валит запуск (ТЗ §3)
            errors[spec.name] = type(exc).__name__
            continue
        found.extend(part)
    return found, errors
