import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import identity, reparent, restore, tree
from app.alerts import compute_alerts
from app.approval import manual_approval_refusal, mark_approval
from app.auth import get_current_user, require_session_user
from app.context_graph import build_context_graph
from app.database import get_db
from app.deployment import PlacementError, mark_sites, set_placements
from app.deps import (
    check_cas,
    commit_change,
    get_current_project,
    node_or_404,
    require_project_editor,
    scoped_node,
    touch_project,
)
from app.element_marks import mark_element
from app.graph_queries import build_graph, external_edges, project_has_status_info
from app.models.business_process import BusinessProcess
from app.models.edge import Edge
from app.models.node import Node
from app.models.process_participant import ProcessParticipant
from app.models.project import Project
from app.models.user import User
from app.models.view_layout import ViewLayoutItem
from app.node_ref import NodeIndex
from app.processes import process_list_items
from app.schemas.alerts import AlertsResponse
from app.schemas.node import (
    AnchorPreviewOut,
    GraphResponse,
    NodeCreate,
    NodeEdgeInfo,
    NodeResponse,
    NodeSource,
    NodeUpdate,
)
from app.schemas.process import ProcessListItem
from app.schemas.restore import DeletionSnapshot
from app.schemas.transition import (
    TransitionApplyIn,
    TransitionApplyOut,
    TransitionNodeOut,
    TransitionPreviewOut,
)
from app.transition import apply_transition, build_transition, cleanup_layout
from app.view_state import (
    bump_graph_rev,
    bump_meta_rev,
    bump_view_version,
    current_version,
    reset_view_layout,
)

router = APIRouter(prefix="/nodes", tags=["nodes"])


def _mark_has_children(db: Session, nodes: list[Node]) -> None:
    """Проставляет вычисляемые child_count и has_children для отдачи в NodeResponse.
    Один запрос на весь список: считаем число прямых детей по каждому id."""
    if not nodes:
        return
    ids = [n.id for n in nodes]
    # Ключ — parent_id (UUID | None), значение — число детей. Comprehension с
    # распаковкой строк: dict(Row...) не типизируется (Row не подтип tuple для
    # mypy), а {pid: cnt for ...} выводится чисто.
    counts: dict[uuid.UUID | None, int] = {
        pid: cnt
        for pid, cnt in (
            db.query(Node.parent_id, func.count(Node.id))
            .filter(Node.parent_id.in_(ids))
            .group_by(Node.parent_id)
            .all()
        )
    }
    for n in nodes:
        n.child_count = counts.get(n.id, 0)
        n.has_children = n.child_count > 0


def _mark_derived(db: Session, project: Project, nodes: list[Node]) -> None:
    """Все вычисляемые атрибуты NodeResponse разом: число детей и их наличие, статус
    страницы с учётом детей (app/approval), действующее размещение (app/deployment),
    действующий элемент архитектуры (app/element_marks). Одна точка — новый производный
    атрибут не забудется ни в одной из выдач роутера."""
    if not nodes:
        return
    _mark_has_children(db, nodes)
    mark_approval(db, project.id, nodes)
    mark_sites(db, project.id, nodes)
    mark_element(db, project.id, nodes)


@router.get("", response_model=list[NodeResponse])
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
    _mark_derived(db, project, nodes)
    return nodes


