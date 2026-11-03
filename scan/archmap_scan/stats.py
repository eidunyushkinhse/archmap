"""Счёт покрытия по семьям (ТЗ §8) из реестра разборщиков, находок и собранной модели."""

from __future__ import annotations

from archmap_scan import registry, texts, vocab
from archmap_scan.model import Findings
from archmap_scan.objects import BROKER, DATABASE, SERVICE, Model, Obj
from archmap_scan.output.coverage import FamilyStat

_CODE_PARSERS = frozenset(p.name for p in registry.PARSERS if p.code)


def _ordered(names: set[str]) -> list[str]:
    order = {p.name: i for i, p in enumerate(registry.PARSERS)}
    return sorted(names, key=lambda n: (order.get(n, len(order)), n))


def _objects_stat(objs: list[Obj], stat: FamilyStat) -> None:
    stat.found = len(objs)
    used: set[str] = set()
    for obj in objs:
        used.update(p for p in obj.parsers if p != "implicit")
        if obj.dockerfile is not None:
            used.add("dockerfile")
    stat.contributed = _ordered(used)


def families(model: Model, findings: Findings, errors: dict[str, str]) -> dict[str, FamilyStat]:
    out: dict[str, FamilyStat] = {}
    for fam in registry.FAMILIES:
        names = registry.parsers_for(fam)
        stat = FamilyStat(ran=registry.ran(fam, findings, errors))
        failed = [p for p in names if p in errors]
        if failed:
            stat.error = "; ".join(texts.parser_failed(p, errors[p]) for p in failed)
        out[fam] = stat
    for fam, shape in (("containers", SERVICE), ("databases", DATABASE), ("brokers", BROKER)):
        _objects_stat([o for o in model.objects if o.shape == shape], out[fam])
    if model.implicit:
        out["containers"].notes.append(texts.NOTE_IMPLICIT_CONTAINER)
    if model.db_by_migrations:
        out["databases"].notes.append(texts.NOTE_DB_BY_MIGRATIONS)
    out["edges"].found = len(model.links)
    out["edges"].contributed = _ordered({p for lk in model.links for p in lk.parsers})
    workers = [w for ws in model.workers.values() for w in ws]
    out["workers"].found = len(workers)
    out["workers"].contributed = _ordered({w.parser for w in workers})
    schedules = [sch for ss in model.schedules.values() for sch in ss]
    _code_family(out["schedules"], model, "schedule", len(schedules))
    out["schedules"].contributed = _ordered(
        {sch.parser for sch in schedules} | model.code_parsers.get("schedules", set())
    )
    # Из кода — только Celery beat: файл crontab, как и CronJob, описывает развёртывание.
    out["schedules"].from_code = bool(model.code_parsers.get("schedules", set()) & _CODE_PARSERS)
    tables = out["tables"]
    # Найдено — только записанное в facts/; без владельца — отдельным числом.
    tables.found = sum(len(items) for items in model.tables.values())
    tables.unassigned = model.table_stats.unassigned
    tables.contributed = _ordered(model.table_stats.parsers)
    tables.skipped = dict(sorted(model.table_stats.skipped.items()))
    tables.dropped = model.table_stats.dropped
    if model.table_stats.errors:
        tables.error = "; ".join(model.table_stats.errors)
    params = [p for table in model.params.values() for p in table.values()]
    config = out["config"]
    config.found = len(params)
    config.distinct, config.holders = _shared_params(model)
    config.unassigned = _hints_of(model, "unassigned", "config")
    config.dynamic_names = _hints_of(model, "dynamic_names", "config")
    code_parsers = model.code_parsers.get("config", set())
    config.contributed = _ordered({x for p in params for x in p.parsers} | code_parsers)
    config.from_code = bool(code_parsers)
    _code_family(out["http_routes"], model, "route", sum(len(v) for v in model.http.values()))
    _code_family(out["channels"], model, "channel", sum(len(v) for v in model.channels.values()))
    unsupported = code_unsupported(findings)
    for fam, stacks in [*findings.unsupported.items(), *unsupported.items()]:
        for stack in stacks:
            if stack not in out[fam].unsupported:
                out[fam].unsupported.append(stack)
    for fam, notes in findings.notes.items():
        for note in notes:
            if note not in out[fam].notes:
                out[fam].notes.append(note)
    return out


