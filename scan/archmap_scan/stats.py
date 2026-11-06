"""Счёт покрытия по семьям (ТЗ §8) из реестра разборщиков, находок и собранной модели."""

from __future__ import annotations

from collections.abc import Sequence

from archmap_scan import owners, paths, registry, texts, vocab
from archmap_scan.model import Findings
from archmap_scan.objects import BROKER, DATABASE, SERVICE, Model, Obj
from archmap_scan.output.coverage import FamilyStat

_CODE_PARSERS = frozenset(p.name for p in registry.PARSERS if p.code)
# Источники параметра, которые читают файлы каталога кода: чтения в коде и примеры
# окружения. Окружение манифеста (compose, k8s) записано своему сервису и общим кодом не
# бывает, даже если имя повторено через якоря YAML.
_SHARED_PARAM_PARSERS = _CODE_PARSERS | {"env-example"}
# Семьи яруса кода: им считается пропущенный код в каталогах для разработки (ТЗ §4).
_DEV_CODE_FAMILIES = ("config", "channels", "http_routes", "schedules")


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
        out[fam].from_dev_manifests = sum(
            1 for o in model.objects if o.shape == shape and o.name in model.dev_objects
        )
    if model.implicit:
        out["containers"].notes.append(texts.NOTE_IMPLICIT_CONTAINER)
    if model.by_buildfiles:
        out["containers"].notes.append(texts.NOTE_BUILDFILES)
        out["containers"].unsupported.extend(model.build_unsupported)
    if model.db_by_migrations:
        out["databases"].notes.append(texts.NOTE_DB_BY_MIGRATIONS)
    if model.broker_by_client:
        out["brokers"].notes.append(texts.NOTE_BROKER_BY_CLIENT)
    if merged := model.hints.get("merged"):
        out["containers"].notes.append(texts.merged_note(len(merged)))
    out["edges"].found = len(model.links)
    # Связи по каналу, чей контейнер не определим: канал записан, связи нет (ТЗ §13.2).
    out["edges"].unassigned = _hints_of(model, "unassigned", "edge")
    out["edges"].contributed = _ordered(
        {p for lk in model.links for p in lk.parsers} | model.code_parsers.get("edges", set())
    )
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
    config.distinct, config.holders, config.shared_records = _shared_params(model)
    config.unassigned = _hints_of(model, "unassigned", "config")
    config.dynamic_names = _hints_of(model, "dynamic_names", "config")
    code_parsers = model.code_parsers.get("config", set())
    config.contributed = _ordered({x for p in params for x in p.parsers} | code_parsers)
    config.from_code = bool(code_parsers)
    _code_family(out["http_routes"], model, "route", sum(len(v) for v in model.http.values()))
    _code_family(out["channels"], model, "channel", sum(len(v) for v in model.channels.values()))
    containers = [o for o in model.objects if o.is_container]
    unsupported = code_unsupported(findings, containers)
    for fam, stacks in [*findings.unsupported.items(), *unsupported.items()]:
        for stack in stacks:
            if stack not in out[fam].unsupported:
                out[fam].unsupported.append(stack)
    # «Стек не опознан» — только когда язык контейнеров не известен вовсе (ТЗ §15 п. 10
    # А12): у контейнеров на Python, Node.js или Go разборщики семьи проверили зависимости и
    # клиента или фреймворка не нашли, это «пусто».
    if any(o.language in vocab.CONFIG_LANGUAGES for o in containers):
        for fam in ("http_routes", "channels"):
            if out[fam].status == "unknown":
                out[fam].ran = [
                    p.name for p in registry.PARSERS
                    if p.code and fam in p.families and p.name not in errors
                ]
    for note in model.dev_notes:
        if note not in out["containers"].notes:
            out["containers"].notes.append(note)
    for fam, notes in findings.notes.items():
        for note in notes:
            if note not in out[fam].notes:
                out[fam].notes.append(note)
    for fam in _DEV_CODE_FAMILIES:
        skipped = {
            rel for name in registry.parsers_for(fam) for rel in findings.dev_code.get(name, ())
        }
        if skipped:
            out[fam].skipped["dev_code"] = len(skipped)
        # Файлы служебных каталогов и конфигов инструментов, записи которых ушли в
        # подсказки (ТЗ §13.1): прочитаны, но не факты.
        tooling = model.tooling_files.get(fam, set())
        if tooling:
            out[fam].skipped["tooling"] = len(tooling)
        out[fam].tooling = _aside_of(model, _FAMILY_KINDS[fam], texts.TOOLING_REASONS)
    out["config"].os_variables = _aside_of(
        model, "config", frozenset({texts.REASON_OS_VARIABLE}),
    )
    return out


# Вид записи подсказки по семье кода.
_FAMILY_KINDS = {
    "config": "config", "channels": "channel", "http_routes": "route", "schedules": "schedule",
}


def _aside_of(model: Model, kind: str, reasons: frozenset[str]) -> int:
    """Подсказки unassigned вида kind с причиной из reasons: записи, которые не факты."""
    return sum(
        1 for h in model.hints.get("unassigned", [])
        if h.get("kind") == kind and h.get("reason") in reasons
    )


