import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app import restore, tree
from app.alerts import compute_alerts
from app.auth import get_current_user, require_architect
from app.context_graph import build_context_graph
from app.database import get_db
from app.deps import get_current_project, scoped_node, touch_project
from app.graph_queries import build_graph
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
    GraphResponse,
    NodeCreate,
    NodeEdgeInfo,
    NodeResponse,
    NodeUpdate,
)
from app.schemas.process import ProcessListItem
from app.schemas.restore import DeletionSnapshot
from app.view_state import (
    bump_graph_rev,
    bump_meta_rev,
    bump_view_version,
    current_version,
)

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
            nodes=[], edges=[], endpoints=[], version=version, graph_rev=project.graph_rev,
            meta_rev=project.meta_rev,
        )
    all_nodes = {n.id: n for n in db.query(Node).filter(Node.project_id == project.id).all()}
    all_edges = db.query(Edge).filter(Edge.project_id == project.id).all()
    graph = build_graph(local_nodes, None, all_nodes, all_edges, db)
    graph.version = version
    graph.graph_rev = project.graph_rev
    graph.meta_rev = project.meta_rev
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
       (контейнерный) узел, а не в атомарный;
    3) изолированные группы — связные компоненты графа рёбер.
    Доменный алгоритм — в app/alerts.compute_alerts."""
    return compute_alerts(db, project.id)


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
        # Курсоры — по ФАКТИЧЕСКИМУ изменению значений, не по наличию ключей:
        # клиент шлёт полный payload (name/shape присутствуют всегда), и бамп
        # «по ключам» двигал бы graph_rev на каждую мета-правку (ложный тост
        # схемы в той же сессии, V48/V53).
        structural = {"parent_id", "name", "shape"}
        struct_changed = any(data[f] != getattr(node, f) for f in data.keys() & structural)
        meta_changed = any(data[f] != getattr(node, f) for f in data.keys() - structural)
        for field, value in data.items():
            setattr(node, field, value)
        node.version += 1
        if "parent_id" in data and data["parent_id"] != old_parent:
            # перенос между уровнями меняет членство ОБОИХ видов — fence обоим
            bump_view_version(db, project.id, old_parent)
            bump_view_version(db, project.id, data["parent_id"])
        # Структурные поля двигают СХЕМУ (имя/форма/иерархия видны на холсте);
        # мета (роль/технология/статус/описание/внешность/openapi) — курсор меты:
        # поллинг страницы отличает «данные обновлены» от «схема обновлена».
        if struct_changed:
            bump_graph_rev(db, project)
        if meta_changed:
            bump_meta_rev(db, project)
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
            nodes=[], edges=[], endpoints=[], version=version, graph_rev=project.graph_rev,
            meta_rev=project.meta_rev,
        )

    all_nodes = {n.id: n for n in db.query(Node).filter(Node.project_id == project.id).all()}
    all_edges = db.query(Edge).filter(Edge.project_id == project.id).all()
    graph = build_graph(local_nodes, node_id, all_nodes, all_edges, db)
    graph.version = version
    graph.graph_rev = project.graph_rev
    graph.meta_rev = project.meta_rev
    return graph


@router.get("/{node_id}/context-graph", response_model=GraphResponse)
def get_node_context_graph(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> GraphResponse:
    """Контекст объекта в формате СЫРОГО графа уровня — «Схема» страницы объекта
    (single-schema): виртуальный корневой уровень «фокус + представители соседей»,
    который фронт рендерит тем же level-конвейером, что и обычный уровень.
    Доменный алгоритм сборки — в app/context_graph.build_context_graph."""
    focus = scoped_node(db, node_id, project)
    if not focus:
        raise HTTPException(status_code=404, detail="Узел не найден")
    return build_context_graph(db, project, focus)


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
