import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import restore, tree
from app.auth import get_current_user, require_architect
from app.database import get_db, upsert
from app.models.edge import Edge
from app.models.edge_waypoint import EdgeWaypoint
from app.models.ghost_edge_handle import GhostEdgeHandle
from app.models.ghost_position import GhostPosition
from app.models.node import Node
from app.models.user import User
from app.schemas.edge import Point
from app.schemas.node import (
    AlertsResponse,
    DisconnectedNodeAlert,
    EdgeWaypointsUpdate,
    GhostEdgeHandleUpdate,
    GhostNodeResponse,
    GhostPositionUpdate,
    GraphEdgeResponse,
    GraphResponse,
    IntermediateEdgeAlert,
    IsolatedGroupAlert,
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
    """Строит граф уровня: проецирует сквозные рёбра, собирает гостевые узлы."""
    local_ids: set[uuid.UUID] = {n.id for n in local_nodes}

    def find_effective(start_id: uuid.UUID) -> tuple[uuid.UUID | None, bool]:
        """
        Возвращает (effective_id, is_ghost):
        - effective_id — ближайший предок из local_ids или сам узел, если он внешний.
        - is_ghost=True означает, что узел внешний для данного уровня.
        """
        current_id: uuid.UUID | None = start_id
        while current_id is not None:
            if current_id in local_ids:
                return current_id, False
            if current_id == container_id:
                return None, False
            node = all_nodes.get(current_id)
            if node is None:
                return None, False
            current_id = node.parent_id
        return start_id, True

    result_edges: list[GraphEdgeResponse] = []
    ghost_ids: set[uuid.UUID] = set()
    # Какие концы каждого отображаемого ребра спроецированы на гостя (edge_id →
    # (src_ghost, tgt_ghost)) — по этому ниже накатываем сохранённые per-level хэндлы.
    edge_ghost_ends: dict[uuid.UUID, tuple[bool, bool]] = {}

    for edge in all_edges:
        eff_src, src_ghost = find_effective(edge.source_id)
        eff_tgt, tgt_ghost = find_effective(edge.target_id)

        if eff_src is None or eff_tgt is None:
            continue
        if eff_src not in local_ids and eff_tgt not in local_ids:
            continue
        if eff_src == eff_tgt:
            continue

        result_edges.append(
            GraphEdgeResponse(
                id=edge.id,
                label=edge.label,
                technology=edge.technology,
                source_id=eff_src,
                target_id=eff_tgt,
                original_source_id=edge.source_id,
                original_target_id=edge.target_id,
                original_source_name=all_nodes[edge.source_id].name,
                original_target_name=all_nodes[edge.target_id].name,
                source_handle=edge.source_handle,
                target_handle=edge.target_handle,
                waypoints=edge.waypoints,
                label_t=edge.label_t,
            )
        )
        edge_ghost_ends[edge.id] = (src_ghost, tgt_ghost)
        if src_ghost:
            ghost_ids.add(eff_src)
        if tgt_ghost:
            ghost_ids.add(eff_tgt)

    # Сохранённые координаты гостей на этом уровне.
    # Гости бывают только на не-корневых уровнях (container_id не None).
    #
    # Гость может рисоваться не сам по себе, а свёрнутым в предка-контейнер
    # (напр. сосед Account Synchronizer показывается как контейнер User Management).
    # Контейнером служит любой предок гостя НИЖЕ общей с уровнем рамки, а какой
    # именно — зависит от expand/collapse-состояния, известного только фронту.
    # Поэтому валидным ключом позиции считаем сам id гостя ИЛИ id любого такого
    # предка-кандидата. Общую рамку отсекаем по цепочке предков самого уровня.
    level_positions: dict[str, PosXY] = {}
    level_edge_handles: dict[str, list[str]] = {}
    level_edge_waypoints: dict[str, list[Point]] = {}
    saved_pos: dict[uuid.UUID, GhostPosition] = {}
    if container_id is not None:
        breadcrumb_ids = {a.id for a in tree.ancestors(all_nodes, container_id)} | {container_id}
        valid_keys: set[uuid.UUID] = set(ghost_ids)
        for gid in ghost_ids:
            for a in tree.ancestors(all_nodes, gid):
                if a.id not in breadcrumb_ids:
                    valid_keys.add(a.id)

        rows = (
            db.query(GhostPosition)
            .filter(GhostPosition.container_id == container_id)
            .all()
        )
        # ЧТЕНИЕ НЕ ПИШЕТ В БД (F6а): строки с node_id вне valid_keys просто не отдаём
        # фронту. Удалять их на чтении нельзя (GET мутировал бы БД — ломает кэш/реплики
        # и сносил бы сохранённую раскладку). Реальные сироты (удалён узел/контейнер)
        # уже снесены БД-каскадом (ondelete=CASCADE). «Семантически устаревшие» строки
        # (узел жив, но сейчас не проецируется на этот уровень) безвредны и сохраняются
        # намеренно: при возврате проекции (правка топологии/раскрытие) координаты воскресают.
        for r in rows:
            if r.node_id in valid_keys:
                level_positions[str(r.node_id)] = PosXY(
                    pos_x=r.pos_x, pos_y=r.pos_y, anchor_rel=r.anchor_rel
                )
                if r.node_id in ghost_ids:
                    saved_pos[r.node_id] = r

        # Per-level хэндлы гостевых концов рёбер. Привязка стрелки к точке гостя
        # переживает reload (фронт больше не назначает её автоматически). Строка
        # валидна, если ребро проецируется гостевым концом на этот уровень И node_id —
        # допустимая проекция (тот же valid_keys, что у координат: сам гость ИЛИ
        # предок-контейнер ниже общей с уровнем рамки). Колонка ребра хранит хэндл
        # «домашнего» (локального) конца — её не трогаем. Как и у координат выше —
        # чтение НЕ пишет в БД: невалидные строки не отдаём, но и не удаляем (F6а).
        ghost_edge_ids = {eid for eid, (s, t) in edge_ghost_ends.items() if s or t}
        handle_rows = (
            db.query(GhostEdgeHandle)
            .filter(GhostEdgeHandle.container_id == container_id)
            .all()
        )
        for r in handle_rows:
            if r.edge_id in ghost_edge_ids and r.node_id in valid_keys:
                level_edge_handles.setdefault(str(r.edge_id), []).append(r.handle)

        # Per-level пути (изломы) гостевых стрелок. Геометрия гостевой стрелки уникальна
        # для уровня (своя раскладка узлов + спроецированный гостевой конец), поэтому
        # путь хранится по (container_id, edge_id), а не в колонке ребра. Валидна строка,
        # если ребро проецируется гостевым концом на этот уровень (тот же ghost_edge_ids).
        # Чтение НЕ пишет в БД — невалидные строки просто не отдаём (как координаты/хэндлы).
        wp_rows = (
            db.query(EdgeWaypoint)
            .filter(EdgeWaypoint.container_id == container_id)
            .all()
        )
        for r in wp_rows:
            if r.edge_id in ghost_edge_ids and r.waypoints:
                level_edge_waypoints[str(r.edge_id)] = [
                    Point(x=p["x"], y=p["y"]) for p in r.waypoints
                ]

    # Множество id, у которых есть хотя бы один ребёнок — чтобы отметить «промежуточных»
    # гостей (есть слой компонентов) одним проходом по всем узлам, без запроса на гостя.
    parent_ids = {n.parent_id for n in all_nodes.values() if n.parent_id is not None}
    ghost_nodes = [
        GhostNodeResponse(
            id=all_nodes[gid].id,
            name=all_nodes[gid].name,
            role=all_nodes[gid].role,
            technology=all_nodes[gid].technology,
            is_external=all_nodes[gid].is_external,
            shape=all_nodes[gid].shape,
            node_depth=tree.node_depth(all_nodes, gid),
            has_children=gid in parent_ids,
            ancestors=tree.ancestors(all_nodes, gid),
            pos_x=saved_pos[gid].pos_x if gid in saved_pos else None,
            pos_y=saved_pos[gid].pos_y if gid in saved_pos else None,
        )
        for gid in ghost_ids
        if gid in all_nodes
    ]
    _mark_has_children(db, local_nodes)
    return GraphResponse(
        nodes=local_nodes,
        edges=result_edges,
        ghost_nodes=ghost_nodes,
        level_positions=level_positions,
        level_edge_handles=level_edge_handles,
        level_edge_waypoints=level_edge_waypoints,
    )


@router.get("/", response_model=list[NodeResponse])
def list_nodes(
    parent_id: uuid.UUID | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> list[Node]:
    nodes = db.query(Node).filter(Node.parent_id == parent_id).all()
    _mark_has_children(db, nodes)
    return nodes


@router.post("/", response_model=NodeResponse, status_code=status.HTTP_201_CREATED)
def create_node(
    payload: NodeCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_architect),
) -> Node:
    if payload.parent_id:
        parent = db.get(Node, payload.parent_id)
        if not parent:
            raise HTTPException(status_code=404, detail="Родительский узел не найден")
    node = Node(**payload.model_dump())
    db.add(node)
    db.commit()
    db.refresh(node)
    _mark_has_children(db, [node])  # только что создан — детей нет, но для единообразия
    return node


@router.post("/restore", status_code=status.HTTP_204_NO_CONTENT)
def restore_nodes(
    snapshot: DeletionSnapshot,
    db: Session = Depends(get_db),
    _: User = Depends(require_architect),
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
        if not db.get(Node, pid):
            raise HTTPException(
                status_code=409, detail="Родитель удалённого узла больше не существует"
            )
    restore.restore_from_snapshot(db, snapshot)


# Эти маршруты должны быть до /{node_id}, иначе FastAPI не доберётся до них
@router.get("/search", response_model=list[NodeResponse])
def search_nodes(
    q: str = "",
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> list[Node]:
    if not q.strip():
        return []
    nodes = db.query(Node).filter(Node.name.ilike(f"%{q}%")).limit(20).all()
    _mark_has_children(db, nodes)
    return nodes


@router.get("/all", response_model=list[NodeResponse])
def list_all_nodes(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> list[Node]:
    """Плоский список ВСЕХ узлов схемы — для выбора дальнего конца связи к узлу
    вне текущего уровня (фронт собирает из него дерево по parent_id)."""
    nodes = db.query(Node).all()
    _mark_has_children(db, nodes)
    return nodes


@router.get("/graph", response_model=GraphResponse)
def get_root_graph(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> GraphResponse:
    """Граф корневого уровня: узлы без родителя + сквозные рёбра."""
    local_nodes = db.query(Node).filter(Node.parent_id.is_(None)).all()
    if not local_nodes:
        return GraphResponse(nodes=[], edges=[], ghost_nodes=[])
    all_nodes = {n.id: n for n in db.query(Node).all()}
    all_edges = db.query(Edge).all()
    return _build_graph(local_nodes, None, all_nodes, all_edges, db)


# Должен быть объявлен до /{node_id}, иначе FastAPI примет "alerts" за node_id
@router.get("/alerts", response_model=AlertsResponse)
def get_alerts(
    db: Session = Depends(get_db),
    _: User = Depends(require_architect),
) -> AlertsResponse:
    """Глобальные алерты незавершённости схемы (только архитектор):
    1) атомарные (листовые) узлы без единой связи — «подвисшие»;
    2) связи, у которых хотя бы один конец упирается в промежуточный
       (контейнерный) узел, а не в атомарный.
    Контейнеры в проверке (1) не участвуют: прямых связей у них быть не должно
    (это как раз ловит проверка 2), а группировку детей за «подвисание» не считаем.
    """
    all_nodes = db.query(Node).all()
    all_edges = db.query(Edge).all()
    name_by_id = {n.id: n.name for n in all_nodes}

    # Промежуточные узлы = те, что являются чьим-то родителем (есть дети)
    intermediate_ids = {
        pid
        for (pid,) in db.query(Node.parent_id)
        .filter(Node.parent_id.isnot(None))
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
    _: User = Depends(get_current_user),
) -> Node:
    node = db.get(Node, node_id)
    if not node:
        raise HTTPException(status_code=404, detail="Узел не найден")
    _mark_has_children(db, [node])
    return node


@router.patch("/{node_id}", response_model=NodeResponse)
def update_node(
    node_id: uuid.UUID,
    payload: NodeUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_architect),
) -> Node:
    node = db.get(Node, node_id)
    if not node:
        raise HTTPException(status_code=404, detail="Узел не найден")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(node, field, value)
    db.commit()
    db.refresh(node)
    _mark_has_children(db, [node])
    return node


@router.get("/{node_id}/deletion-snapshot", response_model=DeletionSnapshot)
def get_deletion_snapshot(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require_architect),
) -> DeletionSnapshot:
    """Снимок всего, что снесёт удаление узла (поддерево + рёбра + ghost-метаданные).

    Клиент берёт его ПЕРЕД delete, чтобы потом восстановить через POST /restore (Undo).
    """
    if not db.get(Node, node_id):
        raise HTTPException(status_code=404, detail="Узел не найден")
    return restore.build_deletion_snapshot(db, node_id)


@router.delete("/{node_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_node(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require_architect),
) -> None:
    node = db.get(Node, node_id)
    if not node:
        raise HTTPException(status_code=404, detail="Узел не найден")
    # Удаляем узел со всем поддеревом (потомки любой глубины), их рёбрами (исходящими,
    # входящими — в т.ч. снаружи) и ghost-метаданными. Всё это делает БД-каскад
    # (ondelete="CASCADE" на parent_id, source_id/target_id, ghost-FK), а passive_deletes
    # на связях Node не даёт ORM лезть в эти строки в Python (раньше из-за этого падал
    # IntegrityError, отсюда и был bulk-костыль). Достаточно одного db.delete.
    db.delete(node)
    db.commit()


@router.get("/{node_id}/children", response_model=list[NodeResponse])
def get_children(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> list[Node]:
    node = db.get(Node, node_id)
    if not node:
        raise HTTPException(status_code=404, detail="Узел не найден")
    children = db.query(Node).filter(Node.parent_id == node_id).all()
    _mark_has_children(db, children)
    return children


@router.get("/{node_id}/descendants", response_model=list[NodeResponse])
def get_descendants(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> list[Node]:
    """Все потомки узла на любой глубине (без самого узла) — для скоупленного
    выбора дальнего конца межуровневой связи: тянешь стрелку на узел-контейнер,
    поиск идёт только по его поддереву."""
    node = db.get(Node, node_id)
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
    _: User = Depends(get_current_user),
) -> list[NodeEdgeInfo]:
    """Внешние связи поддерева узла (он сам + потомки любой глубины) — те, что
    исчезнут при удалении узла: ровно один конец внутри поддерева, другой снаружи.
    Для предупреждения перед удалением. Чисто внутренние связи ветки не включаем —
    они уходят вместе с самой веткой и «потерей связи наружу» не являются.
    Направление/имя соседа считаются относительно поддерева (внешний конец)."""
    node = db.get(Node, node_id)
    if not node:
        raise HTTPException(status_code=404, detail="Узел не найден")

    subtree = tree.collect_subtree_ids_db(db, node_id)
    edges = (
        db.query(Edge)
        .filter(Edge.source_id.in_(subtree) | Edge.target_id.in_(subtree))
        .all()
    )
    names = {n.id: n.name for n in db.query(Node).all()}

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
    _: User = Depends(get_current_user),
) -> GraphResponse:
    """Граф для уровня node_id: дочерние узлы + рёбра + гостевые узлы из других уровней."""
    parent = db.get(Node, node_id)
    if not parent:
        raise HTTPException(status_code=404, detail="Узел не найден")

    local_nodes = db.query(Node).filter(Node.parent_id == node_id).all()
    if not local_nodes:
        return GraphResponse(nodes=[], edges=[], ghost_nodes=[])

    all_nodes = {n.id: n for n in db.query(Node).all()}
    all_edges = db.query(Edge).all()
    return _build_graph(local_nodes, node_id, all_nodes, all_edges, db)


@router.get("/{node_id}/context", response_model=NodeContextResponse)
def get_node_context(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> NodeContextResponse:
    """Контекстная схема узла: сам узел + его прямые соседи.
    Сосед — другой конец связи, у которой ровно один конец лежит в поддереве
    фокуса (сам узел ИЛИ любой его потомок на любой глубине). Конец внутри
    поддерева проецируется на фокус, внешний конец — это узел-сосед.
    """
    focus = db.get(Node, node_id)
    if not focus:
        raise HTTPException(status_code=404, detail="Узел не найден")

    all_nodes = {n.id: n for n in db.query(Node).all()}
    all_edges = db.query(Edge).all()

    # Поддерево фокуса = он сам + все потомки (карта всех узлов уже на руках).
    subtree = tree.subtree_ids(all_nodes, focus.id)

    result_edges: list[GraphEdgeResponse] = []
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
        result_edges.append(
            GraphEdgeResponse(
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
            node_depth=tree.node_depth(all_nodes, nid),
            ancestors=tree.ancestors(all_nodes, nid),
            pos_x=None,
            pos_y=None,
        )
        for nid in neighbor_ids
    ]
    _mark_has_children(db, [focus])
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
    _: User = Depends(require_architect),
) -> None:
    """Сохраняет (upsert) координаты гостевого узла node_id на уровне container_id."""
    if not db.get(Node, container_id):
        raise HTTPException(status_code=404, detail="Уровень не найден")
    if not db.get(Node, node_id):
        raise HTTPException(status_code=404, detail="Узел не найден")

    upsert(
        db,
        GhostPosition,
        keys={"container_id": container_id, "node_id": node_id},
        values={"pos_x": payload.pos_x, "pos_y": payload.pos_y, "anchor_rel": payload.anchor_rel},
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
    _: User = Depends(require_architect),
) -> None:
    """Сохраняет (upsert) хэндл гостевого конца ребра edge_id на уровне container_id,
    привязанный к id отображаемой сущности node_id (лист-гость ИЛИ предок-контейнер).

    У каждой проекции гостевого конца своя строка — поэтому привязка к свёрнутому
    контейнеру и к развёрнутому листу хранятся раздельно и не затирают друг друга.
    """
    if not db.get(Node, container_id):
        raise HTTPException(status_code=404, detail="Уровень не найден")
    if not db.get(Edge, edge_id):
        raise HTTPException(status_code=404, detail="Связь не найдена")
    if not db.get(Node, payload.node_id):
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
    _: User = Depends(require_architect),
) -> None:
    """Сохраняет (upsert) кастомный путь ГОСТЕВОЙ стрелки edge_id на уровне container_id.

    Пустой список waypoints — сброс в авто-маршрут: строку пер-уровневого слоя удаляем
    (нет строки = авто). Путь локальной стрелки сюда не пишется — он в колонке ребра.
    """
    if not db.get(Node, container_id):
        raise HTTPException(status_code=404, detail="Уровень не найден")
    if not db.get(Edge, edge_id):
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
            values={"waypoints": data},
        )
    db.commit()