def _shared_params(model: Model) -> tuple[int, int, int]:
    """Разных имён параметров, число контейнеров с параметрами общего кода и число таких
    записей. Запись общего кода — та, чьё основание из кода или примера окружения лежит в
    каталоге hints.shared_code, общем у её контейнера с другими (Zulip: 19 общих имён у 7
    контейнеров, 133 записи). Повтор имени через якоря YAML (Lemmy) или одинаковые имена в
    своём коде разных контейнеров общим кодом не считаются (ТЗ §15 п. 10 А10)."""
    names = {name for table in model.params.values() for name in table}
    shared: list[tuple[str, list[str]]] = []
    for hint in model.hints.get("shared_code", []):
        shown = str(hint.get("name", ""))
        folder = "" if shown == "./" else shown.rstrip("/")
        containers = hint.get("containers")
        shared.append((folder, [str(c) for c in containers] if isinstance(containers, list) else []))
    holders: set[str] = set()
    records = 0
    for owner, table in model.params.items():
        dirs = [folder for folder, containers in shared if owner in containers]
        if not dirs:
            continue
        for param in table.values():
            if not param.parsers & _SHARED_PARAM_PARSERS:
                continue
            if any(paths.under(loc.path, folder) for loc in param.locs for folder in dirs):
                holders.add(owner)
                records += 1
    return len(names), len(holders), records


def _hints_of(model: Model, section: str, kind: str) -> int:
    """Подсказки раздела вида kind. Записи служебных каталогов и переменные ОС ушли в
    подсказки не из-за владельца, поэтому в счёт «без владельца» не входят (ТЗ §13.1)."""
    return sum(
        1 for h in model.hints.get(section, [])
        if h.get("kind") == kind and h.get("reason") not in texts.ASIDE_REASONS
    )


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


# Семьи яруса кода, где язык без чтения кода назван сам, если библиотеки семьи у него нет
# (ТЗ §15 п. 10 А12: у Lemmy каналы и воркеры на Rust — «Rust», а не «стек не опознан»).
_LANGUAGE_FAMILIES = ("http_routes", "channels", "workers", "schedules")


def _label(language: str, name: str) -> str:
    """Имя стека «Язык: библиотека» (Rust: actix-web) у языка, код на котором сборщик не
    читает; у читаемого языка имя самой библиотеки (Pub/Sub, BullMQ)."""
    return name if language in vocab.CONFIG_LANGUAGES else f"{language}: {name}"


def code_unsupported(
    findings: Findings, containers: Sequence[Obj] | None = None,
) -> dict[str, list[str]]:
    """Стеки, опознанные по манифестам сборки, которые ярус кода в этой версии не читает
    (ТЗ §6.2, §6.4): фреймворки без разборщика маршрутов, параметры в коде по языкам,
    каналы, воркеры и расписания по библиотекам, описания схем без разборщика. Стек
    называется только по прямой зависимости или файлу манифеста, который принадлежит коду
    контейнера (owners.file_owners): Gemfile fastlane и Cargo.toml мобильного приложения
    immich к контейнерам не относятся (ТЗ §15 п. 10 А12). containers=None — все манифесты."""
    found: dict[str, list[str]] = {
        "http_routes": [], "config": [], "channels": [], "workers": [], "schedules": [],
        "tables": [],
    }
    tables = (
        ("http_routes", vocab.SERVER_FRAMEWORKS), ("channels", vocab.UNSUPPORTED_CHANNEL_DEPS),
        ("workers", vocab.UNSUPPORTED_WORKER_DEPS), ("schedules", vocab.UNSUPPORTED_SCHEDULE_DEPS),
    )
    unread: list[str] = []

    def add(fam: str, name: str) -> None:
        if name not in found[fam]:
            found[fam].append(name)

    for pkg in sorted(findings.packages, key=lambda p: p.path):
        if containers is not None and not owners.file_owners(pkg.path, containers, pkg.language):
            continue
        for fam, table in tables:
            for lib in vocab.frameworks_in(pkg.deps, table):
                if fam != "http_routes" or lib not in vocab.ROUTE_FRAMEWORKS:
                    add(fam, _label(pkg.language, lib))
        if pkg.language not in vocab.CONFIG_LANGUAGES:
            add("config", pkg.language)
            if pkg.language not in unread:
                unread.append(pkg.language)
        viper = vocab.find_framework(pkg.deps, vocab.UNSUPPORTED_CONFIG_DEPS)
        if viper:
            add("config", viper)
        schema = vocab.find_framework(pkg.deps, vocab.UNSUPPORTED_SCHEMA_DEPS)
        if schema:
            add("tables", schema)
    for fam in _LANGUAGE_FAMILIES:
        for language in unread:
            if not any(item.startswith(language + ": ") for item in found[fam]):
                add(fam, language)
    return {fam: sorted(items, key=str.lower) for fam, items in found.items() if items}
