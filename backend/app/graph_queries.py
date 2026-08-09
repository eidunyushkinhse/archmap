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
from typing import cast

from sqlalchemy.orm import Session

from app import tree
from app.models.edge import Edge
from app.models.node import Node
from app.models.view_layout import ViewLayoutItem
from app.schemas.node import (
    GhostNodeResponse,
    GraphEdgeResponse,
    GraphResponse,
    NodeResponse,
    NodeShape,
    NodeStatus,
    ViewLayoutPayload,
)


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
    db: Session, project_id: uuid.UUID, container_id: uuid.UUID | None
) -> dict[str, ViewLayoutPayload]:
    """Раскладка вида как есть: ВСЕ строки view_layout этого вида (у корня view IS
    NULL — позиции корневых узлов теперь тоже здесь). Строки «не показанных
    сейчас» проекций безвредны (какая проекция видна — решает фронт) и живут
    намеренно: при возврате проекции геометрия воскресает. Инвариант F6а —
    ЧТЕНИЕ НЕ ПИШЕТ В БД; реальных сирот чистят каскад view_id и delete_node."""
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
) -> list[GhostNodeResponse]:
    """Реестр не-локальных концов рёбер с цепочками предков (сортировка по id —
    детерминизм ответа). По нему фронтовая проекция поднимает конец к ближайшему
    видимому представителю и строит рамки/раскрытия."""
    return [
        GhostNodeResponse(
            id=all_nodes[nid].id,
            name=all_nodes[nid].name,
            role=all_nodes[nid].role,
            technology=all_nodes[nid].technology,
            is_external=all_nodes[nid].is_external,
            # shape/status — str в ORM-модели, но значение всегда из домена Literal
            # (контролируется схемой NodeCreate/NodeUpdate): безопасный cast.
            shape=cast(NodeShape, all_nodes[nid].shape),
            status=cast(NodeStatus, all_nodes[nid].status),
            node_depth=tree.node_depth(all_nodes, nid),
            has_children=child_counts.get(nid, 0) > 0,
            child_count=child_counts.get(nid, 0),
            ancestors=tree.ancestors(all_nodes, nid),
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
) -> GraphResponse:
    """Собирает СЫРОЙ граф уровня (R2 вид-центричного движка).

    Отдаёт: детей контейнера, рёбра, затрагивающие его поддерево (с РЕАЛЬНЫМИ
    концами), реестр не-локальных концов с цепочками предков и пер-уровневый слой
    раскладки. Проекцию концов на видимые сущности («подъём к ближайшему видимому
    представителю») делает фронтенд (graph/projection.ts) — она зависит от
    expand/collapse-состояния, известного только ему.
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
                source_id=edge.source_id,
                target_id=edge.target_id,
                version=edge.version,
            )
        )
        for nid in (edge.source_id, edge.target_id):
            if nid not in local_ids:
                endpoint_ids.add(nid)

    # Раскладка вида как есть (единый читатель read_view_layout).
    layout = read_view_layout(db, local_nodes[0].project_id, container_id)

    # Число прямых детей у каждого родителя — одним проходом по всем узлам.
    # Питает бейдж «есть дети (N)» и кнопку «Войти» и у концов-реестра, и у локалов.
    child_counts = Counter(n.parent_id for n in all_nodes.values() if n.parent_id is not None)
    # Реестр не-локальных концов рёбер (единый строитель ghost_registry).
    endpoints = ghost_registry(all_nodes, endpoint_ids, child_counts)
    # child_count/has_children локальных узлов — из того же Counter
    # (карта всех узлов уже в памяти; отдельный SQL _mark_has_children здесь лишний).
    for n in local_nodes:
        n.child_count = child_counts.get(n.id, 0)
        n.has_children = n.child_count > 0
    # ORM-узлы сериализуются в NodeResponse через from_attributes ( child_count/
    # has_children проставлены выше) — на границе сериализации типизируем как
    # list[NodeResponse].
    return GraphResponse(
        nodes=cast(list[NodeResponse], local_nodes),
        edges=result_edges,
        endpoints=endpoints,
        layout=layout,
        has_status_info=project_has_status_info(db, local_nodes[0].project_id),
    )
