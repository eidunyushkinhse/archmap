"""API бизнес-процессов: /api/v1/processes.

Точка enforcement «запертого слоя»: сообщение можно создать только на легальное плечо
существующего канала, концы которого сходятся по проекции на участников (ТЗ §3.2).
Раскладку диаграммы не храним — она выводится на фронте из order/kind.
"""

import uuid
from collections.abc import Iterator
from contextlib import contextmanager

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.database import get_db
from app.deps import (
    check_cas,
    get_current_project,
    require_project_editor,
    touch_project,
)
from app.models.business_process import BusinessProcess
from app.models.edge import Edge
from app.models.process_fragment import ProcessFragment, ProcessFragmentBranch
from app.models.process_message import ProcessMessage
from app.models.process_participant import ProcessParticipant
from app.models.project import Project
from app.models.user import User
from app.process_copy import duplicate_process
from app.process_export import detail_to_mermaid
from app.process_import import apply_import, build_preview
from app.processes import (
    ProcessRuleError,
    bound_node_ids,
    build_process_detail,
    channels_between,
    check_fragment,
    check_step_doc,
    detach_messages,
    doc_catalog,
    docs_for_messages,
    fragment_out,
    legal_directions,
    load_nodes,
    message_out,
    participant_node,
    participant_out,
    process_list_items,
    reattach_dangling,
    scope_node_ids,
    validate_message,
)
from app.schemas.export import ExportResponse
from app.schemas.process import (
    BindResult,
    BranchIn,
    ChannelOut,
    DirectionOut,
    DocChoiceOut,
    FragmentCreate,
    FragmentOut,
    FragmentUpdate,
    MessageCreate,
    MessageDocCatalog,
    MessageOut,
    MessageUpdate,
    ParticipantBind,
    ParticipantCreate,
    ParticipantOut,
    ProcessCreate,
    ProcessDetail,
    ProcessListItem,
    ProcessUpdate,
    ReattachResult,
    ReorderPayload,
)
from app.schemas.process_import import (
    ProcessImportApply,
    ProcessImportIn,
    ProcessImportPreview,
    ProcessImportResult,
)
from app.view_state import bump_process_rev

router = APIRouter(prefix="/processes", tags=["processes"])


# ── Вспомогательные ───────────────────────────────────────────────────────────
@contextmanager
def _rules() -> Iterator[None]:
    """Нарушение правила процесса (app/processes) — HTTP-ответ с тем же текстом."""
    try:
        yield
    except ProcessRuleError as e:
        raise HTTPException(status_code=e.status, detail=e.detail) from None


def _touch(db: Session, project: Project, user_id: uuid.UUID | None) -> None:
    """touch_project + курсор процессов: каждая мутация процессов двигает
    process_rev (Д9), чтобы её увидел поллинг чужой сессии на странице процесса.
    Курсор СВОЙ: meta_rev дал бы ложный тост странице объекта, graph_rev — ложный
    рефетч уровня канвасу."""
    bump_process_rev(db, project)
    touch_project(db, project, user_id)



def _get_process(db: Session, process_id: uuid.UUID, project: Project) -> BusinessProcess:
    """Процесс текущего проекта, иначе 404 (чужой процесс недоступен — изоляция).
    HTTP-перевод «не найдено»; доменные запросы/сериализация — в app/processes.py."""
    proc = db.get(BusinessProcess, process_id)
    if proc is None or proc.project_id != project.id:
        raise HTTPException(status_code=404, detail="Процесс не найден")
    return proc


