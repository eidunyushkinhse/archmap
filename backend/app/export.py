"""Экспорт схемы в YAML для скармливания LLM (read-only сериализация домена).

Поверх реляционного хранения (его НЕ меняем) собираем семантику: имя, тип (shape),
роль, технологию, описание + иерархию (вложенностью через children) и связи
(списком edges по именам узлов). Раскладку (координаты, хэндлы, изломы, label_t) и
вложенные документы (flowchart, openapi_spec) НЕ включаем — модели нужна
архитектурная семантика, а не геометрия и не простыни спек (раздули бы контекст).
Тот же принцип, что у версионирования: «сериализуется только семантика».

Связи ссылаются на узлы ПО ИМЕНИ. Имя по построению дерева уникальным быть не
обязано — если в экспортируемом наборе оно встречается дважды, в edges
подставляется квалифицированный путь «Предок / Имя» (в самом дереве имя
оставляем голым: позиция во вложенности и так однозначна).
"""

import uuid
from collections import Counter, defaultdict

import yaml

from app.models.edge import Edge
from app.models.node import Node


class _Dumper(yaml.SafeDumper):
    """Свой дампер, чтобы не трогать глобальный реестр представлений PyYAML."""


def _str_representer(dumper: yaml.Dumper, data: str) -> yaml.Node:
    # Многострочные описания печатаем литеральным блоком (|), а не строкой с \n —
    # так модель (и человек) читает их как есть.
    style = "|" if "\n" in data else None
    return dumper.represent_scalar("tag:yaml.org,2002:str", data, style=style)


_Dumper.add_representer(str, _str_representer)


def build_export(nodes: list[Node], edges: list[Edge], root_id: uuid.UUID | None = None) -> str:
    """Собирает YAML-документ {nodes: <дерево>, edges: <список>} для набора узлов.

    nodes/edges — уже отфильтрованный набор (вся схема или закрытое поддерево).
    root_id не используется напрямую: «корнями» дерева считаются узлы, чей
    родитель вне набора (для поддерева это и есть его корень, для всей схемы —
    настоящие корни parent_id=None).
    """
    by_id: dict[uuid.UUID, Node] = {n.id: n for n in nodes}
    included = set(by_id)

    # Группируем детей по родителю (только в пределах набора).
    children_by_parent: dict[uuid.UUID, list[Node]] = defaultdict(list)
    roots: list[Node] = []
    for n in nodes:
        if n.parent_id is not None and n.parent_id in included:
            children_by_parent[n.parent_id].append(n)
        else:
            roots.append(n)

    # Сколько раз имя встречается в наборе — чтобы решить, нужен ли путь в edges.
    name_counts = Counter(n.name for n in nodes)

    def ref_name(node: Node) -> str:
        """Имя узла для ссылки в edges: голое, если уникально, иначе путь от корня набора."""
        if name_counts[node.name] == 1:
            return node.name
        path: list[str] = []
        cur: Node | None = node
        while cur is not None and cur.id in included:
            path.append(cur.name)
            cur = by_id.get(cur.parent_id) if cur.parent_id else None
        path.reverse()
        return " / ".join(path)

    def node_dict(node: Node) -> dict:
        # Порядок ключей осознанный (sort_keys=False при дампе): сперва идентичность
        # и тип, потом необязательная семантика, дети — последними.
        d: dict = {"name": node.name, "shape": node.shape}
        if node.role:
            d["role"] = node.role
        if node.technology:
            d["technology"] = node.technology
        if node.is_external:
            d["external"] = True
        if node.description:
            d["description"] = node.description
        kids = sorted(children_by_parent.get(node.id, []), key=lambda n: n.name)
        if kids:
            d["children"] = [node_dict(k) for k in kids]
        return d

    def edge_dict(e: Edge) -> dict:
        d: dict = {"from": ref_name(by_id[e.source_id]), "to": ref_name(by_id[e.target_id])}
        if e.label:
            d["label"] = e.label
        if e.technology:
            d["technology"] = e.technology
        return d

    edge_dicts = [
        edge_dict(e) for e in edges if e.source_id in included and e.target_id in included
    ]
    edge_dicts.sort(key=lambda d: (d["from"], d["to"], d.get("label") or ""))

    structure = {
        "nodes": [node_dict(r) for r in sorted(roots, key=lambda n: n.name)],
        "edges": edge_dicts,
    }
    return yaml.dump(
        structure,
        Dumper=_Dumper,
        allow_unicode=True,
        sort_keys=False,
        default_flow_style=False,
        width=4096,
    )
