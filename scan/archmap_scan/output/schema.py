"""schema.yaml (ТЗ §5.1): скелет схемы в формате единого ввоза ArchMap.

Порядок ключей как в примере промпта ввоза: name, shape, status, element, role, technology,
external, description, source, children; у связей from, to, label, technology, channel.
Описаний сборщик не пишет. element ставится только корню-системе: листы без вложенных
объектов ввоз считает контейнерами.
"""

from __future__ import annotations

from collections import Counter

from archmap_scan.assemble import Model, Obj
from archmap_scan.context import Context
from archmap_scan.output import yamlio


def refs(model: Model) -> dict[str, str]:
    """Имя объекта → как его называть в связях и адресах: имя или путь «Система / имя»,
    если имя в документе не одно (ArchMap адресует тёзок путём от корня)."""
    counts = Counter([model.system] + [o.name for o in model.objects])
    return {
        o.name: o.name if counts[o.name] == 1 else f"{model.system} / {o.name}"
        for o in model.objects
    }


def node_path(model: Model, obj: Obj) -> str:
    """Адрес объекта для «# archmap-node:» и ключей оснований."""
    return f"{model.system} / {obj.name}"


def _node(obj: Obj, ctx: Context) -> dict[str, object]:
    node: dict[str, object] = {"name": obj.name, "shape": obj.shape, "status": "existing"}
    if obj.role:
        node["role"] = obj.role
    if obj.technology:
        node["technology"] = obj.technology
    source: dict[str, object] = {}
    if obj.repo and ctx.repo:
        source["repo"] = ctx.repo
    if obj.path:
        source["path"] = obj.path
    if obj.host:
        source["host"] = obj.host
    if source:
        node["source"] = source
    return node


def render(model: Model, ctx: Context) -> str:
    root: dict[str, object] = {
        "name": model.system, "shape": "service", "status": "existing", "element": "system",
    }
    children = [_node(o, ctx) for o in model.objects]
    if children:
        root["children"] = children
    doc: dict[str, object] = {"nodes": [root]}
    names = refs(model)
    edges = []
    for link in model.links:
        edge: dict[str, object] = {
            "from": names[link.src.name], "to": names[link.dst.name], "label": link.label,
        }
        if link.technology:
            edge["technology"] = link.technology
        edges.append(edge)
    if edges:
        doc["edges"] = edges
    return yamlio.header(ctx.repo, ctx.commit) + yamlio.dump(doc)
