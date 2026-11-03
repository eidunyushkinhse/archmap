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
from archmap_scan.parsers import (
    alembic,
    celery,
    compose,
    django,
    djangourls,
    dockerfile,
    envexample,
    express,
    fastapi,
    flask,
    goenv,
    gohttp,
    helm,
    k8s,
    kafka,
    manifests,
    nats,
    nest,
    nodeenv,
    openapi,
    procfile,
    pyenv,
    rabbitmq,
    sql,
    supervisor,
    systemd,
)
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
    # Разборщик яруса кода (ТЗ §6.2): считается работавшим, только если его стек есть в
    # репозитории (он отмечает себя в Findings.applied). Так «искали и не нашли»
    # отличается от «стек не опознан».
    code: bool = False


_MANIFEST_FAMILIES = ("containers", "databases", "brokers", "edges")
_PROCESS_FAMILIES = ("containers", "workers")
_CHANNEL_FAMILIES = ("channels", "edges")

PARSERS: tuple[ParserSpec, ...] = (
    ParserSpec(compose.NAME, (*_MANIFEST_FAMILIES, "config", "workers"), compose.parse),
    ParserSpec(dockerfile.NAME, ("containers",), dockerfile.parse),
    ParserSpec(procfile.NAME, _PROCESS_FAMILIES, procfile.parse),
    ParserSpec(supervisor.NAME, _PROCESS_FAMILIES, supervisor.parse),
    ParserSpec(systemd.NAME, _PROCESS_FAMILIES, systemd.parse),
    ParserSpec(k8s.NAME, (*_MANIFEST_FAMILIES, "config", "workers", "schedules"), k8s.parse),
    ParserSpec(helm.NAME, ("containers", "databases", "brokers"), helm.parse),
    ParserSpec(manifests.NAME, ("containers",), manifests.parse),
    ParserSpec(envexample.NAME, ("edges", "config"), envexample.parse),
    ParserSpec(sql.NAME, ("tables",), sql.parse),
    ParserSpec(alembic.NAME, ("tables",), alembic.parse),
    ParserSpec(django.NAME, ("tables",), django.parse),
    ParserSpec(openapi.NAME, (), openapi.parse),
    ParserSpec(fastapi.NAME, ("http_routes",), fastapi.parse, code=True),
    ParserSpec(flask.NAME, ("http_routes",), flask.parse, code=True),
    ParserSpec(djangourls.NAME, ("http_routes",), djangourls.parse, code=True),
    ParserSpec(express.NAME, ("http_routes",), express.parse, code=True),
    ParserSpec(nest.NAME, ("http_routes",), nest.parse, code=True),
    ParserSpec(gohttp.NAME, ("http_routes",), gohttp.parse, code=True),
    ParserSpec(pyenv.NAME, ("config",), pyenv.parse, code=True),
    ParserSpec(nodeenv.NAME, ("config",), nodeenv.parse, code=True),
    ParserSpec(goenv.NAME, ("config",), goenv.parse, code=True),
    ParserSpec(celery.NAME, _CHANNEL_FAMILIES, celery.parse, code=True),
    ParserSpec(kafka.NAME, _CHANNEL_FAMILIES, kafka.parse, code=True),
    ParserSpec(rabbitmq.NAME, _CHANNEL_FAMILIES, rabbitmq.parse, code=True),
    ParserSpec(nats.NAME, _CHANNEL_FAMILIES, nats.parse, code=True),
)


def parsers_for(family: str) -> list[str]:
    """Имена разборщиков семьи в порядке реестра."""
    return [p.name for p in PARSERS if family in p.families]


def ran(family: str, findings: Findings, errors: dict[str, str]) -> list[str]:
    """Разборщики семьи, которые отработали: без ошибки, а у яруса кода — со своим стеком."""
    return [
        p.name for p in PARSERS
        if family in p.families and p.name not in errors
        and (not p.code or p.name in findings.applied)
    ]


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
