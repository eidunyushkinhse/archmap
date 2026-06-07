import uuid
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth import get_current_user, require_architect
from app.database import get_db
from app.models.edge import Edge
from app.models.ghost_edge_handle import GhostEdgeHandle
from app.models.ghost_position import GhostPosition
from app.models.node import Node
from app.models.user import User
from app.schemas.node import (
    AlertsResponse,
    AncestorRef,
    DisconnectedNodeAlert,
    GraphEdgeResponse,
    GraphResponse,
    GhostEdgeHandleUpdate,
    GhostNodeResponse,
    GhostPositionUpdate,
    IntermediateEdgeAlert,
    NodeContextResponse,
    NodeCreate,
    NodeEdgeInfo,
    NodeResponse,
    PosXY,
    NodeUpdate,
)

router = APIRouter(prefix="/nodes", tags=["nodes"])


def _mark_has_children(db: Session, nodes: list[Node]) -> None:
    """Проставляет вычисляемый флаг has_children для отдачи в NodeResponse.
    Один запрос на весь список: ищем, у каких id есть дочерние узлы."""
    if not nodes:
        return
    ids = [n.id for n in nodes]
    parents_with_children = {
        pid
        for (pid,) in db.query(Node.parent_id)
        .filter(Node.parent_id.in_(ids))
        .distinct()
        .all()
    }
    for n in nodes:
        n.has_children = n.id in parents_with_children