@router.post("", response_model=NodeResponse, status_code=status.HTTP_201_CREATED)
def create_node(
    payload: NodeCreate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> Node:
    if payload.parent_id:
        parent = scoped_node(db, payload.parent_id, project)
        if not parent:
            raise HTTPException(status_code=404, detail="Родительский узел не найден")
    # project_id проставляем сервером из текущего проекта (клиент его в теле не шлёт).
    # Якорь — не колонка: блок source приезжает разобранным по видам, а хранится
    # каноническим ключом (та же функция и те же отказы 422, что у PATCH).
    node = Node(
        **payload.model_dump(exclude={"pos_x", "pos_y", "source"}),
        source_ref=_source_ref_of(payload.source.model_dump() if payload.source else None),
        project_id=project.id,
    )
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
    commit_change(db, project, user.id, graph=True)
    db.refresh(node)
    _mark_derived(db, project, [node])  # только что создан — детей нет, но для единообразия
    return node


@router.post("/restore", status_code=status.HTTP_204_NO_CONTENT)
def restore_nodes(
    snapshot: DeletionSnapshot,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
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
    try:
        restore.restore_from_snapshot(db, snapshot, project_id=project.id)
    except restore.RestoreError as e:
        # Чужие ссылки/цикл — 422, дубль имени — 409 (см. restore.validate_snapshot).
        db.rollback()
        raise HTTPException(status_code=e.status, detail=e.detail) from None
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
    commit_change(db, project, user.id, graph=True)


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
    _mark_derived(db, project, nodes)
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
    _mark_derived(db, project, nodes)
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
            has_status_info=project_has_status_info(db, project.id),
        )
    return _level_graph(db, project, local_nodes, None, version)


def _level_graph(
    db: Session, project: Project, local_nodes: list[Node], container_id: uuid.UUID | None,
    version: int,
) -> GraphResponse:
    """Граф уровня по его узлам и курсоры клиента — общий хвост корня и уровня узла
    (аудит Q-44)."""
    all_nodes = {n.id: n for n in db.query(Node).filter(Node.project_id == project.id).all()}
    all_edges = db.query(Edge).filter(Edge.project_id == project.id).all()
    graph = build_graph(local_nodes, container_id, all_nodes, all_edges, db, project.id)
    graph.version = version
    graph.graph_rev = project.graph_rev
    graph.meta_rev = project.meta_rev
    return graph


# Должен быть объявлен до /{node_id}, иначе FastAPI примет "transition" за node_id
@router.get("/transition", response_model=TransitionPreviewOut)
def transition_preview(
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_project_editor),
) -> TransitionPreviewOut:
    """Что произойдёт при принятии перехода (новое → существующее, выводимое →
    удалить). Ничего не записывает."""
    plan = build_transition(db, project)
    paths = NodeIndex.of(db.query(Node).filter(Node.project_id == project.id).all()).path_by_id()
    return TransitionPreviewOut(
        graph_rev=project.graph_rev,
        is_noop=plan.is_noop,
        delete=[_transition_node(n, paths) for n in plan.delete_roots],
        delete_total=len(plan.delete_ids),
        collateral=[_transition_node(n, paths) for n in plan.collateral],
        delete_edges=plan.edges,
        delete_docs=plan.docs,
        delete_specs=plan.specs,
        promote=[_transition_node(n, paths) for n in plan.promote],
    )


# Физическое удаление по списку — токеном нельзя (docs/plan-remote-mcp.md, Р4): сносит
# человек глазами, в интерфейсе.
@router.post(
    "/transition",
    response_model=TransitionApplyOut,
    dependencies=[Depends(require_session_user)],
)
def transition_apply(
    payload: TransitionApplyIn,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> TransitionApplyOut:
    """Принять переход. План ПЕРЕСЧИТЫВАЕТСЯ здесь — клиентскому не доверяем; при
    расхождении курсора схемы отказываем, а не пишем вслепую."""
    if payload.base_graph_rev is not None and payload.base_graph_rev != project.graph_rev:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Схема изменилась с момента показа плана",
        )
    plan = build_transition(db, project)
    deleted, promoted = apply_transition(db, project, plan)
    if deleted or promoted:
        bump_graph_rev(db, project)
        touch_project(db, project, user.id)
    db.commit()
    return TransitionApplyOut(deleted_nodes=deleted, promoted_nodes=promoted)



def _transition_node(n: Node, paths: dict[uuid.UUID, str]) -> TransitionNodeOut:
    return TransitionNodeOut(id=n.id, name=n.name, path=paths.get(n.id, n.name))


