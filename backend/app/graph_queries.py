"""Сборка сырого графа уровня (R2 вид-центричного движка).

Доменные алгоритмы, которые раньше жили прямо в HTTP-слое (routers.nodes): чтение
сохранённой раскладки вида, реестр не-локальных концов рёбер («призраков») и сама
сборка графа уровня. Сервер отдаёт СЫРЫЕ рёбра с реальными концами + реестр концов
с цепочками предков; проекцию концов на видимые сущности («подъём к ближайшему
видимому представителю») делает фронтенд (graph/projection.ts) — она зависит от
expand/collapse-состояния, известного только ему.
"""

import uuid
from collections import Counter

from sqlalchemy.orm import Session

from app import tree
from app.approval import effective_approvals
from app.element import Elements
from app.element_marks import elements_from_nodes
from app.models.edge import Edge
from app.models.node import Node
from app.models.view_layout import DEPLOY_KEY_PREFIX, ViewLayoutItem
from app.schemas.node import (
    GhostNodeResponse,
    GraphEdgeResponse,
    GraphResponse,
    NodeEdgeInfo,
)
from app.schemas.view import ViewLayoutPayload


def project_has_status_info(db: Session, project_id: uuid.UUID) -> bool:
    """Ведёт ли проект переход — есть ли в нём хоть один узел не-existing.

    Признак ПРОЕКТНЫЙ, а не уровневый, и потому едет в ответе КАЖДОГО уровня.
    Им фронт решает, показывать ли «Вид схемы» и «Принять переход»: и настройка
    вида (localStorage), и сам переход относятся ко всему проекту, а считать их
    по составу текущего уровня — значит прятать управление ровно тогда, когда
    пользователь стоит уровнем выше или ниже своих planned/deprecated узлов
    (находка 2026-08-09).
    """
    return db.query(
        db.query(Node)
        .filter(Node.project_id == project_id, Node.status != "existing")
        .exists()
    ).scalar() or False


def read_view_layout(
    db: Session, project_id: uuid.UUID, container_id: uuid.UUID | None, *, deploy: bool = False
) -> dict[str, ViewLayoutPayload]:
    """Раскладка вида как есть: ВСЕ строки view_layout этого вида (у корня view IS
    NULL — позиции корневых узлов теперь тоже здесь). Строки «не показанных
    сейчас» проекций безвредны (какая проекция видна — решает фронт) и живут
    намеренно: при возврате проекции геометрия воскресает. Инвариант F6а —
    ЧТЕНИЕ НЕ ПИШЕТ В БД; реальных сирот чистят каскад view_id и delete_node.

    Один вид — два холста: объекты и «Развёртывание» (ключи с DEPLOY_KEY_PREFIX).
    deploy=False (граф уровня) отдаёт ключи БЕЗ префикса, deploy=True (граф
    развёртывания) — только с ним: чужие ключи холсту не нужны, а фронт уровня
    принимал бы их за id узлов."""
    layout: dict[str, ViewLayoutPayload] = {}
    view_filter = (
        ViewLayoutItem.view_id.is_(None)
        if container_id is None
        else ViewLayoutItem.view_id == container_id
    )
    for r in (
        db.query(ViewLayoutItem)
        .filter(ViewLayoutItem.project_id == project_id, view_filter)
        .all()
    ):
        if r.item_id.startswith(DEPLOY_KEY_PREFIX) != deploy:
            continue
        payload = ViewLayoutPayload(**r.payload)
        # легаси-строки пучков (ручной слой стрелок, удалён 2026-07-09): все живые
        # поля пусты — не отдаём мусор
        if payload.x is None and payload.y is None and payload.expanded is None:
            continue
        layout[r.item_id] = payload
    return layout


def ghost_registry(
    all_nodes: dict[uuid.UUID, Node],
    endpoint_ids: set[uuid.UUID],
    child_counts: Counter,
    elements: Elements[uuid.UUID],
) -> list[GhostNodeResponse]:
    """Реестр не-локальных концов рёбер с цепочками предков (сортировка по id —
    детерминизм ответа). По нему фронтовая проекция поднимает конец к ближайшему
    видимому представителю и строит рамки/раскрытия. elements — действующие элементы
    проекта (app/element_marks.elements_from_nodes по той же карте узлов)."""
    return [
        GhostNodeResponse(
            id=all_nodes[nid].id,
            name=all_nodes[nid].name,
            role=all_nodes[nid].role,
            technology=all_nodes[nid].technology,
            is_external=all_nodes[nid].is_external,
            # shape/status — str в ORM-модели, но значение всегда из домена Literal
            # (контролируется схемой NodeCreate/NodeUpdate): безопасный cast.
            shape=all_nodes[nid].shape,
            status=all_nodes[nid].status,
            node_depth=tree.node_depth(all_nodes, nid),
            has_children=child_counts.get(nid, 0) > 0,
            child_count=child_counts.get(nid, 0),
            element_effective=elements.effective(nid),
            ancestors=tree.ancestors(all_nodes, nid, elements=elements),
        )
        for nid in sorted(endpoint_ids, key=str)
        if nid in all_nodes
    ]


