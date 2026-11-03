"""Каталог agent/ (ТЗ §5.3): основания, подсказки и точки входа. ArchMap его не ввозит,
его читает агент и человек."""

from __future__ import annotations

from collections.abc import Iterable

from archmap_scan.assemble import Model
from archmap_scan.context import Context
from archmap_scan.model import Loc
from archmap_scan.output import yamlio
from archmap_scan.output.schema import refs

# Разделы hints.yaml в постоянном порядке; пустые пишутся пустыми списками.
HINT_SECTIONS: tuple[str, ...] = (
    "depends_on", "dynamic_names", "unassigned", "unsupported", "openapi_files", "profiles",
    "shared_code", "clients", "unparsed",
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
        out[f"edges/{names[link.src.name]}→{names[link.dst.name]}"] = _locs(link.locs)
    return out


def render_evidence(model: Model, ctx: Context) -> str:
    return yamlio.header(ctx.repo, ctx.commit) + yamlio.dump(evidence(model, ctx))


def _sort_key(item: dict[str, object]) -> tuple[str, ...]:
    return tuple(str(v) for v in item.values())


def render_hints(model: Model, ctx: Context) -> str:
    doc: dict[str, object] = {}
    for section in HINT_SECTIONS:
        items = model.hints.get(section, [])
        unique: list[dict[str, object]] = []
        for item in sorted(items, key=_sort_key):
            if item not in unique:
                unique.append(item)
        doc[section] = unique
    return yamlio.header(ctx.repo, ctx.commit) + yamlio.dump(doc)


def render_entrypoints(model: Model, ctx: Context) -> str:
    doc: dict[str, object] = {}
    for obj in model.objects:
        if not obj.is_container:
            continue
        doc[obj.name] = {"http": [], "workers": [], "schedules": [], "consumers": []}
    return yamlio.header(ctx.repo, ctx.commit) + yamlio.dump({"containers": doc})
