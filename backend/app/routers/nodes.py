import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import identity, reparent, restore, tree
from app.alerts import compute_alerts
from app.auth import get_current_user, require_architect
from app.context_graph import build_context_graph
from app.database import get_db
from app.deps import get_current_project, scoped_node, touch_project
from app.graph_queries import build_graph, project_has_status_info
from app.models.broker_channel import BrokerChannel
from app.models.business_process import BusinessProcess
from app.models.db_table import DbTable
from app.models.edge import Edge
from app.models.node import Node
from app.models.process_participant import ProcessParticipant
from app.models.project import Project
from app.models.user import User
from app.models.view_layout import ViewLayoutItem
from app.processes import process_list_items
from app.schemas.node import (
    AlertsResponse,
    AnchorPreviewOut,
    GraphResponse,
    NodeCreate,
    NodeEdgeInfo,
    NodeResponse,
    NodeSource,
    NodeUpdate,
    TransitionApplyIn,
    TransitionApplyOut,
    TransitionNodeOut,
    TransitionPreviewOut,
)
from app.schemas.process import ProcessListItem
from app.schemas.restore import DeletionSnapshot
from app.transition import apply_transition, build_transition, cleanup_layout
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
            has_status_info=project_has_status_info(db, project.id),
        )
    all_nodes = {n.id: n for n in db.query(Node).filter(Node.project_id == project.id).all()}
    all_edges = db.query(Edge).filter(Edge.project_id == project.id).all()
    graph = build_graph(local_nodes, None, all_nodes, all_edges, db, project.id)
    graph.version = version
    graph.graph_rev = project.graph_rev
    graph.meta_rev = project.meta_rev
    return graph


# Должен быть объявлен до /{node_id}, иначе FastAPI примет "transition" за node_id
@router.get("/transition", response_model=TransitionPreviewOut)
def transition_preview(
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_architect),
) -> TransitionPreviewOut:
    """Что произойдёт при принятии перехода (новое → существующее, выводимое →
    удалить). Ничего не записывает."""
    plan = build_transition(db, project)
    paths = _node_paths(db, project)
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


