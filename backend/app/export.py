"""Экспорт схемы в YAML для скармливания LLM (read-only сериализация домена).

Поверх реляционного хранения (его НЕ меняем) собираем семантику: имя, тип (shape),
роль, технологию, описание + иерархию (вложенностью через children) и связи
(списком edges по именам узлов). Раскладку (координаты, хэндлы, изломы, label_t) и
вложенные документы (доки логики node_docs, openapi_spec) НЕ включаем — модели
нужна архитектурная семантика, а не геометрия и не простыни спек (раздули бы
контекст).
Тот же принцип, что у версионирования: «сериализуется только семантика».

Связи ссылаются на узлы ПО ИМЕНИ. Имя по построению дерева уникальным быть не
обязано — если в экспортируемом наборе оно встречается дважды, в edges
подставляется квалифицированный путь «Предок / Имя» (в самом дереве имя
оставляем голым: позиция во вложенности и так однозначна). Тёзок (одно имя в
одном родителе) и их потомков путь не различает — сегмент тёзки несёт уточнитель:
якорный «Предок / Имя @ git:…», когда якоря разводят всю группу, иначе порядковый
«Предок / Имя @ #N» (грамматика — app/node_ref.py). Порядок сиблингов
детерминирован и без выдачи БД: по имени, тёзки — по содержательному ключу
(node_ref.document_order).
"""

import uuid
from collections import Counter, defaultdict

import yaml

from app.identity import source_ref_dict
from app.models.edge import Edge
from app.models.node import Node
from app.node_ref import RefIndex, sibling_sorter


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
    return build_export_ordered(nodes, edges, root_id)[0]


def build_export_ordered(
    nodes: list[Node], edges: list[Edge], root_id: uuid.UUID | None = None
) -> tuple[str, list[uuid.UUID]]:
    """То же, что build_export, плюс ПОРЯДОК id узлов в готовом документе.

    Порядок — обход в глубину, родитель раньше своих детей: ровно тот, в котором
    parse_import нумерует узлы разобранного документа. По нему догрузка архива
    (unified_into) строит карту «узел моего же экспорта → живой узел»: ПУТИ для
    этого не годятся — тёзки в одном родителе легальны, и путь адресует двоих.
    """
    order: list[uuid.UUID] = []
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
    # Порядок сиблингов — порядок документа (app/node_ref.py): по имени, тёзки — по
    # содержательному ключу. От него зависят и дерево, и порядковые уточнители.
    sort = sibling_sorter(nodes)
    ordered: list[Node] = []

    def visit(node: Node) -> None:
        ordered.append(node)
        for k in sort(children_by_parent.get(node.id, [])):
            visit(k)

    for r in sort(roots):
        visit(r)

    # Адреса узлов от корня НАБОРА (у поддерева — от его корня): путь, а у тёзок и
    # их потомков — с уточнителем на сегменте тёзки (app/node_ref.py). Тёзки
    # считаются в пределах набора; порядковый номер — по порядку документа.
    addresses = dict(zip(
        (n.id for n in ordered), RefIndex.of_flat(ordered).addresses(), strict=True
    ))

    def ref_name(node: Node) -> str:
        """Имя узла для ссылки в edges: голое, если уникально, иначе путь от корня
        набора, а у тёзок и их потомков — с уточнителем («@ ключ» или «@ #N»)."""
        if name_counts[node.name] == 1:
            return node.name
        return addresses[node.id] or node.name

    def node_dict(node: Node) -> dict:
        # Порядок ключей осознанный (sort_keys=False при дампе): сперва идентичность
        # и тип, потом необязательная семантика, дети — последними.
        order.append(node.id)  # до рекурсии по детям: обход = порядок документа
        d: dict = {"name": node.name, "shape": node.shape}
        if node.status != "existing":
            d["status"] = node.status
        if node.role:
            d["role"] = node.role
        if node.technology:
            d["technology"] = node.technology
        if node.is_external:
            d["external"] = True
        if node.description:
            d["description"] = node.description
        # Якорь источника (Д1 архива): без него перенос проекта терял бы
        # идентичность узлов для синка. Пишем словарём формата импорта — тот
        # соберёт из него ровно тот же канонический ключ.
        if node.source_ref:
            src = source_ref_dict(node.source_ref)
            if src:
                d["source"] = src
        kids = sort(children_by_parent.get(node.id, []))
        if kids:
            d["children"] = [node_dict(k) for k in kids]
        return d

    def edge_dict(e: Edge) -> dict:
        d: dict = {"from": ref_name(by_id[e.source_id]), "to": ref_name(by_id[e.target_id])}
        if e.label:
            d["label"] = e.label
        if e.technology:
            d["technology"] = e.technology
        # Канал брокера — как остальная необязательная семантика: пишем, только если
        # задан (у связей без брокера его и не бывает).
        if e.channel:
            d["channel"] = e.channel
        # Тип канала (Д2 архива): только ЯВНОЕ значение — NULL значит «дефолт
        # синхронный», и писать его как true значило бы затвердить дефолт.
        # Без этого поля асинхронный канал приезжал бы «синхронным» молча, и у
        # него появлялось бы плечо «ответ», которого в исходном проекте не было.
        if e.is_synchronous is not None:
            d["sync"] = e.is_synchronous
        return d

    edge_dicts = [
        edge_dict(e) for e in edges if e.source_id in included and e.target_id in included
    ]
    edge_dicts.sort(key=lambda d: (d["from"], d["to"], d.get("label") or ""))

    structure = {
        "nodes": [node_dict(r) for r in sort(roots)],
        "edges": edge_dicts,
    }
    text = yaml.dump(
        structure,
        Dumper=_Dumper,
        allow_unicode=True,
        sort_keys=False,
        default_flow_style=False,
        width=4096,
    )
    return text, order