def _collect_subtree_ids(db: Session, root_id: uuid.UUID) -> set[uuid.UUID]:
    """id всего поддерева: сам узел + все потомки на любой глубине.
    Обход по уровням через parent_id (один запрос на уровень)."""
    ids: set[uuid.UUID] = {root_id}
    frontier = [root_id]
    while frontier:
        kids = [
            kid
            for (kid,) in db.query(Node.id)
            .filter(Node.parent_id.in_(frontier))
            .all()
        ]
        kids = [k for k in kids if k not in ids]
        if not kids:
            break
        ids.update(kids)
        frontier = kids
    return ids


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
                source_handle=edge.source_handle,
                target_handle=edge.target_handle,
            )
        )
        edge_ghost_ends[edge.id] = (src_ghost, tgt_ghost)
        if src_ghost:
            ghost_ids.add(eff_src)
        if tgt_ghost:
            ghost_ids.add(eff_tgt)

    def node_depth(node_id: uuid.UUID) -> int:
        depth = 0
        current = all_nodes.get(node_id)
        while current and current.parent_id is not None:
            depth += 1
            current = all_nodes.get(current.parent_id)
        return depth

    def ancestors(node_id: uuid.UUID) -> list[AncestorRef]:
        """Цепочка предков узла, корень → непосредственный родитель."""
        chain: list[AncestorRef] = []
        current = all_nodes.get(node_id)
        parent_id = current.parent_id if current else None
        while parent_id is not None:
            parent = all_nodes.get(parent_id)
            if parent is None:
                break
            chain.append(AncestorRef(id=parent.id, name=parent.name))
            parent_id = parent.parent_id
        chain.reverse()  # корень → непосредственный родитель
        return chain

    # Сохранённые координаты гостей на этом уровне + уборка мусора.
    # Гости бывают только на не-корневых уровнях (container_id не None).
    #
    # Гость может рисоваться не сам по себе, а свёрнутым в предка-контейнер
    # (напр. сосед Account Synchronizer показывается как контейнер User Management).
    # Контейнером служит любой предок гостя НИЖЕ общей с уровнем рамки, а какой
    # именно — зависит от expand/collapse-состояния, известного только фронту.
    # Поэтому валидным ключом позиции считаем сам id гостя ИЛИ id любого такого
    # предка-кандидата. Общую рамку отсекаем по цепочке предков самого уровня.
    level_positions: dict[str, PosXY] = {}
    saved_pos: dict[uuid.UUID, GhostPosition] = {}
    if container_id is not None:
        breadcrumb_ids = {a.id for a in ancestors(container_id)} | {container_id}
        valid_keys: set[uuid.UUID] = set(ghost_ids)
        for gid in ghost_ids:
            for a in ancestors(gid):
                if a.id not in breadcrumb_ids:
                    valid_keys.add(a.id)

        rows = (
            db.query(GhostPosition)
            .filter(GhostPosition.container_id == container_id)
            .all()
        )
        stale = [r for r in rows if r.node_id not in valid_keys]
        # Проекция гостя на этот уровень исчезла — стираем его метаданные здесь
        for r in stale:
            db.delete(r)
        if stale:
            db.commit()
        for r in rows:
            if r.node_id in valid_keys:
                level_positions[str(r.node_id)] = PosXY(pos_x=r.pos_x, pos_y=r.pos_y)
                if r.node_id in ghost_ids:
                    saved_pos[r.node_id] = r

        # Per-level хэндлы гостевых концов рёбер + уборка мусора. Накатываем их
        # поверх колоночных хэндлов ребра для тех концов, что спроецированы на
        # гостя: ручная привязка стрелки к точке гостя переживает reload (фронт
        # больше не назначает их автоматически). Колонка ребра хранит хэндл
        # «домашнего» (локального) конца — её не трогаем.
        ghost_edge_ids = {eid for eid, (s, t) in edge_ghost_ends.items() if s or t}
        handle_rows = (
            db.query(GhostEdgeHandle)
            .filter(GhostEdgeHandle.container_id == container_id)
            .all()
        )
        # Ребро больше не проецируется гостевым концом на этот уровень — мусор
        stale_h = [r for r in handle_rows if r.edge_id not in ghost_edge_ids]
        for r in stale_h:
            db.delete(r)
        if stale_h:
            db.commit()
        handle_by_edge = {r.edge_id: r for r in handle_rows if r.edge_id in ghost_edge_ids}
        for e in result_edges:
            row = handle_by_edge.get(e.id)
            if row is None:
                continue
            src_ghost, tgt_ghost = edge_ghost_ends[e.id]
            if src_ghost and row.source_handle is not None:
                e.source_handle = row.source_handle
            if tgt_ghost and row.target_handle is not None:
                e.target_handle = row.target_handle

    ghost_nodes = [
        GhostNodeResponse(
            id=all_nodes[gid].id,
            name=all_nodes[gid].name,
            role=all_nodes[gid].role,
            technology=all_nodes[gid].technology,
            is_external=all_nodes[gid].is_external,
            shape=all_nodes[gid].shape,
            node_depth=node_depth(gid),
            ancestors=ancestors(gid),
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

    return AlertsResponse(
        disconnected_nodes=disconnected,
        intermediate_edges=intermediate_edges,
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


@router.delete("/{node_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_node(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require_architect),
) -> None:
    node = db.get(Node, node_id)
    if not node:
        raise HTTPException(status_code=404, detail="Узел не найден")
    # Удаляем узел вместе со всем поддеревом (дочерние узлы любой глубины) и
    # всеми их связями. Через ORM (db.delete) каскад на children пытается занулить
    # target_id входящих рёбер детей (incoming_edges без каскада, target_id NOT NULL)
    # → IntegrityError. Поэтому сносим bulk-запросами: сперва все рёбра, у которых
    # любой конец в поддереве, затем сами узлы поддерева.
    ids = _collect_subtree_ids(db, node_id)
    db.query(Edge).filter(
        Edge.source_id.in_(ids) | Edge.target_id.in_(ids)
    ).delete(synchronize_session=False)
    db.query(Node).filter(Node.id.in_(ids)).delete(synchronize_session=False)
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

    subtree = _collect_subtree_ids(db, node_id)
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

    # Карта детей для обхода поддерева
    children: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
    for n in all_nodes.values():
        if n.parent_id is not None:
            children[n.parent_id].append(n.id)

    # Поддерево фокуса = он сам + все потомки
    subtree: set[uuid.UUID] = set()
    stack = [focus.id]
    while stack:
        cur = stack.pop()
        if cur in subtree:
            continue
        subtree.add(cur)
        stack.extend(children.get(cur, []))

    def ancestors_of(nid: uuid.UUID) -> list[AncestorRef]:
        """Цепочка предков узла, корень → непосредственный родитель."""
        chain: list[AncestorRef] = []
        cur = all_nodes.get(nid)
        pid = cur.parent_id if cur else None
        while pid is not None:
            parent = all_nodes.get(pid)
            if parent is None:
                break
            chain.append(AncestorRef(id=parent.id, name=parent.name))
            pid = parent.parent_id
        chain.reverse()
        return chain

    def depth_of(nid: uuid.UUID) -> int:
        depth = 0
        cur = all_nodes.get(nid)
        while cur and cur.parent_id is not None:
            depth += 1
            cur = all_nodes.get(cur.parent_id)
        return depth

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
            node_depth=depth_of(nid),
            ancestors=ancestors_of(nid),
            pos_x=None,
            pos_y=None,
        )
        for nid in neighbor_ids
    ]
    _mark_has_children(db, [focus])
    return NodeContextResponse(
        focus=focus,
        focus_ancestors=ancestors_of(focus.id),
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

    row = (
        db.query(GhostPosition)
        .filter(
            GhostPosition.container_id == container_id,
            GhostPosition.node_id == node_id,
        )
        .one_or_none()
    )
    if row is None:
        row = GhostPosition(
            container_id=container_id,
            node_id=node_id,
            pos_x=payload.pos_x,
            pos_y=payload.pos_y,
        )
        db.add(row)
    else:
        row.pos_x = payload.pos_x
        row.pos_y = payload.pos_y
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
    """Сохраняет (upsert) хэндл гостевого конца ребра edge_id на уровне container_id.

    Передаётся только спроецированная на гостя сторона (source_handle ИЛИ
    target_handle); не указанная сторона не затрагивается — это позволяет
    хранить per-level хэндл гостевого конца, не трогая хэндл локального конца.
    """
    if not db.get(Node, container_id):
        raise HTTPException(status_code=404, detail="Уровень не найден")
    if not db.get(Edge, edge_id):
        raise HTTPException(status_code=404, detail="Связь не найдена")

    data = payload.model_dump(exclude_unset=True)
    row = (
        db.query(GhostEdgeHandle)
        .filter(
            GhostEdgeHandle.container_id == container_id,
            GhostEdgeHandle.edge_id == edge_id,
        )
        .one_or_none()
    )
    if row is None:
        row = GhostEdgeHandle(container_id=container_id, edge_id=edge_id, **data)
        db.add(row)
    else:
        for field, value in data.items():
            setattr(row, field, value)
    db.commit()
