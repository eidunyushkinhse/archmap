import uuid
from collections import Counter

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import restore, tree
from app.auth import get_current_user, require_architect
from app.database import get_db, upsert
from app.deps import get_current_project, scoped_edge, scoped_node, touch_project
from app.models.edge import Edge
from app.models.edge_waypoint import EdgeWaypoint
from app.models.ghost_edge_handle import GhostEdgeHandle
from app.models.ghost_position import GhostPosition
from app.models.node import Node
from app.models.project import Project
from app.models.user import User
from app.schemas.edge import Point
from app.schemas.node import (
    AlertsResponse,
    ContextEdgeResponse,
    DisconnectedNodeAlert,
    EdgeWaypointsUpdate,
    GhostEdgeHandleUpdate,
    GhostNodeResponse,
    GhostPositionUpdate,
    GraphEdgeResponse,
    GraphResponse,
    IntermediateEdgeAlert,
    IsolatedGroupAlert,
    LevelWaypoints,
    NodeContextResponse,
    NodeCreate,
    NodeEdgeInfo,
    NodeResponse,
    NodeUpdate,
    PosXY,
)
from app.schemas.restore import DeletionSnapshot

router = APIRouter(prefix="/nodes", tags=["nodes"])


def _mark_has_children(db: Session, nodes: list[Node]) -> None:
    """Проставляет вычисляемые child_count и has_children для отдачи в NodeResponse.
    Один запрос на весь список: считаем число прямых детей по каждому id."""
    if not nodes:
        return
    ids = [n.id for n in nodes]
    counts = dict(
        db.query(Node.parent_id, func.count(Node.id))
        .filter(Node.parent_id.in_(ids))
        .group_by(Node.parent_id)
        .all()
    )
    for n in nodes:
        n.child_count = counts.get(n.id, 0)
        n.has_children = n.child_count > 0


def _build_graph(
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
                source_handle=edge.source_handle,
                target_handle=edge.target_handle,
                waypoints=edge.waypoints,
                label_t=edge.label_t,
            )
        )
        for nid in (edge.source_id, edge.target_id):
            if nid not in local_ids:
                endpoint_ids.add(nid)

    # Пер-уровневый слой раскладки: ВСЕ строки контейнера как есть. Прежний фильтр
    # valid_keys (перебор допустимых проекций) не нужен: какая проекция показана —
    # решает фронт, а строки «не показанных сейчас» проекций безвредны по построению
    # (позиции ищутся по id отображаемой сущности, хэндлы — по префиксу). Инвариант
    # F6а сохраняется: ЧТЕНИЕ НЕ ПИШЕТ В БД, семантически устаревшие строки живут
    # (при возврате проекции координаты воскресают), реальных сирот снёс БД-каскад.
    level_positions: dict[str, PosXY] = {}
    level_edge_handles: dict[str, list[str]] = {}
    level_edge_waypoints: dict[str, LevelWaypoints] = {}
    if container_id is not None:
        for r in (
            db.query(GhostPosition)
            .filter(GhostPosition.container_id == container_id)
            .all()
        ):
            level_positions[str(r.node_id)] = PosXY(pos_x=r.pos_x, pos_y=r.pos_y)

        for r in (
            db.query(GhostEdgeHandle)
            .filter(GhostEdgeHandle.container_id == container_id)
            .all()
        ):
            level_edge_handles.setdefault(str(r.edge_id), []).append(r.handle)

        for r in (
            db.query(EdgeWaypoint)
            .filter(EdgeWaypoint.container_id == container_id)
            .all()
        ):
            if r.waypoints:
                level_edge_waypoints[str(r.edge_id)] = LevelWaypoints(
                    waypoints=[Point(x=p["x"], y=p["y"]) for p in r.waypoints],
                    anchor_node_id=r.anchor_node_id,
                )

    # Число прямых детей у каждого родителя — одним проходом по всем узлам.
    # Питает бейдж «есть дети (N)» и кнопку «Войти» и у концов-реестра, и у локалов.
    child_counts = Counter(n.parent_id for n in all_nodes.values() if n.parent_id is not None)
    # Реестр не-локальных концов рёбер (сортировка по id — детерминизм ответа).
    endpoints = [
        GhostNodeResponse(
            id=all_nodes[nid].id,
            name=all_nodes[nid].name,
            role=all_nodes[nid].role,
            technology=all_nodes[nid].technology,
            is_external=all_nodes[nid].is_external,
            shape=all_nodes[nid].shape,
            status=all_nodes[nid].status,
            node_depth=tree.node_depth(all_nodes, nid),
            has_children=child_counts.get(nid, 0) > 0,
            child_count=child_counts.get(nid, 0),
            ancestors=tree.ancestors(all_nodes, nid),
        )
        for nid in sorted(endpoint_ids, key=str)
        if nid in all_nodes
    ]
    # child_count/has_children локальных узлов — из того же Counter
    # (карта всех узлов уже в памяти; отдельный SQL _mark_has_children здесь лишний).
    for n in local_nodes:
        n.child_count = child_counts.get(n.id, 0)
        n.has_children = n.child_count > 0
    return GraphResponse(
        nodes=local_nodes,
        edges=result_edges,
        endpoints=endpoints,
        level_positions=level_positions,
        level_edge_handles=level_edge_handles,
        level_edge_waypoints=level_edge_waypoints,
    )


