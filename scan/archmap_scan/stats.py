"""Счёт покрытия по семьям (ТЗ §8) из реестра разборщиков, находок и собранной модели."""

from __future__ import annotations

from archmap_scan import registry, texts, vocab
from archmap_scan.model import Findings
from archmap_scan.objects import BROKER, DATABASE, SERVICE, Model, Obj
from archmap_scan.output.coverage import FamilyStat


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
    out["schedules"].found = len(schedules)
    out["schedules"].contributed = _ordered({sch.parser for sch in schedules})
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
    config.unassigned = _hints_of(model, "unassigned", "config")
    config.dynamic_names = _hints_of(model, "dynamic_names", "config")
    code_parsers = {r.parser for r in findings.code_params}
    config.contributed = _ordered({x for p in params for x in p.parsers} | code_parsers)
    config.from_code = bool(code_parsers)
    _code_family(out["http_routes"], model, findings, "route",
                 sum(len(v) for v in model.http.values()), {r.parser for r in findings.routes})
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


def _hints_of(model: Model, section: str, kind: str) -> int:
    return sum(1 for h in model.hints.get(section, []) if h.get("kind") == kind)


def _code_family(
    stat: FamilyStat, model: Model, findings: Findings, kind: str, found: int,
    parsers: set[str],
) -> None:
    """Семья яруса кода: записанное, без владельца, динамические имена и разборщики."""
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
    каналы по клиентским библиотекам, расписания Celery, описания схем без разборщика."""
    frameworks: list[str] = []
    languages: list[str] = []
    channel_libs: list[str] = []
    schema_stacks: list[str] = []
    celery = False
    for pkg in sorted(findings.packages, key=lambda p: p.path):
        for server in vocab.frameworks_in(pkg.deps, vocab.SERVER_FRAMEWORKS):
            if server not in vocab.ROUTE_FRAMEWORKS and server not in frameworks:
                frameworks.append(server)
        if pkg.language not in vocab.CONFIG_LANGUAGES and pkg.language not in languages:
            languages.append(pkg.language)
        viper = vocab.find_framework(pkg.deps, vocab.UNSUPPORTED_CONFIG_DEPS)
        if viper and viper not in languages:
            languages.append(viper)
        for lib, kind in vocab.clients_of(pkg.deps):
            shown = lib.rsplit("/", 1)[-1] if lib.startswith("github.com/") else lib
            if kind in vocab.CHANNEL_CLIENTS and shown not in channel_libs:
                channel_libs.append(shown)
            celery = celery or kind == "Celery"
        schema = vocab.find_framework(pkg.deps, vocab.UNSUPPORTED_SCHEMA_DEPS)
        if schema and schema not in schema_stacks:
            schema_stacks.append(schema)
    found = {
        "http_routes": frameworks,
        "config": languages,
        "channels": channel_libs,
        "schedules": ["Celery beat"] if celery else [],
        "tables": schema_stacks,
    }
    return {fam: sorted(items, key=str.lower) for fam, items in found.items() if items}