def build_graph(
    local_nodes: list[Node],
    container_id: uuid.UUID | None,
    all_nodes: dict[uuid.UUID, Node],
    all_edges: list[Edge],
    db: Session,
    project_id: uuid.UUID,
) -> GraphResponse:
    """Собирает СЫРОЙ граф уровня (R2 вид-центричного движка).

    Отдаёт: детей контейнера, рёбра, затрагивающие его поддерево (с РЕАЛЬНЫМИ
    концами), реестр не-локальных концов с цепочками предков и пер-уровневый слой
    раскладки. Проекцию концов на видимые сущности («подъём к ближайшему видимому
    представителю») делает фронтенд (graph/projection.ts) — она зависит от
    expand/collapse-состояния, известного только ему.

    project_id передаётся ЯВНО, а не берётся из local_nodes[0]: у пустого уровня
    (контейнер без детей) локальных узлов нет, а собственные связи контейнера есть —
    и отдать их обязательно, иначе на пустом слое не во что упереться стрелкам
    (эпик «связи, упирающиеся в рамку»).
    """
    local_ids: set[uuid.UUID] = {n.id for n in local_nodes}
    subtree = (
        tree.subtree_ids(all_nodes, container_id)
        if container_id is not None
        else set(all_nodes)
    )

    result_edges: list[GraphEdgeResponse] = []
    endpoint_ids: set[uuid.UUID] = set()
    for edge in all_edges:
        # ребро относится к уровню, если затрагивает его поддерево хотя бы одним концом
        if edge.source_id not in subtree and edge.target_id not in subtree:
            continue
        result_edges.append(
            GraphEdgeResponse(
                id=edge.id,
                label=edge.label,
                technology=edge.technology,
                channel=edge.channel,
                source_id=edge.source_id,
                target_id=edge.target_id,
                version=edge.version,
            )
        )
        for nid in (edge.source_id, edge.target_id):
            if nid not in local_ids:
                endpoint_ids.add(nid)

    # Раскладка вида как есть (единый читатель read_view_layout).
    layout = read_view_layout(db, project_id, container_id)

    # Число прямых детей у каждого родителя — одним проходом по всем узлам.
    # Питает бейдж «есть дети (N)» и кнопку «Войти» и у концов-реестра, и у локалов.
    child_counts = Counter(n.parent_id for n in all_nodes.values() if n.parent_id is not None)
    # Действующий элемент архитектуры — по той же карте, один раз на запрос: он нужен
    # локалам, гостям и каждому предку в их цепочках.
    elements = elements_from_nodes(all_nodes)
    # Реестр не-локальных концов рёбер (единый строитель ghost_registry).
    endpoints = ghost_registry(all_nodes, endpoint_ids, child_counts, elements)
    # child_count/has_children локальных узлов — из того же Counter
    # (карта всех узлов уже в памяти; отдельный SQL _mark_has_children здесь лишний).
    # Статус страницы с учётом детей — по той же карте (app/approval): холст его пока
    # не показывает, но выдачу читают MCP и страница, и дефолт «в работе» у
    # согласованного узла был бы ложью.
    effective = effective_approvals((n.id, n.parent_id, n.approval) for n in all_nodes.values())
    # Размещение (NodeResponse.sites) здесь НЕ заполняется и остаётся []: холст
    # объектов его не показывает, а выборка экземпляров и площадок на каждый уровень
    # была бы лишней. Его отдают выдачи роутера узлов (mark_sites) и граф развёртывания.
    for n in local_nodes:
        n.child_count = child_counts.get(n.id, 0)
        n.has_children = n.child_count > 0
        n.approval_effective = effective.get(n.id, n.approval)
        n.element_effective = elements.effective(n.id)
    # ORM-узлы сериализуются в NodeResponse через from_attributes (child_count/
    # has_children/approval_effective/element_effective проставлены выше) — на границе
    # сериализации типизируем как list[NodeResponse].
    return GraphResponse(
        nodes=local_nodes,
        edges=result_edges,
        endpoints=endpoints,
        layout=layout,
        has_status_info=project_has_status_info(db, project_id),
    )


def external_edges(db: Session, project_id: uuid.UUID, node_id: uuid.UUID) -> list[NodeEdgeInfo]:
    """Внешние связи поддерева узла (он сам + потомки любой глубины) — те, что
    исчезнут при удалении узла: ровно один конец внутри поддерева, другой снаружи.
    Чисто внутренние связи ветки не включаем — они уходят вместе с самой веткой.
    Направление и имя соседа — относительно поддерева (внешний конец)."""
    subtree = tree.collect_subtree_ids_db(db, node_id)
    edges = (
        db.query(Edge)
        .filter(Edge.source_id.in_(subtree) | Edge.target_id.in_(subtree))
        .all()
    )
    names = {n.id: n.name for n in db.query(Node).filter(Node.project_id == project_id).all()}

    result: list[NodeEdgeInfo] = []
    for e in edges:
        s_in = e.source_id in subtree
        t_in = e.target_id in subtree
        if s_in == t_in:
            # Оба конца внутри поддерева (внутренняя связь) — не показываем
            continue
        outgoing = s_in  # источник в поддереве → связь уходит наружу
        other_id = e.target_id if outgoing else e.source_id
        result.append(
            NodeEdgeInfo(
                id=e.id,
                label=e.label,
                technology=e.technology,
                direction="outgoing" if outgoing else "incoming",
                other_node_id=other_id,
                other_node_name=names.get(other_id, "неизвестный узел"),
            )
        )
    return result