@router.get("/alerts", response_model=AlertsResponse)
def get_alerts(
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_project_editor),
) -> AlertsResponse:
    """Глобальные алерты незавершённости схемы (только редактор проекта):
    1) атомарные (листовые) узлы без единой связи — «подвисшие»;
    2) связи, у которых хотя бы один конец упирается в промежуточный
       (контейнерный) узел, а не в атомарный;
    3) изолированные группы — связные компоненты графа рёбер.
    Доменный алгоритм — в app/alerts.compute_alerts."""
    return compute_alerts(db, project.id)


def _source_ref_of(raw: dict | None) -> str | None:
    """Блок source из PATCH → канонический ключ якоря; отказ — 422 с текстом
    принятого пояснения (identity.parse_source_patch)."""
    try:
        return identity.parse_source_patch(raw)
    except identity.AnchorError as e:
        raise HTTPException(status_code=422, detail=str(e)) from None


@router.post("/anchor-preview", response_model=AnchorPreviewOut)
def anchor_preview(
    payload: NodeSource,
    _: User = Depends(get_current_user),
    __: Project = Depends(get_current_project),
) -> AnchorPreviewOut:
    """Что ArchMap запишет в якорь, если сохранить эту форму, — БЕЗ записи.

    Живая нормализация в форме поля «Якорь»: вставленный адрес клона
    (https://…/repo.git, git@host:org/repo) на глазах превращается в
    «github.com/org/repo», а адрес среды — в понятный отказ. Валидация и
    нормализация те же самые, что у PATCH (_source_ref_of), иначе форма обещала
    бы одно, а сохранение делало другое.

    ⚠️ Маршрут объявлен ДО «/{node_id}»: иначе «anchor-preview» разбирался бы
    как UUID. Узел не нужен и не трогается — это чистая функция над строками,
    поэтому доступ у любого участника проекта (наблюдателю форму не показывают,
    но ручка безвредна: ничего не читает из БД и ничего не пишет)."""
    key = _source_ref_of(payload.model_dump())
    if key is None:
        return AnchorPreviewOut()
    kind = "code" if identity.key_type(key) == "git" else "dependency"
    return AnchorPreviewOut(source=NodeSource(**identity.source_ref_dict(key)), kind=kind, key=key)


