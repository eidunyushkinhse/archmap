"""Экспорт схемы в YAML для скармливания LLM (read-only сериализация домена).

Поверх реляционного хранения (его НЕ меняем) собираем семантику: имя, тип (shape),
роль, технологию, описание + иерархию (вложенностью через children) и связи
(списком edges по именам узлов). Раскладку (координаты, хэндлы, изломы, label_t) и
вложенные документы (доки логики node_docs, openapi_spec) НЕ включаем — модели
нужна архитектурная семантика, а не геометрия и не простыни спек (раздули бы
контекст).
Тот же принцип, что у версионирования: «сериализуется только семантика».

Размещение (docs/tasks/deployment-view.md) — тоже семантика: раздел deployment.sites
после edges (площадки с вложенностью по имени родителя) и у узла sites — имена
площадок, где он стоит САМ. Унаследованное от контейнера — производное, его не пишем:
импорт восстановит его тем же наследованием.

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
from collections.abc import Sequence

import yaml

from app.element import Elements
from app.element_marks import build_elements, element_rows_of
from app.identity import source_ref_dict
from app.models.deployment_site import DeploymentSite
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


def build_export(
    nodes: list[Node],
    edges: list[Edge],
    root_id: uuid.UUID | None = None,
    sites: Sequence[DeploymentSite] = (),
    instances: Sequence[tuple[uuid.UUID, uuid.UUID]] = (),
    elements: Elements[uuid.UUID] | None = None,
) -> str:
    """Собирает YAML-документ {nodes: <дерево>, edges: <список>} для набора узлов.

    nodes/edges — уже отфильтрованный набор (вся схема или закрытое поддерево).
    root_id в дереве не используется напрямую: «корнями» дерева считаются узлы,
    чей родитель вне набора (для поддерева это и есть его корень, для всей схемы —
    настоящие корни parent_id=None). Он решает состав площадок: без него — все
    площадки проекта, с ним — только нужные поддереву (см. _sites_section).

    sites и instances — площадки проекта (deployment.project_sites) и свои
    экземпляры парами (узел, площадка) (deployment.ordered_instances). Без них
    документ ровно прежний: раздела deployment и ключа sites у узлов нет.

    elements — действующие элементы ПРОЕКТА (element_marks): по ним решается, чьи
    экземпляры пишутся (только единиц размещения — контейнеров). Без них элементы
    считаются по самому набору — это верно для набора, замкнутого вверх (вся схема);
    поддерево обязано передать элементы проекта: контейнер над корнем поддерева делает
    его узлы компонентами.
    """
    return build_export_ordered(nodes, edges, root_id, sites, instances, elements)[0]


def _sites_section(
    sites: Sequence[DeploymentSite], used: set[uuid.UUID], whole: bool
) -> list[dict]:
    """Площадки раздела deployment.sites: родители раньше детей, внутри — по имени.

    whole — экспорт всего проекта: пишутся все площадки, и пустые тоже (пустая
    площадка — такая же часть топологии). Экспорт поддерева пишет только площадки,
    на которые ссылаются его узлы (used), вместе с их предками: документ обязан быть
    самодостаточным — импорт отвергает родителя, которого нет в разделе.

    Подъём к предкам и обход — с seen: цикл в данных (его не пропускают ручки, но
    данные бывают и из снимков) не вешает экспорт. Площадка, до которой обход от
    корней не дошёл (член цикла), пишется корневой — документ остаётся разбираемым.
    """
    by_id = {s.id: s for s in sites}
    keep: set[uuid.UUID] = set(by_id)
    if not whole:
        keep = set()
        for sid in used:
            cur: uuid.UUID | None = sid
            while cur is not None and cur in by_id and cur not in keep:
                keep.add(cur)
                cur = by_id[cur].parent_id
    chosen = sorted((by_id[sid] for sid in keep), key=lambda s: (s.name, str(s.id)))
    kids: dict[uuid.UUID | None, list[DeploymentSite]] = defaultdict(list)
    for s in chosen:
        parent = s.parent_id if s.parent_id in keep else None
        kids[parent].append(s)

    out: list[dict] = []
    written: set[uuid.UUID] = set()

    def visit(site: DeploymentSite) -> None:
        if site.id in written:
            return
        d: dict = {"name": site.name}
        if site.kind != "other":
            d["kind"] = site.kind
        if site.technology:
            d["technology"] = site.technology
        if site.description:
            d["description"] = site.description
        parent_id = site.parent_id
        if parent_id is not None and parent_id in written:
            d["parent"] = by_id[parent_id].name
        written.add(site.id)
        out.append(d)
        for k in kids.get(site.id, []):
            visit(k)

    for s in kids.get(None, []):
        visit(s)
    for s in chosen:  # члены цикла — корневыми, в порядке имени
        visit(s)
    return out


def build_export_ordered(
    nodes: list[Node],
    edges: list[Edge],
    root_id: uuid.UUID | None = None,
    sites: Sequence[DeploymentSite] = (),
    instances: Sequence[tuple[uuid.UUID, uuid.UUID]] = (),
    elements: Elements[uuid.UUID] | None = None,
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

    # Площадки единиц размещения набора — контейнеров, в том числе листьев (Р16 эпика
    # docs/plan-c4-elements.md) — в порядке площадок (по имени): так их пишет ключ sites,
    # и так же импорт вернёт их строкой «Размещение». Экземпляры системы, компонента и
    # «Пользователя» (прежние данные, «спящие») не пишутся: размещение их не считает.
    # Элементы нужны, только если экземпляры есть: документ без размещения их не читает.
    site_by_id = {s.id: s for s in sites}
    site_rank = {s.id: i for i, s in enumerate(sites)}
    own_sites: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
    if instances and elements is None:
        elements = build_elements(element_rows_of(nodes))
    for node_id, site_id in instances:
        if node_id not in by_id or elements is None or elements.effective(node_id) != "container":
            continue
        if site_id in site_by_id and site_id not in own_sites[node_id]:
            own_sites[node_id].append(site_id)
    for site_ids in own_sites.values():
        site_ids.sort(key=lambda sid: site_rank[sid])

    def placed_sites(node: Node) -> list[uuid.UUID] | None:
        """Ключ sites узла. Единица (контейнер, в том числе с компонентами) пишет свои
        площадки; компонент — никогда. Система, все единицы которой стоят на одном
        непустом наборе площадок, пишет sites сама, а её поддерево — нет: короче, и
        читается как размещение целиком (импорт раздаёт объявление системы её единицам
        — unit_placements). Иначе None."""
        if not own_sites or elements is None:
            return None
        element = elements.effective(node.id)
        if element == "container":
            return own_sites.get(node.id)
        if element != "system":
            return None
        units = elements.units_under(node.id)
        if not units:
            return None
        first = own_sites.get(units[0], [])
        if not first or any(own_sites.get(unit, []) != first for unit in units[1:]):
            return None
        return first

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

    def node_dict(node: Node, covered: bool = False) -> dict:
        # Порядок ключей осознанный (sort_keys=False при дампе): сперва идентичность
        # и тип, потом необязательная семантика, дети — последними. covered —
        # размещение уже записано у системы выше: у поддерева ключа sites нет.
        order.append(node.id)  # до рекурсии по детям: обход = порядок документа
        d: dict = {"name": node.name, "shape": node.shape}
        # Элемент архитектуры (Р29) — рядом с формой и только заданный: null («не
        # сказано») не пишем, и документ проекта без элементов остаётся прежним.
        if node.element:
            d["element"] = node.element
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
        placed = None if covered else placed_sites(node)
        if placed:
            d["sites"] = [site_by_id[sid].name for sid in placed]
        if kids:
            d["children"] = [node_dict(k, covered or bool(placed)) for k in kids]
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

    structure: dict = {
        "nodes": [node_dict(r) for r in sort(roots)],
        "edges": edge_dicts,
    }
    used = {sid for site_ids in own_sites.values() for sid in site_ids}
    site_dicts = _sites_section(sites, used, whole=root_id is None)
    if site_dicts:
        structure["deployment"] = {"sites": site_dicts}
    text = yaml.dump(
        structure,
        Dumper=_Dumper,
        allow_unicode=True,
        sort_keys=False,
        default_flow_style=False,
        width=4096,
    )
    return text, order