@router.get("/", response_model=list[NodeResponse])
def list_nodes(
    parent_id: uuid.UUID | None = None,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> list[Node]:
    nodes = (
        db.query(Node)
        .filter(Node.project_id == project.id, Node.parent_id == parent_id)
        .all()
    )
    _mark_has_children(db, nodes)
    return nodes


@router.post("/", response_model=NodeResponse, status_code=status.HTTP_201_CREATED)
def create_node(
    payload: NodeCreate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> Node:
    if payload.parent_id:
        parent = scoped_node(db, payload.parent_id, project)
        if not parent:
            raise HTTPException(status_code=404, detail="Родительский узел не найден")
    # project_id проставляем сервером из текущего проекта (клиент его в теле не шлёт).
    node = Node(**payload.model_dump(), project_id=project.id)
    db.add(node)
    touch_project(db, project, user.id)
    db.commit()
    db.refresh(node)
    _mark_has_children(db, [node])  # только что создан — детей нет, но для единообразия
    return node


@router.post("/restore", status_code=status.HTTP_204_NO_CONTENT)
def restore_nodes(
    snapshot: DeletionSnapshot,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> None:
    """Восстановить удалённое поддерево из снимка (Undo удаления).

    Снимок берётся клиентом через GET /{node_id}/deletion-snapshot (удаление узла) или
    GET /edges/{edge_id}/deletion-snapshot (удаление/создание связи) ДО удаления.
    Снимок может быть узловым (поддерево) ИЛИ чисто рёберным (nodes=[]) — обе формы
    восстанавливаются одним путём с сохранением исходных id.
    """
    ids = {n.id for n in snapshot.nodes}
    edge_ids = {e.id for e in snapshot.edges}
    if not ids and not edge_ids:
        raise HTTPException(status_code=400, detail="Пустой снимок")
    # Сущности не должны уже существовать (двойной restore) — иначе это не «откат удаления».
    if ids and db.query(Node.id).filter(Node.id.in_(ids)).first():
        raise HTTPException(status_code=409, detail="Узлы уже существуют — нечего восстанавливать")
    if edge_ids and db.query(Edge.id).filter(Edge.id.in_(edge_ids)).first():
        raise HTTPException(status_code=409, detail="Связи уже существуют — нечего восстанавливать")
    # Родитель корня поддерева (вне снимка) должен уцелеть, иначе FK не пройдёт.
    ext_parents = {
        n.parent_id for n in snapshot.nodes if n.parent_id is not None and n.parent_id not in ids
    }
    for pid in ext_parents:
        # Родитель должен уцелеть И принадлежать текущему проекту (нельзя восстановить
        # поддерево «в чужой» проект).
        if not scoped_node(db, pid, project):
            raise HTTPException(
                status_code=409, detail="Родитель удалённого узла больше не существует"
            )
    # Восстанавливаем в текущий проект: всем воссоздаваемым узлам/связям проставляем project_id.
    restore.restore_from_snapshot(db, snapshot, project_id=project.id)
    touch_project(db, project, user.id)
    db.commit()


# Эти маршруты должны быть до /{node_id}, иначе FastAPI не доберётся до них
@router.get("/search", response_model=list[NodeResponse])
def search_nodes(
    q: str = "",
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> list[Node]:
    if not q.strip():
        return []
    nodes = (
        db.query(Node)
        .filter(Node.project_id == project.id, Node.name.ilike(f"%{q}%"))
        .limit(20)
        .all()
    )
    _mark_has_children(db, nodes)
    return nodes


@router.get("/all", response_model=list[NodeResponse])
def list_all_nodes(
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> list[Node]:
    """Плоский список ВСЕХ узлов схемы — для выбора дальнего конца связи к узлу
    вне текущего уровня (фронт собирает из него дерево по parent_id)."""
    nodes = db.query(Node).filter(Node.project_id == project.id).all()
    _mark_has_children(db, nodes)
    return nodes


@router.get("/graph", response_model=GraphResponse)
def get_root_graph(
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> GraphResponse:
    """Граф корневого уровня: узлы без родителя + сквозные рёбра."""
    local_nodes = (
        db.query(Node)
        .filter(Node.project_id == project.id, Node.parent_id.is_(None))
        .all()
    )
    if not local_nodes:
        return GraphResponse(nodes=[], edges=[], endpoints=[])
    all_nodes = {n.id: n for n in db.query(Node).filter(Node.project_id == project.id).all()}
    all_edges = db.query(Edge).filter(Edge.project_id == project.id).all()
    return _build_graph(local_nodes, None, all_nodes, all_edges, db)


# Должен быть объявлен до /{node_id}, иначе FastAPI примет "alerts" за node_id
@router.get("/alerts", response_model=AlertsResponse)
def get_alerts(
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_architect),
) -> AlertsResponse:
    """Глобальные алерты незавершённости схемы (только архитектор):
    1) атомарные (листовые) узлы без единой связи — «подвисшие»;
    2) связи, у которых хотя бы один конец упирается в промежуточный
       (контейнерный) узел, а не в атомарный.
    Контейнеры в проверке (1) не участвуют: прямых связей у них быть не должно
    (это как раз ловит проверка 2), а группировку детей за «подвисание» не считаем.
    """
    all_nodes = db.query(Node).filter(Node.project_id == project.id).all()
    all_edges = db.query(Edge).filter(Edge.project_id == project.id).all()
    name_by_id = {n.id: n.name for n in all_nodes}

    # Промежуточные узлы = те, что являются чьим-то родителем (есть дети)
    intermediate_ids = {
        pid
        for (pid,) in db.query(Node.parent_id)
        .filter(Node.project_id == project.id, Node.parent_id.isnot(None))
        .distinct()
        .all()
    }

    # Узлы, у которых есть хоть одна связь (по сырым концам рёбер)
    connected_ids: set[uuid.UUID] = set()
    for e in all_edges:
        connected_ids.add(e.source_id)
        connected_ids.add(e.target_id)

    disconnected = [
        DisconnectedNodeAlert(node_id=n.id, node_name=n.name)
        for n in all_nodes
        if n.id not in intermediate_ids and n.id not in connected_ids
    ]

    intermediate_edges: list[IntermediateEdgeAlert] = []
    for e in all_edges:
        src_inter = e.source_id in intermediate_ids
        tgt_inter = e.target_id in intermediate_ids
        if src_inter or tgt_inter:
            intermediate_edges.append(
                IntermediateEdgeAlert(
                    edge_id=e.id,
                    label=e.label,
                    source_id=e.source_id,
                    source_name=name_by_id.get(e.source_id, "?"),
                    target_id=e.target_id,
                    target_name=name_by_id.get(e.target_id, "?"),
                    source_is_intermediate=src_inter,
                    target_is_intermediate=tgt_inter,
                )
            )

    # 3) Изолированные группы — связные компоненты графа РЁБЕР (иерархию
    #    parent_id игнорируем: иначе всё связано через дерево). Узлы без
    #    единой связи сюда не попадают (их ловит проверка 1). Алерт зажигаем,
    #    только если связных групп (≥2 узла) больше одной — иначе это просто
    #    единственный кластер плюс висячие узлы, и фрагментации нет.
    adjacency: dict[uuid.UUID, set[uuid.UUID]] = {}
    for e in all_edges:
        adjacency.setdefault(e.source_id, set()).add(e.target_id)
        adjacency.setdefault(e.target_id, set()).add(e.source_id)

    visited: set[uuid.UUID] = set()
    components: list[list[uuid.UUID]] = []
    for start in adjacency:
        if start in visited:
            continue
        stack = [start]
        visited.add(start)
        comp: list[uuid.UUID] = []
        while stack:
            cur = stack.pop()
            comp.append(cur)
            for nxt in adjacency[cur]:
                if nxt not in visited:
                    visited.add(nxt)
                    stack.append(nxt)
        if len(comp) >= 2:
            components.append(comp)

    isolated_groups: list[IsolatedGroupAlert] = []
    if len(components) >= 2:
        for comp in components:
            isolated_groups.append(
                IsolatedGroupAlert(
                    node_ids=comp,
                    node_names=[name_by_id.get(nid, "?") for nid in comp],
                )
            )

    return AlertsResponse(
        disconnected_nodes=disconnected,
        intermediate_edges=intermediate_edges,
        isolated_groups=isolated_groups,
    )


@router.get("/{node_id}", response_model=NodeResponse)
def get_node(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> Node:
    node = scoped_node(db, node_id, project)
    if not node:
        raise HTTPException(status_code=404, detail="Узел не найден")
    _mark_has_children(db, [node])
    return node


@router.patch("/{node_id}", response_model=NodeResponse)
def update_node(
    node_id: uuid.UUID,
    payload: NodeUpdate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> Node:
    node = scoped_node(db, node_id, project)
    if not node:
        raise HTTPException(status_code=404, detail="Узел не найден")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(node, field, value)
    touch_project(db, project, user.id)
    db.commit()
    db.refresh(node)
    _mark_has_children(db, [node])
    return node


@router.get("/{node_id}/deletion-snapshot", response_model=DeletionSnapshot)
def get_deletion_snapshot(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_architect),
) -> DeletionSnapshot:
    """Снимок всего, что снесёт удаление узла (поддерево + рёбра + ghost-метаданные).

    Клиент берёт его ПЕРЕД delete, чтобы потом восстановить через POST /restore (Undo).
    """
    if not scoped_node(db, node_id, project):
        raise HTTPException(status_code=404, detail="Узел не найден")
    return restore.build_deletion_snapshot(db, node_id)


@router.delete("/{node_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_node(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> None:
    node = scoped_node(db, node_id, project)
    if not node:
        raise HTTPException(status_code=404, detail="Узел не найден")
    # Удаляем узел со всем поддеревом (потомки любой глубины), их рёбрами (исходящими,
    # входящими — в т.ч. снаружи) и ghost-метаданными. Всё это делает БД-каскад
    # (ondelete="CASCADE" на parent_id, source_id/target_id, ghost-FK), а passive_deletes
    # на связях Node не даёт ORM лезть в эти строки в Python (раньше из-за этого падал
    # IntegrityError, отсюда и был bulk-костыль). Достаточно одного db.delete.
    touch_project(db, project, user.id)
    db.delete(node)
    db.commit()


@router.get("/{node_id}/children", response_model=list[NodeResponse])
def get_children(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> list[Node]:
    node = scoped_node(db, node_id, project)
    if not node:
        raise HTTPException(status_code=404, detail="Узел не найден")
    children = db.query(Node).filter(Node.parent_id == node_id).all()
    _mark_has_children(db, children)
    return children


@router.get("/{node_id}/descendants", response_model=list[NodeResponse])
def get_descendants(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> list[Node]:
    """Все потомки узла на любой глубине (без самого узла) — для скоупленного
    выбора дальнего конца межуровневой связи: тянешь стрелку на узел-контейнер,
    поиск идёт только по его поддереву."""
    node = scoped_node(db, node_id, project)
    if not node:
        raise HTTPException(status_code=404, detail="Узел не найден")
    subtree_ids = tree.collect_subtree_ids_db(db, node_id) - {node_id}
    if not subtree_ids:
        return []
    descendants = db.query(Node).filter(Node.id.in_(subtree_ids)).all()
    _mark_has_children(db, descendants)
    return descendants


@router.get("/{node_id}/edges", response_model=list[NodeEdgeInfo])
def get_node_edges(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> list[NodeEdgeInfo]:
    """Внешние связи поддерева узла (он сам + потомки любой глубины) — те, что
    исчезнут при удалении узла: ровно один конец внутри поддерева, другой снаружи.
    Для предупреждения перед удалением. Чисто внутренние связи ветки не включаем —
    они уходят вместе с самой веткой и «потерей связи наружу» не являются.
    Направление/имя соседа считаются относительно поддерева (внешний конец)."""
    node = scoped_node(db, node_id, project)
    if not node:
        raise HTTPException(status_code=404, detail="Узел не найден")

    subtree = tree.collect_subtree_ids_db(db, node_id)
    edges = (
        db.query(Edge)
        .filter(Edge.source_id.in_(subtree) | Edge.target_id.in_(subtree))
        .all()
    )
    names = {n.id: n.name for n in db.query(Node).filter(Node.project_id == project.id).all()}

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


@router.get("/{node_id}/graph", response_model=GraphResponse)
def get_node_graph(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> GraphResponse:
    """Граф для уровня node_id: дочерние узлы + рёбра + гостевые узлы из других уровней."""
    parent = scoped_node(db, node_id, project)
    if not parent:
        raise HTTPException(status_code=404, detail="Узел не найден")

    local_nodes = db.query(Node).filter(Node.parent_id == node_id).all()
    if not local_nodes:
        return GraphResponse(nodes=[], edges=[], endpoints=[])

    all_nodes = {n.id: n for n in db.query(Node).filter(Node.project_id == project.id).all()}
    all_edges = db.query(Edge).filter(Edge.project_id == project.id).all()
    return _build_graph(local_nodes, node_id, all_nodes, all_edges, db)


@router.get("/{node_id}/context", response_model=NodeContextResponse)
def get_node_context(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> NodeContextResponse:
    """Контекстная схема узла: сам узел + его прямые соседи.
    Сосед — другой конец связи, у которой ровно один конец лежит в поддереве
    фокуса (сам узел ИЛИ любой его потомок на любой глубине). Конец внутри
    поддерева проецируется на фокус, внешний конец — это узел-сосед.
    """
    focus = scoped_node(db, node_id, project)
    if not focus:
        raise HTTPException(status_code=404, detail="Узел не найден")

    all_nodes = {n.id: n for n in db.query(Node).filter(Node.project_id == project.id).all()}
    all_edges = db.query(Edge).filter(Edge.project_id == project.id).all()

    # Поддерево фокуса = он сам + все потомки (карта всех узлов уже на руках).
    subtree = tree.subtree_ids(all_nodes, focus.id)

    result_edges: list[ContextEdgeResponse] = []
    neighbor_ids: set[uuid.UUID] = set()
    for e in all_edges:
        s_in = e.source_id in subtree
        t_in = e.target_id in subtree
        # Оба внутри (внутренняя связь ветки) или оба снаружи — не наш случай
        if s_in == t_in:
            continue
        if s_in:
            neigh = e.target_id
            src, tgt = focus.id, neigh
        else:
            neigh = e.source_id
            src, tgt = neigh, focus.id
        if neigh not in all_nodes:
            continue
        neighbor_ids.add(neigh)
        # Контекст остаётся серверной проекцией (Д5 аудита): концы уже свёрнуты на
        # фокус/соседа. waypoints/label_t сознательно НЕ отдаются — раскладка звезды
        # эфемерна и живёт в своей системе координат.
        result_edges.append(
            ContextEdgeResponse(
                id=e.id,
                label=e.label,
                technology=e.technology,
                source_id=src,
                target_id=tgt,
                original_source_id=e.source_id,
                original_target_id=e.target_id,
                original_source_name=all_nodes[e.source_id].name,
                original_target_name=all_nodes[e.target_id].name,
                source_handle=e.source_handle,
                target_handle=e.target_handle,
            )
        )

    neighbors = [
        GhostNodeResponse(
            id=all_nodes[nid].id,
            name=all_nodes[nid].name,
            role=all_nodes[nid].role,
            technology=all_nodes[nid].technology,
            is_external=all_nodes[nid].is_external,
            shape=all_nodes[nid].shape,
            status=all_nodes[nid].status,
            node_depth=tree.node_depth(all_nodes, nid),
            ancestors=tree.ancestors(all_nodes, nid),
        )
        for nid in sorted(neighbor_ids, key=str)
    ]
    # has_children фокуса — по карте всех узлов, без отдельного SQL.
    focus.child_count = sum(1 for n in all_nodes.values() if n.parent_id == focus.id)
    focus.has_children = focus.child_count > 0
    return NodeContextResponse(
        focus=focus,
        focus_ancestors=tree.ancestors(all_nodes, focus.id),
        neighbors=neighbors,
        edges=result_edges,
    )


@router.put(
    "/{container_id}/ghost-positions/{node_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def save_ghost_position(
    container_id: uuid.UUID,
    node_id: uuid.UUID,
    payload: GhostPositionUpdate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_architect),
) -> None:
    """Сохраняет (upsert) координаты гостевого узла node_id на уровне container_id."""
    if not scoped_node(db, container_id, project):
        raise HTTPException(status_code=404, detail="Уровень не найден")
    if not scoped_node(db, node_id, project):
        raise HTTPException(status_code=404, detail="Узел не найден")

    upsert(
        db,
        GhostPosition,
        keys={"container_id": container_id, "node_id": node_id},
        values={"pos_x": payload.pos_x, "pos_y": payload.pos_y},
    )
    db.commit()


@router.put(
    "/{container_id}/ghost-edge-handles/{edge_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def save_ghost_edge_handle(
    container_id: uuid.UUID,
    edge_id: uuid.UUID,
    payload: GhostEdgeHandleUpdate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_architect),
) -> None:
    """Сохраняет (upsert) хэндл гостевого конца ребра edge_id на уровне container_id,
    привязанный к id отображаемой сущности node_id (лист-гость ИЛИ предок-контейнер).

    У каждой проекции гостевого конца своя строка — поэтому привязка к свёрнутому
    контейнеру и к развёрнутому листу хранятся раздельно и не затирают друг друга.
    """
    if not scoped_node(db, container_id, project):
        raise HTTPException(status_code=404, detail="Уровень не найден")
    if not scoped_edge(db, edge_id, project):
        raise HTTPException(status_code=404, detail="Связь не найдена")
    if not scoped_node(db, payload.node_id, project):
        raise HTTPException(status_code=404, detail="Узел не найден")

    upsert(
        db,
        GhostEdgeHandle,
        keys={
            "container_id": container_id,
            "edge_id": edge_id,
            "node_id": payload.node_id,
        },
        values={"handle": payload.handle},
    )
    db.commit()


@router.put(
    "/{container_id}/edge-waypoints/{edge_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def save_edge_waypoints(
    container_id: uuid.UUID,
    edge_id: uuid.UUID,
    payload: EdgeWaypointsUpdate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_architect),
) -> None:
    """Сохраняет (upsert) кастомный путь ГОСТЕВОЙ стрелки edge_id на уровне container_id.

    Пустой список waypoints — сброс в авто-маршрут: строку пер-уровневого слоя удаляем
    (нет строки = авто). Путь локальной стрелки сюда не пишется — он в колонке ребра.
    """
    if not scoped_node(db, container_id, project):
        raise HTTPException(status_code=404, detail="Уровень не найден")
    if not scoped_edge(db, edge_id, project):
        raise HTTPException(status_code=404, detail="Связь не найдена")

    data = [{"x": p.x, "y": p.y} for p in payload.waypoints]
    if not data:
        # Сброс в авто-маршрут — это удаление строки (нет строки = авто), не апсерт:
        # находим существующую строку и убираем её.
        row = (
            db.query(EdgeWaypoint)
            .filter(
                EdgeWaypoint.container_id == container_id,
                EdgeWaypoint.edge_id == edge_id,
            )
            .one_or_none()
        )
        if row is not None:
            db.delete(row)
    else:
        upsert(
            db,
            EdgeWaypoint,
            keys={"container_id": container_id, "edge_id": edge_id},
            values={"waypoints": data, "anchor_node_id": payload.anchor_node_id},
        )
    db.commit()


def _clear_level_layout(
    db: Session, container_id: uuid.UUID | None, project: Project
) -> None:
    """Сбрасывает ВЕСЬ ручной layout уровня в авто (own-on-first-render, Ф2):
    позиции локальных узлов уровня → null (dagre разложит заново), а также гостевые
    позиции, хэндлы гостевых концов и изломы стрелок этого уровня. После сброса уровень
    выглядит как при первом открытии (dagre + кольца + авто-маршруты).

    Для корня (container_id=None) гостей/хэндлов/изломов не бывает (их таблицы скоупятся
    not-null container_id) — чистим только позиции корневых узлов (parent_id IS NULL).
    """
    # Позиции локальных узлов уровня (прямые дети контейнера) → авто.
    parent_filter = (
        Node.parent_id.is_(None) if container_id is None else Node.parent_id == container_id
    )
    db.query(Node).filter(parent_filter, Node.project_id == project.id).update(
        {Node.pos_x: None, Node.pos_y: None}, synchronize_session=False
    )
    if container_id is not None:
        # Гостевой пер-уровневый слой скоупится container_id — сносим строки целиком.
        db.query(GhostPosition).filter(
            GhostPosition.container_id == container_id
        ).delete(synchronize_session=False)
        db.query(GhostEdgeHandle).filter(
            GhostEdgeHandle.container_id == container_id
        ).delete(synchronize_session=False)
        db.query(EdgeWaypoint).filter(
            EdgeWaypoint.container_id == container_id
        ).delete(synchronize_session=False)
    db.commit()


@router.post("/relayout", status_code=status.HTTP_204_NO_CONTENT)
def relayout_root_level(
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_architect),
) -> None:
    """«Переразложить» корневой уровень: позиции корневых узлов → авто (dagre)."""
    _clear_level_layout(db, None, project)


@router.post(
    "/{container_id}/relayout",
    status_code=status.HTTP_204_NO_CONTENT,
)
def relayout_level(
    container_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_architect),
) -> None:
    """«Переразложить уровень»: весь ручной layout уровня container_id → авто."""
    if not scoped_node(db, container_id, project):
        raise HTTPException(status_code=404, detail="Уровень не найден")
    _clear_level_layout(db, container_id, project)