@router.get("/{node_id}", response_model=NodeResponse)
def get_node(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> Node:
    node = node_or_404(db, node_id, project)
    _mark_derived(db, project, [node])
    return node




def _apply_site_ids(
    db: Session, project: Project, node: Node, site_ids: list[uuid.UUID] | None
) -> None:
    """Размещение из PATCH узла (NodeUpdate.site_ids): None — не прислано, не трогаем;
    список — набор площадок целиком, у контейнера — каждому объекту внутри
    (app/deployment.set_placements). Отказ домена — в HTTP (404 — площадка не из
    проекта, 422 — «Пользователь» или контейнер без объектов)."""
    if site_ids is None:
        return
    try:
        placed = set_placements(db, project, [node], set(site_ids))
    except PlacementError as e:
        raise HTTPException(status_code=e.status, detail=e.detail) from None
    # Набор изменился — двигаем оба курсора: холст развёртывания (схема) и строку
    # «Размещение» на странице объекта (мета). CAS узла не трогаем: это не колонка.
    if placed:
        bump_graph_rev(db, project)
        bump_meta_rev(db, project)


@router.patch("/{node_id}", response_model=NodeResponse)
def update_node(
    node_id: uuid.UUID,
    payload: NodeUpdate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> Node:
    node = node_or_404(db, node_id, project)
    data = payload.model_dump(exclude_unset=True)
    # CAS: правка от устаревшей версии не затирает чужую (base_version — не поле узла)
    base_version = data.pop("base_version", None)
    check_cas(node.version, base_version, "Узел изменён в другой сессии")
    # Якорь — НЕ колонка: блок source приезжает разобранным по видам, а хранится
    # каноническим ключом. Достаём до цикла setattr, иначе присвоился бы словарь.
    if "source" in data:
        data["source_ref"] = _source_ref_of(data.pop("source"))
    # Размещение — тоже НЕ колонка: набор строк экземпляров. Достаём до цикла setattr;
    # null равен «не прислано». Применяется после правки полей — правило «у
    # пользователя размещения нет» смотрит на уже итоговую форму узла.
    site_ids = data.pop("site_ids", None)
    # Статус страницы у контейнера не хранится, а складывается из детей
    # (app/approval): правка руками отказывается 422, даже если значение совпадает
    # с хранимым. Курсор — мета (approval не в structural ниже): его ставит общее
    # правило «по фактическому изменению».
    if "approval" in data:
        reason = manual_approval_refusal(db, node)
        if reason:
            raise HTTPException(status_code=422, detail=reason)
    if data:
        old_parent = node.parent_id
        # Перенос на другой уровень — единственная правка со ЗАПРЕТАМИ (цикл оторвал бы
        # поддерево от корня) и с последствиями для раскладки. Проверяем ДО присваивания:
        # узел ещё в исходном состоянии, поддерево считается по нему.
        moved = "parent_id" in data and data["parent_id"] != old_parent
        if moved:
            reason = reparent.validate_reparent(db, project, node, data["parent_id"])
            if reason:
                raise HTTPException(status_code=400, detail=reason)
        # Смена ФОРМЫ — вторая правка с запретами: форма решает, может ли узел иметь
        # детей и чем он владеет. Проверяем ДО присваивания (узел ещё в исходном
        # состоянии — старая форма нужна самой проверке).
        if "shape" in data and data["shape"] != node.shape:
            reason = reparent.validate_shape_change(db, node, data["shape"])
            if reason:
                raise HTTPException(status_code=400, detail=reason)
        # Курсоры — по ФАКТИЧЕСКИМУ изменению значений, не по наличию ключей:
        # клиент шлёт полный payload (name/shape присутствуют всегда), и бамп
        # «по ключам» двигал бы graph_rev на каждую мета-правку (ложный тост
        # схемы в той же сессии, V48/V53).
        # Якорь — мета: он ничего не меняет на холсте, только то, как ArchMap
        # узнаёт объект при обновлениях (см. NodeSource). Отдельной ветки ему не
        # нужно — общее правило «курсор по фактическому изменению» уже накрывает
        # source_ref, раз он лежит в data обычным полем узла.
        structural = {"parent_id", "name", "shape"}
        struct_changed = any(data[f] != getattr(node, f) for f in data.keys() & structural)
        meta_changed = any(data[f] != getattr(node, f) for f in data.keys() - structural)
        for field, value in data.items():
            setattr(node, field, value)
        node.version += 1
        if moved:
            # Позиции переехавшего поддерева во ВНЕШНИХ видах больше ничего не значат:
            # снимаем их и двигаем версии затронутых видов (в т.ч. обоих родителей).
            reparent.strip_layout(db, project, node, old_parent)
        # Структурные поля двигают СХЕМУ (имя/форма/иерархия видны на холсте);
        # мета (роль/технология/статус/описание/внешность/openapi) — курсор меты:
        # поллинг страницы отличает «данные обновлены» от «схема обновлена».
        if struct_changed:
            bump_graph_rev(db, project)
        if meta_changed:
            bump_meta_rev(db, project)
    _apply_site_ids(db, project, node, site_ids)
    commit_change(db, project, user.id)
    db.refresh(node)
    _mark_derived(db, project, [node])
    return node


@router.get("/{node_id}/move-snapshot", response_model=DeletionSnapshot)
def get_move_snapshot(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_project_editor),
) -> DeletionSnapshot:
    """Снимок раскладки, которую снимет перенос узла на другой уровень.

    Тот же контракт и тот же путь возврата, что у удаления: клиент берёт снимок ПЕРЕД
    сменой parent_id и при Undo возвращает его через POST /nodes/restore. Узлы и связи
    в снимке пусты — перенос ничего не сносит, кроме запомненных позиций.
    """
    node = node_or_404(db, node_id, project)
    return reparent.build_move_snapshot(db, project, node)


@router.get("/{node_id}/deletion-snapshot", response_model=DeletionSnapshot)
def get_deletion_snapshot(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_project_editor),
) -> DeletionSnapshot:
    """Снимок всего, что снесёт удаление узла (поддерево + рёбра + ghost-метаданные).

    Клиент берёт его ПЕРЕД delete, чтобы потом восстановить через POST /restore (Undo).
    """
    node_or_404(db, node_id, project)
    return restore.build_deletion_snapshot(db, node_id)