def _shared_params(model: Model) -> tuple[int, int]:
    """Разных имён параметров и число контейнеров, у которых записан параметр, общий с
    другим контейнером (код общего каталога: Zulip — 26 имён, 140 записей у 8
    контейнеров)."""
    holders: dict[str, set[str]] = {}
    for owner, table in model.params.items():
        for name in table:
            holders.setdefault(name, set()).add(owner)
    shared = {owner for owners in holders.values() if len(owners) > 1 for owner in owners}
    return len(holders), len(shared)


def _hints_of(model: Model, section: str, kind: str) -> int:
    return sum(1 for h in model.hints.get(section, []) if h.get("kind") == kind)


_KIND_FAMILY = {"route": "http_routes", "channel": "channels", "schedule": "schedules"}


def _code_family(stat: FamilyStat, model: Model, kind: str, found: int) -> None:
    """Семья яруса кода: записанное, без владельца, динамические имена и разборщики."""
    parsers = model.code_parsers.get(_KIND_FAMILY[kind], set())
    stat.found = found
    stat.unassigned = _hints_of(model, "unassigned", kind)
    stat.dynamic_names = _hints_of(model, "dynamic_names", kind)
    stat.contributed = _ordered(parsers)
    stat.from_code = bool(parsers)


def stacks(model: Model) -> list[str]:
    """Технологии объектов в порядке схемы, без повторов."""
    out: list[str] = []
    for obj in model.objects:
        if obj.technology and obj.technology not in out:
            out.append(obj.technology)
    return out


def code_unsupported(findings: Findings) -> dict[str, list[str]]:
    """Стеки, опознанные по манифестам сборки, которые ярус кода в этой версии не читает
    (ТЗ §6.2, §6.4): фреймворки без разборщика маршрутов, параметры в коде по языкам,
    каналы и расписания по библиотекам, описания схем без разборщика."""
    frameworks: list[str] = []
    languages: list[str] = []
    channel_libs: list[str] = []
    schema_stacks: list[str] = []
    schedulers: list[str] = []
    for pkg in sorted(findings.packages, key=lambda p: p.path):
        for server in vocab.frameworks_in(pkg.deps, vocab.SERVER_FRAMEWORKS):
            if server not in vocab.ROUTE_FRAMEWORKS and server not in frameworks:
                frameworks.append(server)
        if pkg.language not in vocab.CONFIG_LANGUAGES and pkg.language not in languages:
            languages.append(pkg.language)
        viper = vocab.find_framework(pkg.deps, vocab.UNSUPPORTED_CONFIG_DEPS)
        if viper and viper not in languages:
            languages.append(viper)
        for lib in vocab.frameworks_in(pkg.deps, vocab.UNSUPPORTED_CHANNEL_DEPS):
            if lib not in channel_libs:
                channel_libs.append(lib)
        for lib in vocab.frameworks_in(pkg.deps, vocab.UNSUPPORTED_SCHEDULE_DEPS):
            if lib not in schedulers:
                schedulers.append(lib)
        schema = vocab.find_framework(pkg.deps, vocab.UNSUPPORTED_SCHEMA_DEPS)
        if schema and schema not in schema_stacks:
            schema_stacks.append(schema)
    found = {
        "http_routes": frameworks,
        "config": languages,
        "channels": channel_libs,
        "schedules": schedulers,
        "tables": schema_stacks,
    }
    return {fam: sorted(items, key=str.lower) for fam, items in found.items() if items}
