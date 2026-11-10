"""Каталог agent/ (ТЗ §5.3): основания, подсказки и точки входа. ArchMap его не импортирует,
его читает агент и человек."""

from __future__ import annotations

from collections.abc import Iterable

from archmap_scan.context import Context
from archmap_scan.model import Loc
from archmap_scan.objects import Model
from archmap_scan.output import yamlio
from archmap_scan.output.schema import refs

# Разделы hints.yaml в постоянном порядке; пустые пишутся пустыми списками.
HINT_SECTIONS: tuple[str, ...] = (
    "depends_on", "dynamic_names", "unassigned", "unsupported", "openapi_files", "profiles",
    "dev_manifest_objects", "shared_code", "clients", "unparsed", "external_repos", "merged",
)


def _locs(locs: Iterable[Loc]) -> list[str]:
    return [str(loc) for loc in sorted(set(locs))]


def evidence(model: Model, ctx: Context) -> dict[str, list[str]]:
    """Ключ записи → основания «файл:строка». Без основания записи в выводе нет."""
    out: dict[str, list[str]] = {}
    if model.system_locs:
        out[f"nodes/{model.system}"] = _locs(model.system_locs)
    for obj in model.objects:
        out[f"nodes/{model.system} / {obj.name}"] = _locs(obj.locs)
    names = refs(model)
    for link in model.links:
        key = f"edges/{names[link.src.name]}→{names[link.dst.name]}"
        if link.channel:
            key += f"#{link.channel}"
        out[key] = sorted(set(out.get(key, [])) | set(_locs(link.locs)))
    for obj in model.objects:
        for table in sorted(model.tables.get(obj.name, []), key=lambda t: (t.schema or "", t.name)):
            shown = f"{table.schema}.{table.name}" if table.schema else table.name
            locs = list(table.locs) + [loc for c in table.columns for loc in c.locs]
            out[f"tables/{obj.name}/{shown}"] = _locs(locs)
    for obj in model.objects:
        for name in sorted(model.channels.get(obj.name, {})):
            out[f"channels/{obj.name}/{name}"] = _locs(model.channels[obj.name][name].locs)
    for obj in model.objects:
        for name in sorted(model.params.get(obj.name, {})):
            out[f"config/{obj.name}/{name}"] = _locs(model.params[obj.name][name].locs)
    return out


def render_evidence(model: Model, ctx: Context) -> str:
    return yamlio.header(ctx.repo, ctx.commit) + yamlio.dump(evidence(model, ctx))


# Общий набор ключей подсказки любого раздела (ТЗ §5.3) в постоянном порядке, за ним поля
# записи, когда они известны: метод маршрута, выражение и задача расписания (ТЗ §15 п. 16
# П3); ключи раздела (profiles, operations, containers и подобные) идут после них.
HINT_KEYS: tuple[str, ...] = ("kind", "name", "object", "reason", "source")
HINT_RECORD_KEYS: tuple[str, ...] = ("method", "schedule", "task")


def ordered_hint(item: dict[str, object]) -> dict[str, object]:
    """Ключи подсказки: kind, name, object, reason, source, method, schedule, task, затем
    остальные как записаны. Пустые поля записи не пишутся."""
    out = {key: item[key] for key in HINT_KEYS if key in item}
    out.update((key, item[key]) for key in HINT_RECORD_KEYS if item.get(key))
    out.update(
        (key, value) for key, value in item.items()
        if key not in out and key not in HINT_RECORD_KEYS
    )
    return out


def _sort_key(item: dict[str, object]) -> tuple[str, ...]:
    return tuple(str(v) for v in item.values())


def render_hints(model: Model, ctx: Context) -> str:
    """Разделы подсказок в постоянном порядке; повторов нет по построению (Model.hint)."""
    doc: dict[str, object] = {
        section: sorted((ordered_hint(h) for h in model.hints.get(section, [])), key=_sort_key)
        for section in HINT_SECTIONS
    }
    return yamlio.header(ctx.repo, ctx.commit) + yamlio.dump(doc)


def _http(model: Model, name: str) -> list[dict[str, object]]:
    out: list[dict[str, object]] = []
    for entry in model.http.get(name, []):
        item: dict[str, object] = {
            "method": entry.method, "path": entry.path, "framework": entry.framework,
        }
        if entry.prefix_unresolved:
            item["prefix_unresolved"] = True
        item["source"] = str(entry.loc)
        if entry.openapi is not None:
            item["openapi_source"] = str(entry.openapi)
        out.append(item)
    return out


def entrypoints(model: Model) -> dict[str, object]:
    """Точки входа по контейнерам: маршруты HTTP из кода, воркеры, расписания,
    потребители каналов (ТЗ §5.3)."""
    doc: dict[str, object] = {}
    for obj in model.objects:
        if not obj.is_container:
            continue
        workers: list[dict[str, object]] = []
        for w in model.workers.get(obj.name, []):
            item: dict[str, object] = {"command": w.command}
            if w.queues:
                item["queues"] = yamlio.FlowSeq(w.queues)
            if w.replicas and w.replicas > 1:
                item["replicas"] = w.replicas
            item["source"] = str(w.loc)
            workers.append(item)
        schedules: list[dict[str, object]] = []
        for sch in model.schedules.get(obj.name, []):
            entry: dict[str, object] = {"name": sch.name, "schedule": sch.schedule}
            if sch.task:
                entry["task"] = sch.task
            entry["source"] = str(sch.loc)
            schedules.append(entry)
        consumers: list[dict[str, object]] = []
        for c in model.consumers.get(obj.name, []):
            consumer: dict[str, object] = {"channel": c.channel, "kind": c.kind}
            if c.broker:
                consumer["broker"] = c.broker
            consumer["source"] = str(c.loc)
            consumers.append(consumer)
        doc[obj.name] = {
            "http": _http(model, obj.name), "workers": workers, "schedules": schedules,
            "consumers": consumers,
        }
    return {"containers": doc}


def render_entrypoints(model: Model, ctx: Context) -> str:
    return yamlio.header(ctx.repo, ctx.commit) + yamlio.dump(entrypoints(model))