@router.delete("/{node_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_node(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> None:
    node = node_or_404(db, node_id, project)
    # Удаляем узел со всем поддеревом (потомки любой глубины) и их рёбрами — это
    # делает БД-каскад (ondelete="CASCADE" на parent_id, source_id/target_id), а
    # passive_deletes на связях Node не даёт ORM лезть в эти строки в Python.
    # Строки раскладки чужих видов каскадом не накрыты — их чистит cleanup_layout
    # (тот же помощник использует «принять переход», чтобы логика не разошлась).
    cleanup_layout(db, project, node)
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
    node_or_404(db, node_id, project)
    children = db.query(Node).filter(Node.parent_id == node_id).all()
    _mark_derived(db, project, children)
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
    node_or_404(db, node_id, project)
    subtree_ids = tree.collect_subtree_ids_db(db, node_id) - {node_id}
    if not subtree_ids:
        return []
    descendants = db.query(Node).filter(Node.id.in_(subtree_ids)).all()
    _mark_derived(db, project, descendants)
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
    node_or_404(db, node_id, project)

    return external_edges(db, project.id, node_id)


@router.get("/{node_id}/graph", response_model=GraphResponse)
def get_node_graph(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> GraphResponse:
    """Граф для уровня node_id: дочерние узлы + рёбра + гостевые узлы из других уровней."""
    node_or_404(db, node_id, project)

    local_nodes = db.query(Node).filter(Node.parent_id == node_id).all()
    # версия вида + курсор проекта — базовая точка отсчёта клиента (этапы 0/1)
    version = current_version(db, project.id, node_id)
    # ПУСТОЙ УРОВЕНЬ ОТДАЁТСЯ ПОЛНОЦЕННО (2026-08-11, эпик «связи, упирающиеся в
    # рамку»; прежде здесь был ранний return с пустым GraphResponse — view.md V16).
    # У контейнера без детей своих связей может быть сколько угодно, и на его уровне
    # они рисуются упирающимися в рамку: если не отдать их сюда, пользователь войдёт
    # в узел и увидит пустой холст вместо содержимого «как оно есть».
    return _level_graph(db, project, local_nodes, node_id, version)


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
    focus = node_or_404(db, node_id, project)
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
    focus = node_or_404(db, node_id, project)
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






@router.post("/relayout", status_code=status.HTTP_204_NO_CONTENT)
def relayout_root_level(
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_project_editor),
) -> None:
    """«Переразложить» корневой уровень: позиции корневых узлов → авто (ELK)."""
    reset_view_layout(db, project, None)
    db.commit()


@router.post(
    "/{container_id}/relayout",
    status_code=status.HTTP_204_NO_CONTENT,
)
def relayout_level(
    container_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_project_editor),
) -> None:
    """«Переразложить уровень»: весь ручной layout уровня container_id → авто."""
    if not scoped_node(db, container_id, project):
        raise HTTPException(status_code=404, detail="Уровень не найден")
    reset_view_layout(db, project, container_id)
    db.commit()


@router.post(
    "/{node_id}/context-relayout",
    status_code=status.HTTP_204_NO_CONTENT,
)
def relayout_context(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_project_editor),
) -> None:
    """«Переразложить» страницу объекта: сбрасывает раскладку ВИДА ФОКУСА
    (view_id = node_id) — позиции и инлайн-раскрытия → свежий ELK. Соседние
    виды (другие страницы, уровни редактора) нетронуты."""
    node_or_404(db, node_id, project)
    reset_view_layout(db, project, node_id)
    db.commit()