# ── Процессы ──────────────────────────────────────────────────────────────────
@router.get("", response_model=list[ProcessListItem])
def list_processes(
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> list[ProcessListItem]:
    all_nodes = load_nodes(db, project.id)
    return process_list_items(db, project.id, all_nodes)


@router.post("", response_model=ProcessDetail, status_code=status.HTTP_201_CREATED)
def create_process(
    payload: ProcessCreate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> ProcessDetail:
    all_nodes = load_nodes(db, project.id)
    if payload.scope_node_id is not None and payload.scope_node_id not in all_nodes:
        raise HTTPException(status_code=404, detail="Узел области не найден")
    proc = BusinessProcess(
        name=payload.name, scope_node_id=payload.scope_node_id, project_id=project.id
    )
    db.add(proc)
    _touch(db, project, user.id)
    db.commit()
    db.refresh(proc)
    return build_process_detail(db, proc, all_nodes)


@router.post("/import/preview", response_model=ProcessImportPreview)
def preview_process_import(
    payload: ProcessImportIn,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> ProcessImportPreview:
    """Что получится из текста диаграммы и с чем сопоставились имена. Ничего не пишет.

    Объявлен ДО /{process_id}: иначе FastAPI принял бы «import» за uuid процесса.
    """
    return build_preview(db, project.id, payload.text, payload.name)


@router.post(
    "/import", response_model=ProcessImportResult, status_code=status.HTTP_201_CREATED
)
def import_process(
    payload: ProcessImportApply,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> ProcessImportResult:
    """Создаёт НОВЫЙ процесс из диаграммы (слияние с существующим — отдельная задача)."""
    _, result = apply_import(db, project.id, payload.text, payload.name, payload.mapping)
    _touch(db, project, user.id)
    db.commit()
    return result


@router.get("/{process_id}", response_model=ProcessDetail)
def get_process(
    process_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> ProcessDetail:
    proc = _get_process(db, process_id, project)
    return build_process_detail(db, proc, load_nodes(db, project.id))


@router.get("/{process_id}/export", response_model=ExportResponse)
def export_process(
    process_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> ExportResponse:
    """Экспорт процесса в Mermaid sequenceDiagram (Ф2 архива, решение Р2).

    Конвертер переехал с фронта ЕДИНСТВЕННОЙ реализацией (process_export):
    кнопка экспорта, архив и MCP зовут одну и ту же ручку. Читателю открыт —
    экспорт знания, а не действие над ним."""
    proc = _get_process(db, process_id, project)
    detail = build_process_detail(db, proc, load_nodes(db, project.id))
    return ExportResponse(format="mermaid", content=detail_to_mermaid(detail))


@router.patch("/{process_id}", response_model=ProcessDetail)
def update_process(
    process_id: uuid.UUID,
    payload: ProcessUpdate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> ProcessDetail:
    proc = _get_process(db, process_id, project)
    all_nodes = load_nodes(db, project.id)
    data = payload.model_dump(exclude_unset=True)
    if data.get("scope_node_id") is not None and data["scope_node_id"] not in all_nodes:
        raise HTTPException(status_code=404, detail="Узел области не найден")
    for field, value in data.items():
        setattr(proc, field, value)
    _touch(db, project, user.id)
    db.commit()
    db.refresh(proc)
    return build_process_detail(db, proc, all_nodes)


@router.post(
    "/{process_id}/duplicate", response_model=ProcessDetail, status_code=status.HTTP_201_CREATED
)
def duplicate_process_endpoint(
    process_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> ProcessDetail:
    """Копия процесса целиком — одной транзакцией на сервере.

    Прежде копию собирал фронт из публичных ручек и терял на их 422 непривязанных
    участников, повисшие шаги и ответы на ставшем асинхронным канале, а фрагмент
    вообще мог свалить дублирование на полпути, оставив полусобранную копию.
    Копия пишется строками (app/process_copy.py) и переносит ровно то, что есть,
    включая незадокументированность; инварианты публичных ручек при этом не тронуты.

    Имя как «endpoint»: доменная duplicate_process импортирована выше (та же грабля,
    что у detach_messages).
    """
    proc = _get_process(db, process_id, project)
    copy = duplicate_process(db, proc)
    _touch(db, project, user.id)
    db.commit()
    db.refresh(copy)
    return build_process_detail(db, copy, load_nodes(db, project.id))


@router.delete("/{process_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_process(
    process_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> None:
    proc = _get_process(db, process_id, project)
    db.delete(proc)  # каскад сносит участников/сообщения/фрагменты
    _touch(db, project, user.id)
    db.commit()


# ── Участники ─────────────────────────────────────────────────────────────────
@router.post(
    "/{process_id}/participants",
    response_model=ParticipantOut,
    status_code=status.HTTP_201_CREATED,
)
def add_participant(
    process_id: uuid.UUID,
    payload: ParticipantCreate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> ParticipantOut:
    proc = _get_process(db, process_id, project)
    all_nodes = load_nodes(db, project.id)
    node = all_nodes.get(payload.node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="Узел не найден")
    if payload.node_id not in scope_node_ids(all_nodes, proc.scope_node_id):
        raise HTTPException(status_code=422, detail="Узел вне области процесса")
    if any(p.node_id == payload.node_id for p in proc.participants):
        raise HTTPException(status_code=409, detail="Узел уже участвует в процессе")
    # Имя кладём запасом: узел могут удалить, и тогда участник останется без него.
    part = ProcessParticipant(
        process_id=proc.id, node_id=payload.node_id, name=node.name, order=payload.order
    )
    db.add(part)
    _touch(db, project, user.id)
    db.commit()
    db.refresh(part)
    return participant_out(part, node)


@router.patch("/{process_id}/participants/reorder", response_model=list[ParticipantOut])
def reorder_participants(
    process_id: uuid.UUID,
    payload: ReorderPayload,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> list[ParticipantOut]:
    proc = _get_process(db, process_id, project)
    by_id = {p.id: p for p in proc.participants}
    for index, pid in enumerate(payload.ids):
        part = by_id.get(pid)
        if part is None:
            raise HTTPException(status_code=422, detail="Участник не из этого процесса")
        part.order = index
    _touch(db, project, user.id)
    db.commit()
    all_nodes = load_nodes(db, project.id)
    parts = sorted(proc.participants, key=lambda p: p.order)
    return [participant_out(p, participant_node(p, all_nodes)) for p in parts]


@router.patch(
    "/{process_id}/participants/{participant_id}",
    response_model=BindResult,
)
def bind_participant(
    process_id: uuid.UUID,
    participant_id: uuid.UUID,
    payload: ParticipantBind,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> BindResult:
    """Привязать непривязанного участника к узлу схемы (или снять привязку — для undo).

    Объявлен ПОСЛЕ /participants/reorder: иначе FastAPI принял бы «reorder» за
    participant_id (та же грабля была с /messages/reorder и /nodes/transition).
    """
    proc = _get_process(db, process_id, project)
    part = db.get(ProcessParticipant, participant_id)
    if part is None or part.process_id != proc.id:
        raise HTTPException(status_code=404, detail="Участник не найден")
    if payload.node_id is None:
        part.node_id = None  # имя остаётся: без него линия жизни стала бы безымянной
        detached = detach_messages(proc, part)
        _touch(db, project, user.id)
        db.commit()
        db.refresh(part)
        return BindResult(participant=participant_out(part, None), attached=0, dangling=detached)
    if part.node_id is not None:
        raise HTTPException(
            status_code=409,
            detail="Участник уже привязан к узлу: сообщения опираются на каналы именно "
            "этого узла, подменять его нельзя",
        )
    all_nodes = load_nodes(db, project.id)
    node = all_nodes.get(payload.node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="Узел не найден")
    if payload.node_id not in scope_node_ids(all_nodes, proc.scope_node_id):
        raise HTTPException(status_code=422, detail="Узел вне области процесса")
    if any(p.node_id == payload.node_id for p in proc.participants):
        raise HTTPException(status_code=409, detail="Узел уже участвует в процессе")
    part.node_id = node.id
    part.name = node.name  # имя-запас обновляем: теперь оно про этот узел
    db.flush()  # подхват смотрит на уже привязанного участника
    attached, dangling, _ids = reattach_dangling(db, proc, all_nodes, part)
    _touch(db, project, user.id)
    db.commit()
    db.refresh(part)
    return BindResult(
        participant=participant_out(part, node), attached=attached, dangling=dangling
    )


@router.post("/{process_id}/reattach", response_model=ReattachResult)
def reattach_process(
    process_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> ReattachResult:
    """Прогнать ВСЕ повисшие шаги процесса через подбор канала.

    Нужен после правки схемы: пользователь чинит канал (например, делает его
    синхронным — у асинхронного нет плеча «ответ»), а процесс об этом не узнаёт.
    Прежде подхват случался только при привязке участника, то есть починить схему и
    подхватить шаги было двумя несвязанными действиями.
    """
    proc = _get_process(db, process_id, project)
    attached, dangling, ids = reattach_dangling(db, proc, load_nodes(db, project.id))
    _touch(db, project, user.id)
    db.commit()
    return ReattachResult(attached=attached, dangling=dangling, attached_ids=ids)


@router.post("/{process_id}/messages/detach", status_code=status.HTTP_204_NO_CONTENT)
def detach_messages_endpoint(
    process_id: uuid.UUID,
    payload: ReorderPayload,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> None:
    """Отцепить перечисленные шаги от каналов — компенсация подхвата для undo.

    Объявлен ДО /{message_id}: иначе FastAPI принял бы «detach» за uuid сообщения.
    """
    proc = _get_process(db, process_id, project)
    by_id = {m.id: m for m in proc.messages}
    for mid in payload.ids:
        msg = by_id.get(mid)
        if msg is None:
            raise HTTPException(status_code=422, detail="Сообщение не из этого процесса")
        msg.edge_id = None
    _touch(db, project, user.id)
    db.commit()


@router.delete(
    "/{process_id}/participants/{participant_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_participant(
    process_id: uuid.UUID,
    participant_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> None:
    proc = _get_process(db, process_id, project)
    part = db.get(ProcessParticipant, participant_id)
    if part is None or part.process_id != proc.id:
        raise HTTPException(status_code=404, detail="Участник не найден")
    db.delete(part)  # каскад сносит сообщения с этим концом (FK ON DELETE CASCADE)
    _touch(db, project, user.id)
    db.commit()


# ── Сообщения (точка enforcement) ─────────────────────────────────────────────
@router.post(
    "/{process_id}/messages",
    response_model=MessageOut,
    status_code=status.HTTP_201_CREATED,
)
def create_message(
    process_id: uuid.UUID,
    payload: MessageCreate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> MessageOut:
    proc = _get_process(db, process_id, project)
    with _rules():
        draft = validate_message(db, project.id, proc, payload)
    msg = ProcessMessage(
        process_id=proc.id,
        order=payload.order,
        edge_id=draft.edge.id if draft.edge else None,
        leg=payload.leg,
        from_participant_id=draft.sender.id,
        to_participant_id=draft.receiver.id,
        caption=draft.caption,
        doc_id=payload.doc_id,
    )
    db.add(msg)
    _touch(db, project, user.id)
    db.commit()
    db.refresh(msg)
    part_by_id = {p.id: p for p in proc.participants}
    return message_out(msg, draft.edge, part_by_id, docs_for_messages(db, [msg]), draft.nodes)


# Объявлен ДО /{message_id}, иначе FastAPI примет "reorder" за message_id.
@router.patch("/{process_id}/messages/reorder", response_model=list[MessageOut])
def reorder_messages(
    process_id: uuid.UUID,
    payload: ReorderPayload,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> list[MessageOut]:
    """Новый порядок шагов сценария одной транзакцией: ids сверху вниз → order 0..N-1.

    Требуем ПОЛНЫЙ перечень (в отличие от перестановки участников): у сообщений
    order структурен — по нему фрагменты (alt/opt/loop) держат свой диапазон, и
    частичный список оставил бы дубли позиций, то есть блок, накрывающий не то,
    что видел пользователь.

    Границы фрагментов НЕ пересчитываем — решение пользователя 2026-08-10:
    фрагмент это диапазон ПОЗИЦИЙ, и кто въехал в строки блока, тот в нём и есть.
    """
    proc = _get_process(db, process_id, project)
    by_id = {m.id: m for m in proc.messages}
    if len(payload.ids) != len(by_id) or set(payload.ids) != set(by_id):
        raise HTTPException(
            status_code=422,
            detail="Новый порядок должен перечислять все сообщения процесса ровно по разу",
        )
    for index, mid in enumerate(payload.ids):
        by_id[mid].order = index
    _touch(db, project, user.id)
    db.commit()

    part_by_id = {p.id: p for p in proc.participants}
    edge_cache: dict[uuid.UUID, Edge | None] = {}

    def edge_of(eid: uuid.UUID | None) -> Edge | None:
        if eid is None:
            return None
        if eid not in edge_cache:
            edge_cache[eid] = db.get(Edge, eid)
        return edge_cache[eid]

    doc_by_id = docs_for_messages(db, proc.messages)
    all_nodes = load_nodes(db, project.id)  # путь узла схемы в doc_node_path
    return [
        message_out(m, edge_of(m.edge_id), part_by_id, doc_by_id, all_nodes)
        for m in sorted(proc.messages, key=lambda m: m.order)
    ]


# Скалярные поля правки шага — применяются как есть. Ссылочные поля в перечень НЕ
# входят: у каждого своя проверка принадлежности проекту (см. update_message).
_MESSAGE_SCALARS = ("caption", "order")
# Ссылочные поля правки шага: каждое проверяется _check_doc и ему подобными.
_MESSAGE_REFS: tuple[str, ...] = ("doc_id",)
# Служебные поля контракта — НЕ поля шага: CAS-токен читается и выбрасывается,
# в setattr не попадает никогда (паттерн update_node / update_doc).
_MESSAGE_META: tuple[str, ...] = ("base_version",)




@router.get(
    "/{process_id}/messages/{message_id}/docs",
    response_model=MessageDocCatalog,
)
def message_doc_catalog(
    process_id: uuid.UUID,
    message_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> MessageDocCatalog:
    """Схемы, которыми можно задокументировать шаг, плюс владелец для подстановки.

    Считается НА БЭКЕ целиком: правило владельца (конец ребра, несущий логику) и скоуп
    (поддеревья участников) — доменные знания, и вторая их реализация на фронте
    неизбежно разошлась бы с этой, как это уже случалось с проекцией концов связи
    (см. list_directions).

    Читателю ручка открыта: состояние документации — знание, а не действие над ней.
    """
    proc = _get_process(db, process_id, project)
    msg = db.get(ProcessMessage, message_id)
    if msg is None or msg.process_id != proc.id:
        raise HTTPException(status_code=404, detail="Сообщение не найдено")
    all_nodes = load_nodes(db, project.id)
    part_by_id = {p.id: p for p in proc.participants}
    edge = db.get(Edge, msg.edge_id) if msg.edge_id else None
    owner, choices = doc_catalog(db, msg, part_by_id, edge, all_nodes)
    return MessageDocCatalog(
        default_node_id=owner,
        docs=[
            DocChoiceOut(
                id=c.doc.id,
                node_id=c.node.id,
                node_path=c.path,
                name=c.doc.name,
                kind=c.doc.kind,
                operation=c.doc.operation,
                described=c.doc.described,
            )
            for c in choices
        ],
    )


@router.patch("/{process_id}/messages/{message_id}", response_model=MessageOut)
def update_message(
    process_id: uuid.UUID,
    message_id: uuid.UUID,
    payload: MessageUpdate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> MessageOut:
    proc = _get_process(db, process_id, project)
    msg = db.get(ProcessMessage, message_id)
    if msg is None or msg.process_id != proc.id:
        raise HTTPException(status_code=404, detail="Сообщение не найдено")
    data = payload.model_dump(exclude_unset=True)
    # CAS (Д9): правка от устаревшей версии не затирает чужую. None — компенсация
    # undo без проверки (паттерн update_node / update_doc).
    base_version = data.pop("base_version", None)
    check_cas(msg.version, base_version, "Шаг изменён в другой сессии")
    # Поля применяются ПО БЕЛОМУ СПИСКУ, а не циклом setattr по payload. Причина не в
    # аккуратности: сюда приезжает ССЫЛОЧНОЕ поле (привязка шага к схеме логики),
    # а слепое присваивание приняло бы ссылку на строку ЧУЖОГО проекта — межпроектная
    # изоляция держалась бы на честном слове клиента (дефект Д6,
    # docs/plan-process-docs-challenge.md).
    # ⚠️ Добавил поле в MessageUpdate — добавь его И СЮДА: в _MESSAGE_SCALARS, если оно
    # скалярное, в _MESSAGE_META, если оно служебное и полем шага не является, либо
    # отдельной веткой с проверкой принадлежности проекту, если ссылочное.
    # Забывчивость ловит тест test_белый_список_полей_правки_шага_полон.
    for field in _MESSAGE_SCALARS:
        if field in data:
            setattr(msg, field, data[field])
    if "doc_id" in data:
        with _rules():
            check_step_doc(db, data["doc_id"], project.id)
        msg.doc_id = data["doc_id"]
    if data:
        msg.version += 1
    _touch(db, project, user.id)
    db.commit()
    db.refresh(msg)
    part_by_id = {p.id: p for p in proc.participants}
    return message_out(
        msg,
        db.get(Edge, msg.edge_id) if msg.edge_id else None,
        part_by_id,
        docs_for_messages(db, [msg]),
        load_nodes(db, project.id),
    )


@router.delete(
    "/{process_id}/messages/{message_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_message(
    process_id: uuid.UUID,
    message_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> None:
    proc = _get_process(db, process_id, project)
    msg = db.get(ProcessMessage, message_id)
    if msg is None or msg.process_id != proc.id:
        raise HTTPException(status_code=404, detail="Сообщение не найдено")
    db.delete(msg)
    _touch(db, project, user.id)
    db.commit()


# ── Фрагменты (свободный слой) ────────────────────────────────────────────────
def _span_steps(db: Session, process_id: uuid.UUID, from_order: int, to_order: int) -> int:
    """Сколько шагов накрывает охват — верхняя граница на число ветвей."""
    return (
        db.query(ProcessMessage)
        .filter(
            ProcessMessage.process_id == process_id,
            ProcessMessage.order >= from_order,
            ProcessMessage.order <= to_order,
        )
        .count()
    )




@router.post(
    "/{process_id}/fragments",
    response_model=FragmentOut,
    status_code=status.HTTP_201_CREATED,
)
def create_fragment(
    process_id: uuid.UUID,
    payload: FragmentCreate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> FragmentOut:
    proc = _get_process(db, process_id, project)
    with _rules():
        check_fragment(
            payload.kind,
            payload.from_order,
            payload.to_order,
            payload.branches,
            _span_steps(db, proc.id, payload.from_order, payload.to_order),
        )
    frag = ProcessFragment(
        process_id=proc.id,
        kind=payload.kind,
        from_order=payload.from_order,
        to_order=payload.to_order,
        guard=payload.guard,
        branches=[
            ProcessFragmentBranch(start_order=b.start_order, guard=b.guard)
            for b in payload.branches
        ],
    )
    db.add(frag)
    _touch(db, project, user.id)
    db.commit()
    db.refresh(frag)
    return fragment_out(frag)


@router.patch("/{process_id}/fragments/{fragment_id}", response_model=FragmentOut)
def update_fragment(
    process_id: uuid.UUID,
    fragment_id: uuid.UUID,
    payload: FragmentUpdate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> FragmentOut:
    proc = _get_process(db, process_id, project)
    frag = db.get(ProcessFragment, fragment_id)
    if frag is None or frag.process_id != proc.id:
        raise HTTPException(status_code=404, detail="Фрагмент не найден")
    data = payload.model_dump(exclude_unset=True)
    # Проверяем БУДУЩЕЕ состояние до записи в объект: иначе отказ оставляет в сессии
    # грязный фрагмент с невалидными границами (в БД он не уедет — коммита нет, — но
    # рассчитывать на это незачем).
    merged = {
        field: data.get(field, getattr(frag, field))
        for field in ("kind", "from_order", "to_order")
    }
    # Ветви: пришли — заменяем целиком, не пришли — берём текущие (охват мог сдвинуться,
    # и они обязаны остаться внутри него — это и ловит проверка).
    new_branches = payload.branches if "branches" in data else None
    branches = (
        new_branches
        if new_branches is not None
        else [BranchIn(start_order=b.start_order, guard=b.guard) for b in frag.branches]
    )
    with _rules():
        check_fragment(
            merged["kind"],
            merged["from_order"],
            merged["to_order"],
            branches,
            _span_steps(db, proc.id, merged["from_order"], merged["to_order"])
            if new_branches is not None
            else None,
        )
    for field, value in data.items():
        if field != "branches":
            setattr(frag, field, value)
    if new_branches is not None:
        # delete-orphan снимет прежние строки; порядок в БД не важен — relationship
        # отдаёт их по возрастанию границы.
        frag.branches = [
            ProcessFragmentBranch(start_order=b.start_order, guard=b.guard) for b in new_branches
        ]
    _touch(db, project, user.id)
    db.commit()
    db.refresh(frag)
    return fragment_out(frag)


@router.delete(
    "/{process_id}/fragments/{fragment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_fragment(
    process_id: uuid.UUID,
    fragment_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> None:
    proc = _get_process(db, process_id, project)
    frag = db.get(ProcessFragment, fragment_id)
    if frag is None or frag.process_id != proc.id:
        raise HTTPException(status_code=404, detail="Фрагмент не найден")
    db.delete(frag)
    _touch(db, project, user.id)
    db.commit()


# ── Композитор: каналы между парой участников ─────────────────────────────────
@router.get("/{process_id}/directions", response_model=list[DirectionOut])
def list_directions(
    process_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> list[DirectionOut]:
    """Куда МОЖНО завести сообщение — сразу для всех пар участников процесса.

    Композитор спрашивает про одну пару (/channels); индикации при протягивании
    нужна вся картина, и считать её на клиенте нельзя: проекция концов связи через
    предков живёт здесь, и вторая реализация неизбежно разошлась бы с валидатором.
    """
    proc = _get_process(db, process_id, project)
    all_nodes = load_nodes(db, project.id)
    participant_ids = bound_node_ids(proc.participants)
    edges = db.query(Edge).filter(Edge.project_id == project.id).all()
    return [
        DirectionOut(from_id=f, to_id=t)
        for f, t in sorted(legal_directions(edges, participant_ids, all_nodes))
    ]


@router.get("/{process_id}/channels", response_model=list[ChannelOut])
def list_channels(
    process_id: uuid.UUID,
    a: uuid.UUID,
    b: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> list[ChannelOut]:
    proc = _get_process(db, process_id, project)
    return channels_between(db, project.id, proc, a, b)