@router.post("/transition", response_model=TransitionApplyOut)
def transition_apply(
    payload: TransitionApplyIn,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
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


def _node_paths(db: Session, project: Project) -> dict[uuid.UUID, str]:
    """Полные пути узлов проекта — «Система / payments / api»."""
    nodes = db.query(Node).filter(Node.project_id == project.id).all()
    by_id = {n.id: n for n in nodes}

    def full(n: Node) -> str:
        parts = [n.name]
        cur = by_id.get(n.parent_id) if n.parent_id else None
        while cur is not None:
            parts.append(cur.name)
            cur = by_id.get(cur.parent_id) if cur.parent_id else None
        return " / ".join(reversed(parts))

    return {n.id: full(n) for n in nodes}


def _transition_node(n: Node, paths: dict[uuid.UUID, str]) -> TransitionNodeOut:
    return TransitionNodeOut(id=n.id, name=n.name, path=paths.get(n.id, n.name))


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


def _source_ref_of(raw: dict | None) -> str | None:
    """Блок source из PATCH → канонический ключ якоря (или None — очистка).

    Отказы 422 с текстами принятого пояснения (docs/plan-anchor-ux.md, раздел
    «Как заполнять»): вид якоря один на объект, путь живёт только при
    репозитории, а адреса сред якорем не бывают. Валидация здесь, а не
    pydantic-валидатором схемы, ради общего формата ошибки {"detail": "…"} —
    список ошибок pydantic человеку в форме не показать."""
    if raw is None:
        return None
    src = identity.SourceRef(repo=raw.get("repo"), path=raw.get("path"), host=raw.get("host"))
    if src.empty:
        return None  # объект без значимых полей — та же очистка, что и null
    if src.repo and src.host:
        raise HTTPException(
            status_code=422,
            detail="Якорь одного вида: либо код (репозиторий и путь), либо имя зависимости",
        )
    if src.path and not src.repo:
        raise HTTPException(status_code=422, detail="Путь задаётся вместе с репозиторием")
    norm = identity.normalized(src)
    if src.host and not norm.host:
        raise HTTPException(
            status_code=422,
            detail=(
                "localhost, 127.0.0.1 и адреса конкретных серверов принадлежат среде, "
                "а не продукту — укажите имя, под которым продукт называет зависимость, "
                "как в docker-compose или в имени k8s Service"
            ),
        )
    if src.repo and not norm.repo:
        raise HTTPException(
            status_code=422,
            detail="Репозиторий в виде github.com/org/repo или адрес клона целиком",
        )
    return identity.canonical_key(src)


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
    node = scoped_node(db, node_id, project)
    if not node:
        raise HTTPException(status_code=404, detail="Узел не найден")
    _mark_has_children(db, [node])
    return node


def validate_shape_change(db: Session, node: Node, new_shape: str) -> str | None:
    """Причина, по которой форму узла менять нельзя, либо None. Чистая проверка, без HTTP.

    Оба запрета — про то, чем узел УЖЕ владеет и чего новая форма держать не умеет:

      • ДЕТИ. Вкладывать объекты можно только в сервис (спека node.md N4, зеркало
        фронтового canHaveChildren): сменив форму контейнеру, мы оставили бы
        поддерево у формы, которая ни детей не показывает, ни внутрь не пускает.
      • СТРУКТУРА БД. Таблицы — «контракт» узла-базы (routers/db_docs.py), и страница
        рендерит их ТОЛЬКО у shape=database. Правка прошла бы, а структура исчезла из
        интерфейса, оставшись в БД: применённое-но-невидимое хуже честного отказа.
      • КАНАЛЫ БРОКЕРА. Ровно тот же довод у shape=broker (routers/broker_channels.py):
        каналы рендерятся только у брокера, и CRUD их брокером же и ограничивает —
        запрет здесь замыкает правило с другой стороны.

    Доки логики и OpenAPI смену на person/broker не держат осознанно: страница
    показывает «неположенное» содержимое legacy-механикой (legacyLogic/legacySpec) —
    с предупреждением и без кнопок добавления, то есть унести его есть чем.
    """
    if new_shape not in reparent.CONTAINER_SHAPES:
        has_children = db.query(Node.id).filter(Node.parent_id == node.id).first() is not None
        if has_children:
            return (
                "У узла есть вложенные объекты — тип «Сервис» единственный, "
                "который может их иметь"
            )
    if node.shape == "database" and new_shape != "database":
        has_tables = db.query(DbTable.id).filter(DbTable.node_id == node.id).first() is not None
        if has_tables:
            return "У узла описана структура БД — сначала перенесите или удалите её"
    if node.shape == "broker" and new_shape != "broker":
        has_channels = (
            db.query(BrokerChannel.id).filter(BrokerChannel.node_id == node.id).first()
            is not None
        )
        if has_channels:
            return "У узла описаны каналы брокера — сначала перенесите или удалите их"
    return None


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
    # Якорь — НЕ колонка: блок source приезжает разобранным по видам, а хранится
    # каноническим ключом. Достаём до цикла setattr, иначе присвоился бы словарь.
    if "source" in data:
        data["source_ref"] = _source_ref_of(data.pop("source"))
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
            reason = validate_shape_change(db, node, data["shape"])
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
    touch_project(db, project, user.id)
    db.commit()
    db.refresh(node)
    _mark_has_children(db, [node])
    return node


@router.get("/{node_id}/move-snapshot", response_model=DeletionSnapshot)
def get_move_snapshot(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_architect),
) -> DeletionSnapshot:
    """Снимок раскладки, которую снимет перенос узла на другой уровень.

    Тот же контракт и тот же путь возврата, что у удаления: клиент берёт снимок ПЕРЕД
    сменой parent_id и при Undo возвращает его через POST /nodes/restore. Узлы и связи
    в снимке пусты — перенос ничего не сносит, кроме запомненных позиций.
    """
    node = scoped_node(db, node_id, project)
    if not node:
        raise HTTPException(status_code=404, detail="Узел не найден")
    return reparent.build_move_snapshot(db, project, node)


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
    # ПУСТОЙ УРОВЕНЬ ОТДАЁТСЯ ПОЛНОЦЕННО (2026-08-11, эпик «связи, упирающиеся в
    # рамку»; прежде здесь был ранний return с пустым GraphResponse — view.md V16).
    # У контейнера без детей своих связей может быть сколько угодно, и на его уровне
    # они рисуются упирающимися в рамку: если не отдать их сюда, пользователь войдёт
    # в узел и увидит пустой холст вместо содержимого «как оно есть».
    all_nodes = {n.id: n for n in db.query(Node).filter(Node.project_id == project.id).all()}
    all_edges = db.query(Edge).filter(Edge.project_id == project.id).all()
    graph = build_graph(local_nodes, node_id, all_nodes, all_edges, db, project.id)
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
    """Сбрасывает ручной layout вида в авто (own-on-first-render, Ф2):
    удаляем строки view_layout этого вида — позиции локалов/гостей/контейнеров
    и геометрию пучков разом (R3: единое хранилище). Строки с флагом expanded
    СОХРАНЯЕМ без координат: раскрытия переживают сброс (решение 2026-08-05 —
    «Переразложить» расставляет видимые узлы на авто-позиции, но контейнеры не
    сворачивает; до фикса раскрытия держались лишь эфемерно в сессии и терялись
    при перезагрузке). После сброса уровень выглядит как при первом открытии
    (ELK + кольца + авто-маршруты + пере-засев владения) с сохранёнными
    раскрытиями. Скоуп строго по виду: соседние уровни и другие виды нетронуты."""
    view_filter = (
        ViewLayoutItem.view_id.is_(None)
        if container_id is None
        else ViewLayoutItem.view_id == container_id
    )
    for it in (
        db.query(ViewLayoutItem)
        .filter(ViewLayoutItem.project_id == project.id, view_filter)
        .all()
    ):
        if isinstance(it.payload, dict) and it.payload.get("expanded") is True:
            it.payload = {"expanded": True}
        else:
            db.delete(it)
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
    """«Переразложить» корневой уровень: позиции корневых узлов → авто (ELK)."""
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


@router.post(
    "/{node_id}/context-relayout",
    status_code=status.HTTP_204_NO_CONTENT,
)
def relayout_context(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_architect),
) -> None:
    """«Переразложить» страницу объекта: сбрасывает раскладку ВИДА ФОКУСА
    (view_id = node_id) — позиции и инлайн-раскрытия → свежий ELK. Соседние
    виды (другие страницы, уровни редактора) нетронуты."""
    if not scoped_node(db, node_id, project):
        raise HTTPException(status_code=404, detail="Узел не найден")
    _clear_level_layout(db, node_id, project)
