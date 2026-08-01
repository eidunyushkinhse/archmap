import uuid
from collections import Counter

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app import restore, tree
from app.auth import get_current_user, require_architect
from app.database import get_db
from app.deps import get_current_project, scoped_node, touch_project
from app.models.business_process import BusinessProcess
from app.models.edge import Edge
from app.models.node import Node
from app.models.process_participant import ProcessParticipant
from app.models.project import Project
from app.models.user import User
from app.models.view_layout import ViewLayoutItem
from app.processes import process_list_items
from app.schemas.node import (
    AlertsResponse,
    ContextEdgeResponse,
    DisconnectedNodeAlert,
    GhostNodeResponse,
    GraphEdgeResponse,
    GraphResponse,
    IntermediateEdgeAlert,
    IsolatedGroupAlert,
    NodeContextResponse,
    NodeCreate,
    NodeEdgeInfo,
    NodeResponse,
    NodeUpdate,
    ViewLayoutPayload,
)
from app.schemas.process import ProcessListItem
from app.schemas.restore import DeletionSnapshot
from app.view_state import bump_graph_rev, bump_view_version, current_version

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


def _read_view_layout(
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


def _ghost_registry(
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
                version=edge.version,
            )
        )
        for nid in (edge.source_id, edge.target_id):
            if nid not in local_ids:
                endpoint_ids.add(nid)

    # Раскладка вида как есть (единый читатель _read_view_layout).
    layout = _read_view_layout(db, local_nodes[0].project_id, container_id)

    # Число прямых детей у каждого родителя — одним проходом по всем узлам.
    # Питает бейдж «есть дети (N)» и кнопку «Войти» и у концов-реестра, и у локалов.
    child_counts = Counter(n.parent_id for n in all_nodes.values() if n.parent_id is not None)
    # Реестр не-локальных концов рёбер (единый строитель _ghost_registry).
    endpoints = _ghost_registry(all_nodes, endpoint_ids, child_counts)
    # child_count/has_children локальных узлов — из того же Counter
    # (карта всех узлов уже в памяти; отдельный SQL _mark_has_children здесь лишний).
    for n in local_nodes:
        n.child_count = child_counts.get(n.id, 0)
        n.has_children = n.child_count > 0
    return GraphResponse(
        nodes=local_nodes,
        edges=result_edges,
        endpoints=endpoints,
        layout=layout,
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
    node = Node(**payload.model_dump(exclude={"pos_x", "pos_y"}), project_id=project.id)
    db.add(node)
    db.flush()
    # Координаты дропа шаблона — строкой раскладки в вид РОДИТЕЛЯ (R3: единое
    # хранилище; в колонках узла позиций больше нет). Без координат — авто (ELK).
    if payload.pos_x is not None and payload.pos_y is not None:
        db.add(
            ViewLayoutItem(
                project_id=project.id,
                view_id=payload.parent_id,
                item_id=str(node.id),
                payload={"x": payload.pos_x, "y": payload.pos_y},
            )
        )
    # мир вида родителя изменился (новый локал ± строка позиции): fence + курсор
    bump_view_version(db, project.id, payload.parent_id)
    bump_graph_rev(db, project)
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
    # Fence видам, чей мир пополнился извне поддерева: родительские виды корней
    # снимка + виды восстановленных строк раскладки вне снимка (гостевые позиции).
    # Виды ВНУТРИ снимка воссозданы заново — их никто не наблюдал, бамп не нужен.
    touched_views = {
        n.parent_id for n in snapshot.nodes if n.parent_id is None or n.parent_id not in ids
    }
    touched_views |= {
        it.view_id
        for it in snapshot.layout_items
        if it.view_id is None or it.view_id not in ids
    }
    for vid in touched_views:
        bump_view_version(db, project.id, vid)
    bump_graph_rev(db, project)
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
    # версия вида + курсор проекта — базовая точка отсчёта клиента (этапы 0/1)
    version = current_version(db, project.id, None)
    if not local_nodes:
        return GraphResponse(
            nodes=[], edges=[], endpoints=[], version=version, graph_rev=project.graph_rev
        )
    all_nodes = {n.id: n for n in db.query(Node).filter(Node.project_id == project.id).all()}
    all_edges = db.query(Edge).filter(Edge.project_id == project.id).all()
    graph = _build_graph(local_nodes, None, all_nodes, all_edges, db)
    graph.version = version
    graph.graph_rev = project.graph_rev
    return graph


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
    data = payload.model_dump(exclude_unset=True)
    # CAS: правка от устаревшей версии не затирает чужую (base_version — не поле узла)
    base_version = data.pop("base_version", None)
    if base_version is not None and base_version != node.version:
        raise HTTPException(status_code=409, detail="Узел изменён в другой сессии")
    if data:
        old_parent = node.parent_id
        for field, value in data.items():
            setattr(node, field, value)
        node.version += 1
        if "parent_id" in data and data["parent_id"] != old_parent:
            # перенос между уровнями меняет членство ОБОИХ видов — fence обоим
            bump_view_version(db, project.id, old_parent)
            bump_view_version(db, project.id, data["parent_id"])
        bump_graph_rev(db, project)
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
    # Удаляем узел со всем поддеревом (потомки любой глубины) и их рёбрами — это
    # делает БД-каскад (ondelete="CASCADE" на parent_id, source_id/target_id), а
    # passive_deletes на связях Node не даёт ORM лезть в эти строки в Python.
    #
    # Раскладка: строки view_layout СВОИХ видов поддерева умирают каскадом view_id,
    # но строки, ссылающиеся на поддерево из ДРУГИХ видов (гостевые позиции, ключи
    # пучков "b:<src>><tgt>"), FK не накрыты (item_id — строка) — чистим явно по
    # вхождению uuid в ключ.
    subtree = tree.collect_subtree_ids_db(db, node_id)
    like_filter = or_(*[ViewLayoutItem.item_id.like(f"%{sid}%") for sid in subtree])
    # Виды, из которых чистка вычистит строки (гостевые позиции и т.п.), — их мир
    # меняется, fence должен это увидеть. Виды ВНУТРИ поддерева умирают каскадом —
    # им версию не бампаем (строка view_state уйдёт тем же каскадом view_id).
    touched_views = {
        vid
        for (vid,) in db.query(ViewLayoutItem.view_id)
        .filter(ViewLayoutItem.project_id == project.id, like_filter)
        .distinct()
        .all()
        if vid is None or vid not in subtree
    }
    db.query(ViewLayoutItem).filter(
        ViewLayoutItem.project_id == project.id, like_filter
    ).delete(synchronize_session=False)
    touched_views.add(node.parent_id)  # членство родительского вида изменилось
    for vid in touched_views:
        bump_view_version(db, project.id, vid)
    bump_graph_rev(db, project)
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
    # версия вида + курсор проекта — базовая точка отсчёта клиента (этапы 0/1)
    version = current_version(db, project.id, node_id)
    if not local_nodes:
        return GraphResponse(
            nodes=[], edges=[], endpoints=[], version=version, graph_rev=project.graph_rev
        )

    all_nodes = {n.id: n for n in db.query(Node).filter(Node.project_id == project.id).all()}
    all_edges = db.query(Edge).filter(Edge.project_id == project.id).all()
    graph = _build_graph(local_nodes, node_id, all_nodes, all_edges, db)
    graph.version = version
    graph.graph_rev = project.graph_rev
    return graph


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
        # Контекст отдаётся серверной проекцией: концы свёрнуты на фокус/соседа
        # (реальные концы — в original_*). LEGACY-путь (archmap_single_object_schema=0);
        # при включённом флаге страница использует context-graph (сырой граф уровня).
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
                version=e.version,
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


@router.get("/{node_id}/context-graph", response_model=GraphResponse)
def get_node_context_graph(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> GraphResponse:
    """Контекст объекта в формате СЫРОГО графа уровня — «Схема» страницы объекта
    (single-schema): виртуальный корневой уровень, который фронт рендерит тем же
    level-конвейером, что и обычный уровень. Форма ответа — GraphResponse:

    - nodes (локалы) = фокус + ПРЕДСТАВИТЕЛИ соседей: сиблинги фокуса (дети того
      же родителя; на корне — корневые узлы), в чьём поддереве лежит хотя бы один
      сосед. Несвязанные сиблинги уровня в контекст не попадают.
    - edges — СЫРЫЕ рёбра контекста (реальные концы, проекция — на фронте):
      внутренние поддерева фокуса (питают раскрытие R5), граничные (ровно один
      конец в поддереве — сам контекст) и сосед↔сосед (связи между соседями —
      как в «отдельном проекте», куда положили объект и его соседей).
    - endpoints — реестр не-локальных концов этих рёбер с цепочками предков.
    - layout — НЕ отдаётся (пустой по умолчанию): виртуальный корень всегда
      раскладывается свежим ELK, как корень отдельного проекта без сохранённых
      позиций. Сохранённые координаты общего холста на страницу не переносятся:
      гибрид «представители по сохранённым местам + фокус по свежему ELK» рождал
      тесноту и «рогалики» стрелок (решение 2026-08-01; критерий X11-A переписан:
      тождество состава/связей/рамок при СВОЕЙ раскладке).
    """
    focus = scoped_node(db, node_id, project)
    if not focus:
        raise HTTPException(status_code=404, detail="Узел не найден")

    all_nodes = {n.id: n for n in db.query(Node).filter(Node.project_id == project.id).all()}
    all_edges = db.query(Edge).filter(Edge.project_id == project.id).all()
    subtree = tree.subtree_ids(all_nodes, focus.id)

    # Соседи — внешние сырые концы граничных рёбер поддерева фокуса.
    neighbor_ids: set[uuid.UUID] = set()
    for e in all_edges:
        s_in = e.source_id in subtree
        t_in = e.target_id in subtree
        if s_in != t_in:
            neighbor_ids.add(e.target_id if s_in else e.source_id)

    # Представители соседей среди сиблингов фокуса: контекст — это уровень
    # родителя, обрезанный до связанной с фокусом части, поэтому сосед из
    # поддерева сиблинга показывается этим сиблингом (глубокий конец поднимет
    # фронтовая проекция), а сосед вне родителя останется гостем реестра.
    # ПОРЯДОК локалов — порядок ЗАПРОСА УРОВНЯ (как у get_root_graph/get_node_graph):
    # ELK чувствителен к порядку входа — детерминированная раскладка страницы.
    siblings = (
        db.query(Node)
        .filter(Node.project_id == project.id, Node.parent_id == focus.parent_id)
        .all()
    )
    local_nodes = [
        n
        for n in siblings
        if n.id == focus.id or tree.subtree_ids(all_nodes, n.id) & neighbor_ids
    ]
    local_ids = {n.id for n in local_nodes}

    result_edges: list[GraphEdgeResponse] = []
    endpoint_ids: set[uuid.UUID] = set()
    for e in all_edges:
        touches_subtree = e.source_id in subtree or e.target_id in subtree
        both_neighbors = e.source_id in neighbor_ids and e.target_id in neighbor_ids
        if not (touches_subtree or both_neighbors):
            continue
        result_edges.append(
            GraphEdgeResponse(
                id=e.id,
                label=e.label,
                technology=e.technology,
                source_id=e.source_id,
                target_id=e.target_id,
                version=e.version,
            )
        )
        for nid in (e.source_id, e.target_id):
            if nid not in local_ids:
                endpoint_ids.add(nid)

    child_counts = Counter(n.parent_id for n in all_nodes.values() if n.parent_id is not None)
    for n in local_nodes:
        n.child_count = child_counts.get(n.id, 0)
        n.has_children = n.child_count > 0
    return GraphResponse(
        nodes=local_nodes,
        edges=result_edges,
        endpoints=_ghost_registry(all_nodes, endpoint_ids, child_counts),
        version=current_version(db, project.id, None),
        graph_rev=project.graph_rev,
    )


@router.get("/{node_id}/processes", response_model=list[ProcessListItem])
def get_node_processes(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> list[ProcessListItem]:
    """Процессы, в которых участвует узел ИЛИ его поддерево — секция «Участвует
    в процессах» страницы объекта (single-schema): участник-потомок считает
    процесс участием своего контейнера-предка. Форма ответа — тот же
    ProcessListItem, что у GET /processes (счётчик сообщений, статусы)."""
    focus = scoped_node(db, node_id, project)
    if not focus:
        raise HTTPException(status_code=404, detail="Узел не найден")
    all_nodes = {n.id: n for n in db.query(Node).filter(Node.project_id == project.id).all()}
    node_ids = tree.subtree_ids(all_nodes, focus.id)
    proc_ids = {
        row[0]
        for row in (
            db.query(ProcessParticipant.process_id)
            .join(BusinessProcess, BusinessProcess.id == ProcessParticipant.process_id)
            .filter(BusinessProcess.project_id == project.id)
            .filter(ProcessParticipant.node_id.in_(node_ids))
            .distinct()
            .all()
        )
    }
    return process_list_items(db, project.id, all_nodes, only_ids=proc_ids)




def _clear_level_layout(
    db: Session, container_id: uuid.UUID | None, project: Project
) -> None:
    """Сбрасывает ВЕСЬ ручной layout вида в авто (own-on-first-render, Ф2):
    удаляем все строки view_layout этого вида — позиции локалов/гостей/контейнеров
    и геометрию пучков разом (R3: единое хранилище). После сброса уровень выглядит
    как при первом открытии (ELK + кольца + авто-маршруты + пере-засев владения).
    Скоуп строго по виду: соседние уровни и другие виды нетронуты."""
    view_filter = (
        ViewLayoutItem.view_id.is_(None)
        if container_id is None
        else ViewLayoutItem.view_id == container_id
    )
    db.query(ViewLayoutItem).filter(
        ViewLayoutItem.project_id == project.id, view_filter
    ).delete(synchronize_session=False)
    # relayout меняет мир вида: fence должен отсечь отставшие батчи (например,
    # дроп драга из сессии, не видевшей перераскладку), поллинг — увидеть сброс
    bump_view_version(db, project.id, container_id)
    bump_graph_rev(db, project)
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
