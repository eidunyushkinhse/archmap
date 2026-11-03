"""Счёт покрытия по семьям (ТЗ §8) из реестра разборщиков, находок и собранной модели."""

from __future__ import annotations

from archmap_scan import registry, texts
from archmap_scan.assemble import BROKER, DATABASE, SERVICE, Model, Obj
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


def families(
    model: Model,
    errors: dict[str, str],
    findings_unsupported: dict[str, list[str]],
    findings_notes: dict[str, list[str]],
) -> dict[str, FamilyStat]:
    out: dict[str, FamilyStat] = {}
    for fam in registry.FAMILIES:
        names = registry.parsers_for(fam)
        stat = FamilyStat(ran=[p for p in names if p not in errors])
        failed = [p for p in names if p in errors]
        if failed:
            stat.error = "; ".join(texts.parser_failed(p, errors[p]) for p in failed)
        out[fam] = stat
    for fam, shape in (("containers", SERVICE), ("databases", DATABASE), ("brokers", BROKER)):
        _objects_stat([o for o in model.objects if o.shape == shape], out[fam])
    if model.implicit:
        out["containers"].notes.append(texts.NOTE_IMPLICIT_CONTAINER)
    out["edges"].found = len(model.links)
    out["edges"].contributed = _ordered({p for lk in model.links for p in lk.parsers})
    workers = [w for ws in model.workers.values() for w in ws]
    out["workers"].found = len(workers)
    out["workers"].contributed = _ordered({w.parser for w in workers})
    schedules = [sch for ss in model.schedules.values() for sch in ss]
    out["schedules"].found = len(schedules)
    out["schedules"].contributed = _ordered({sch.parser for sch in schedules})
    for fam, stacks in findings_unsupported.items():
        for stack in stacks:
            if stack not in out[fam].unsupported:
                out[fam].unsupported.append(stack)
    for fam, notes in findings_notes.items():
        for note in notes:
            if note not in out[fam].notes:
                out[fam].notes.append(note)
    return out


def stacks(model: Model) -> list[str]:
    """Технологии объектов в порядке схемы, без повторов."""
    out: list[str] = []
    for obj in model.objects:
        if obj.technology and obj.technology not in out:
            out.append(obj.technology)
    return out
