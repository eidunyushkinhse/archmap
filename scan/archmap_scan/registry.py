"""Реестр разборщиков по семьям фактов (ТЗ §6): один на сборщик, по нему считается покрытие.

Разборщик — модуль archmap_scan/parsers/<имя>.py с функцией parse(files, ctx) -> Findings,
без состояния. Падение разборщика не валит запуск: его семьи получают статус error, а
остальное пишется (ТЗ §3).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from archmap_scan import scripts
from archmap_scan.context import Context
from archmap_scan.model import Findings
from archmap_scan.parsers import (
    actix,
    alembic,
    aspnet,
    buildfiles,
    bullmq,
    celery,
    celerybeat,
    clokwerk,
    compose,
    crontab,
    django,
    djangourls,
    dockerfile,
    dotnetenv,
    envexample,
    express,
    fastapi,
    flask,
    gocron,
    goenv,
    gohttp,
    helm,
    javaenv,
    k8s,
    kafka,
    kysely,
    manifests,
    nats,
    nest,
    nodecron,
    nodeenv,
    openapi,
    procfile,
    pyenv,
    rabbitmq,
    rails_routes,
    railsschema,
    rustenv,
    served,
    sidekiq,
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
    ParserSpec(buildfiles.NAME, ("containers",), buildfiles.parse),
    ParserSpec(envexample.NAME, ("edges", "config"), envexample.parse),
    ParserSpec(sql.NAME, ("tables",), sql.parse),
    ParserSpec(alembic.NAME, ("tables",), alembic.parse),
    ParserSpec(django.NAME, ("tables",), django.parse),
    ParserSpec(railsschema.NAME, ("tables",), railsschema.parse),
    ParserSpec(kysely.NAME, ("tables",), kysely.parse, code=True),
    ParserSpec(openapi.NAME, (), openapi.parse),
    ParserSpec(served.NAME, (), served.parse, code=True),
    ParserSpec(fastapi.NAME, ("http_routes",), fastapi.parse, code=True),
    ParserSpec(flask.NAME, ("http_routes",), flask.parse, code=True),
    ParserSpec(djangourls.NAME, ("http_routes",), djangourls.parse, code=True),
    ParserSpec(express.NAME, ("http_routes",), express.parse, code=True),
    ParserSpec(nest.NAME, ("http_routes",), nest.parse, code=True),
    ParserSpec(gohttp.NAME, ("http_routes",), gohttp.parse, code=True),
    ParserSpec(rails_routes.NAME, ("http_routes",), rails_routes.parse, code=True),
    ParserSpec(aspnet.NAME, ("http_routes",), aspnet.parse, code=True),
    ParserSpec(actix.NAME, ("http_routes",), actix.parse, code=True),
    ParserSpec(pyenv.NAME, ("config",), pyenv.parse, code=True),
    ParserSpec(nodeenv.NAME, ("config",), nodeenv.parse, code=True),
    ParserSpec(goenv.NAME, ("config",), goenv.parse, code=True),
    ParserSpec(dotnetenv.NAME, ("config",), dotnetenv.parse, code=True),
    ParserSpec(javaenv.NAME, ("config",), javaenv.parse, code=True),
    ParserSpec(rustenv.NAME, ("config",), rustenv.parse, code=True),
    ParserSpec(celery.NAME, _CHANNEL_FAMILIES, celery.parse, code=True),
    ParserSpec(kafka.NAME, _CHANNEL_FAMILIES, kafka.parse, code=True),
    ParserSpec(rabbitmq.NAME, _CHANNEL_FAMILIES, rabbitmq.parse, code=True),
    ParserSpec(nats.NAME, _CHANNEL_FAMILIES, nats.parse, code=True),
    ParserSpec(bullmq.NAME, _CHANNEL_FAMILIES, bullmq.parse, code=True),
    ParserSpec(sidekiq.NAME, (*_CHANNEL_FAMILIES, "schedules"), sidekiq.parse, code=True),
    ParserSpec(celerybeat.NAME, ("schedules",), celerybeat.parse, code=True),
    ParserSpec(gocron.NAME, ("schedules",), gocron.parse, code=True),
    ParserSpec(clokwerk.NAME, ("schedules",), clokwerk.parse, code=True),
    ParserSpec(nodecron.NAME, ("schedules",), nodecron.parse, code=True),
    ParserSpec(crontab.NAME, ("schedules",), crontab.parse),
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
        files.dev_code = set()
        try:
            part = spec.parse(files, ctx)
        except Exception as exc:  # падение одного не валит запуск (ТЗ §3)
            errors[spec.name] = type(exc).__name__
            continue
        if files.dev_code:
            # Пропущенный код в каталогах для разработки — этому разборщику (его семьям).
            part.dev_code[spec.name] = files.dev_code
        found.extend(part)
    # Команды скриптов репозитория, которые запускают единицы (ТЗ §15 п. 16 П1): после всех
    # разборщиков, потому что единицы и Dockerfile дают разные разборщики.
    scripts.attach(found, files)
    return found, errors
