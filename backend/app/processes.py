"""Доменное ядро бизнес-процессов: канал → плечи, проекция концов, сериализация.

Связь C4 (Edge) — не одна стрелка, а «канал с плечами»: синхронный канал отдаёт
два плеча (вызов forward + ответ return), асинхронный — одно (forward, рисуется как
событие). Синхронность задаётся явно тумблером в UI связи (Edge.is_synchronous;
дефолт — синхронный). Это «запертый
слой» из ТЗ §0: сообщение процесса может ссылаться только на легальное плечо
существующего канала, концы которого проецируются на участников процесса.

Здесь же — доменные строители ответа (сборка ProcessDetail, сериализация
участников/сообщений, стиль стрелки) и запросы (карта узлов проекта, множество
узлов области), которые раньше жили прямо в HTTP-слое routers/processes.py.
HTTP-слой лишь валидирует вход, зовёт домен и отдаёт response_model.
"""

import uuid
from collections.abc import Iterable
from dataclasses import dataclass

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.business_process import BusinessProcess
from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.process_fragment import ProcessFragment
from app.models.process_message import ProcessMessage
from app.models.process_participant import ProcessParticipant
from app.schemas.process import (
    BranchOut,
    FragmentOut,
    MessageInvalidReason,
    MessageOut,
    ParticipantOut,
    ProcessDetail,
    ProcessListItem,
)
from app.tree import ancestors, subtree_ids


def edge_is_synchronous(edge: Edge) -> bool:
    """Синхронен ли канал. Задаётся явно тумблером в UI связи (Edge.is_synchronous).
    Авто-определения по технологии больше нет: оно зависело от текста, что неочевидно.
    Дефолт для связей без явного значения (null, в т.ч. легаси) — синхронный."""
    return edge.is_synchronous if edge.is_synchronous is not None else True


@dataclass(frozen=True)
class Leg:
    """Плечо канала. kind — производное для рендера (forward/return/async)."""

    leg: str  # "forward" | "return" — что хранится на сообщении
    kind: str  # "forward" | "return" | "async" — стиль стрелки
    from_id: uuid.UUID  # сырой конец-источник (узел C4)
    to_id: uuid.UUID  # сырой конец-цель (узел C4)
    default_caption: str | None  # подпись по умолчанию


def legs_for_edge(edge: Edge) -> list[Leg]:
    """Набор плеч канала: forward всегда; return — только для синхронного."""
    sync = edge_is_synchronous(edge)
    legs = [
        Leg(
            leg="forward",
            kind="forward" if sync else "async",
            from_id=edge.source_id,
            to_id=edge.target_id,
            default_caption=edge.label,
        )
    ]
    if sync:
        legs.append(
            Leg(
                leg="return",
                kind="return",
                from_id=edge.target_id,
                to_id=edge.source_id,
                default_caption="ответ",
            )
        )
    return legs


def resolve_to_participant(
    node_id: uuid.UUID,
    participant_ids: set[uuid.UUID],
    all_nodes: dict[uuid.UUID, Node],
) -> uuid.UUID | None:
    """Ближайший участник, покрывающий конец ребра: сам узел или ближайший
    предок-участник (самый глубокий). None — конец не покрыт ни одним участником.

    Покрывает и прямые, и сквозные связи (конец вглубь чужого поддерева проецируется
    на предка-участника).
    """
    if node_id in participant_ids:
        return node_id
    # ancestors() даёт корень→родитель; реверс → идём от ближайшего предка вверх,
    # берём первого участника (самый глубокий побеждает).
    for a in reversed(ancestors(all_nodes, node_id)):
        if a.id in participant_ids:
            return a.id
    return None


def legal_directions(
    edges: list[Edge],
    participant_ids: set[uuid.UUID],
    all_nodes: dict[uuid.UUID, Node],
) -> set[tuple[uuid.UUID, uuid.UUID]]:
    """Пары участников (откуда, куда), между которыми есть ПЛЕЧО канала.

    Ровно то, что композитор потом покажет списком, но сразу для всей схемы: одним
    проходом по рёбрам, тем же резолвом проекции. Нужно индикации в композиторе —
    подсветить при протягивании, куда сообщение завести можно, а куда нет.

    Направление здесь и есть ответ на вопрос про асинхронность: у асинхронного
    канала ответного плеча не существует (legs_for_edge), поэтому обратная сторона
    в набор просто не попадёт — отдельной проверки не нужно.
    """
    out: set[tuple[uuid.UUID, uuid.UUID]] = set()
    for edge in edges:
        for leg in legs_for_edge(edge):
            f = resolve_to_participant(leg.from_id, participant_ids, all_nodes)
            t = resolve_to_participant(leg.to_id, participant_ids, all_nodes)
            if f is not None and t is not None and f != t:
                out.add((f, t))
    return out


def process_list_items(
    db: Session,
    project_id: uuid.UUID,
    all_nodes: dict[uuid.UUID, Node],
    only_ids: set[uuid.UUID] | None = None,
) -> list[ProcessListItem]:
    """Список процессов проекта с счётчиком сообщений и статусами участников.

    Общий строитель для GET /processes (only_ids=None — все процессы проекта) и
    GET /nodes/{id}/processes (only_ids — процессы с участием узла/поддерева).
    Сортировка — по дате создания (стабильный порядок списка).
    """
    if only_ids is not None and not only_ids:
        return []
    proc_filter = [BusinessProcess.project_id == project_id]
    if only_ids is not None:
        proc_filter.append(BusinessProcess.id.in_(only_ids))
    # Счётчик сообщений только по отобранным процессам (join к BusinessProcess).
    # Comprehension с распаковкой строк: dict(Row...) не типизируется (Row не
    # подтип tuple для mypy), а {pid: cnt for ...} выводится чисто.
    counts: dict[uuid.UUID, int] = {
        pid: cnt
        for pid, cnt in (
            db.query(ProcessMessage.process_id, func.count(ProcessMessage.id))
            .join(BusinessProcess, BusinessProcess.id == ProcessMessage.process_id)
            .filter(*proc_filter)
            .group_by(ProcessMessage.process_id)
            .all()
        )
    }
    # Статусы узлов-участников по процессам — для производного бейджа в списке.
    proc_statuses: dict[uuid.UUID, set[str]] = {}
    for proc_id, node_id in (
        db.query(ProcessParticipant.process_id, ProcessParticipant.node_id)
        .join(BusinessProcess, BusinessProcess.id == ProcessParticipant.process_id)
        .filter(*proc_filter)
        .all()
    ):
        node = all_nodes.get(node_id)
        if node is not None:
            proc_statuses.setdefault(proc_id, set()).add(node.status)
    out: list[ProcessListItem] = []
    for proc in (
        db.query(BusinessProcess).filter(*proc_filter).order_by(BusinessProcess.created_at).all()
    ):
        scope = all_nodes.get(proc.scope_node_id) if proc.scope_node_id else None
        out.append(
            ProcessListItem(
                id=proc.id,
                name=proc.name,
                scope_node_id=proc.scope_node_id,
                scope_name=scope.name if scope else None,
                message_count=counts.get(proc.id, 0),
                statuses=sorted(proc_statuses.get(proc.id, set())),  # type: ignore[arg-type]
            )
        )
    return out


# ── Запросы и сериализация (питали HTTP-слой routers/processes.py) ────────────
def load_nodes(db: Session, project_id: uuid.UUID) -> dict[uuid.UUID, Node]:
    """Карта узлов проекта — для проекции концов и проверки области."""
    return {n.id: n for n in db.query(Node).filter(Node.project_id == project_id).all()}


def scope_node_ids(
    all_nodes: dict[uuid.UUID, Node], scope_node_id: uuid.UUID | None
) -> set[uuid.UUID]:
    """Множество узлов, из которых можно брать участников: поддерево scope или вся схема."""
    if scope_node_id is None:
        return set(all_nodes.keys())
    return subtree_ids(all_nodes, scope_node_id)


def _message_kind(leg: str, edge: Edge | None) -> str:
    """Стиль стрелки: return → return; forward на async-канале → async; иначе forward."""
    if leg == "return":
        return "return"
    if edge is not None and not edge_is_synchronous(edge):
        return "async"
    return "forward"


def default_caption(leg: str, edge: Edge | None) -> str | None:
    """Подпись, которую канал даёт плечу: метка связи у вызова, «ответ» у ответа.

    Точка применения ОДНА — создание шага (create_message замораживает это значение
    в собственную подпись). При чтении подпись больше не выводится: см. message_out.
    """
    if leg == "return":
        return "ответ"
    return edge.label if edge is not None else None


def participant_out(p: ProcessParticipant, node: Node | None) -> ParticipantOut:
    """Сериализация участника процесса (линия жизни).

    Узла может не быть — участник непривязан (имя не сопоставили при импорте) или
    осиротел (узел удалили, FK погасил ссылку). Тогда имя берём у самого участника,
    а свойств узла нет вовсе — их неоткуда взять, и придумывать нельзя: «сервис
    existing» по умолчанию выглядел бы как настоящий узел.
    """
    if node is None:
        return ParticipantOut(
            id=p.id, node_id=None, name=p.name,
            role=None, shape=None, is_external=None, status=None, order=p.order,
        )
    return ParticipantOut(
        id=p.id,
        node_id=p.node_id,
        name=node.name,
        role=node.role,
        shape=node.shape,  # type: ignore[arg-type]
        is_external=node.is_external,
        status=node.status,  # type: ignore[arg-type]
        order=p.order,
    )


def participant_node(p: ProcessParticipant, all_nodes: dict[uuid.UUID, Node]) -> Node | None:
    """Узел участника, если он есть и жив. Единая точка — иначе индексация
    all_nodes[p.node_id] падала бы на непривязанных."""
    return all_nodes.get(p.node_id) if p.node_id else None


def bound_node_ids(participants: Iterable[ProcessParticipant]) -> set[uuid.UUID]:
    """Узлы участников для проекции концов связи. Непривязанные исключены: плечо
    канала на них не приземляется — у них нет узла, к которому канал мог бы вести."""
    return {p.node_id for p in participants if p.node_id is not None}


def message_out(
    msg: ProcessMessage,
    edge: Edge | None,
    part_by_id: dict[uuid.UUID, ProcessParticipant],
    doc_by_id: dict[uuid.UUID, NodeDoc],
) -> MessageOut:
    """Сериализация сообщения процесса.

    ПОДПИСЬ У ШАГА ВСЕГДА СВОЯ (решение пользователя 2026-08-11): отдаём ровно то,
    что лежит в строке, и ничего не выводим из канала. Прежде пустая подпись значила
    «показывать то, что даёт канал», и два неотличимых на вид шага вели себя
    по-разному — ради чего всё и менялось. Дефолт канала теперь ЗАМОРАЖИВАЕТСЯ ОДИН
    РАЗ, при создании шага (create_message), и дальше живёт как обычный текст.
    Цена решения принята сознательно: переименование связи в схеме до процессов
    больше не доезжает — подписи правятся руками.

    Самосообщение (внутренняя операция участника): концы совпадают, связи C4 нет.
    kind="self", valid всегда true (это не повисшая связь — её тут и не было).

    doc_by_id — схемы логики, на которые ссылаются шаги, загруженные ОДНИМ запросом.
    Параметр обязателен намеренно: с дефолтом «пусто» забытый вызов молча отдавал бы
    шаги без привязки, а витрина показала бы их непривязанными — тихая потеря данных.
    Пустой словарь законен (в наборе нет ни одной привязки), отсутствующий id — тоже:
    ON DELETE SET NULL уже обнулил бы ссылку, поэтому промах карты означает лишь, что
    вызывающий не грузил схемы, и шаг честно едет непривязанным.
    """
    is_self = msg.from_participant_id == msg.to_participant_id
    caption = msg.caption
    invalid_reason: MessageInvalidReason | None = None
    if is_self:
        kind = "self"
        valid = True
    else:
        kind = _message_kind(msg.leg, edge)
        if msg.edge_id is None or edge is None:
            invalid_reason = "edge_deleted"
        elif msg.leg == "return" and not edge_is_synchronous(edge):
            # Канал сменил синхронность уже ПОСЛЕ создания шага: плеча «ответ» у
            # асинхронного канала нет (legs_for_edge), и create_message такое
            # отклоняет — но существующий шаг переживал смену молча и продолжал
            # считаться корректным. Связь при этом на месте, поэтому причина
            # отдельная: «Восстановить связи» тут бессильна (она чинит только
            # edge_id IS NULL), лечится возвратом синхронности или удалением шага.
            invalid_reason = "leg_gone"
        valid = invalid_reason is None
    # Привязка: промах карты значит «вызывающий не грузил схемы» — шаг честно едет
    # непривязанным, а не падает (см. docstring).
    doc = doc_by_id.get(msg.doc_id) if msg.doc_id else None
    return MessageOut(
        id=msg.id,
        order=msg.order,
        edge_id=msg.edge_id,
        leg=msg.leg,  # type: ignore[arg-type]
        kind=kind,  # type: ignore[arg-type]
        caption=caption,
        technology=edge.technology if edge is not None else None,
        # Концы — УЧАСТНИКИ, а не узлы: у непривязанного узла нет, и два таких конца
        # были бы неразличимы. Граница слоёв: C4 (каналы, плечи, направления) говорит
        # узлами, слой процесса — участниками. Заодно ушла лишняя конвертация:
        # id участника лежит прямо в строке сообщения.
        from_participant_id=msg.from_participant_id,
        to_participant_id=msg.to_participant_id,
        valid=valid,
        invalid_reason=invalid_reason,
        doc_id=doc.id if doc else None,
        doc_node_id=doc.node_id if doc else None,
        doc_name=doc.name if doc else None,
        edge_synchronous=None if edge is None else edge_is_synchronous(edge),
    )


def reattach_dangling(
    db: Session,
    proc: BusinessProcess,
    all_nodes: dict[uuid.UUID, Node],
    part: ProcessParticipant | None = None,
) -> tuple[int, int, list[uuid.UUID]]:
    """Подхват каналов для повисших шагов. part=None — по всему процессу.

    Возвращает (подхвачено, осталось, id подхваченных). Список нужен откату: он
    отцепляет ровно то, что прицепила эта операция.

    Зачем: пока участник был непривязан, его шаги существовать как плечи канала не
    могли — узла-то не было. После привязки канал в схеме может найтись, и шаг обязан
    перестать быть повисшим: иначе пользователь видит сломанные стрелки при живых
    каналах и починить их нечем (edge_id не патчится ни через API, ни в интерфейсе).

    Подхватываем ТОЛЬКО при единственном кандидате. Между парой узлов бывает несколько
    каналов (REST и Kafka), и выбирать за пользователя нельзя — такой шаг остаётся
    повисшим и попадает в отчёт числом.
    """
    part_by_id = {p.id: p for p in proc.participants}
    participant_ids = bound_node_ids(proc.participants)
    edges = db.query(Edge).filter(Edge.project_id == proc.project_id).all()
    attached: list[uuid.UUID] = []
    left = 0
    for msg in proc.messages:
        if msg.edge_id is not None:
            continue
        if msg.from_participant_id == msg.to_participant_id:
            continue  # самосообщение — канала у него и не было
        if part is not None and part.id not in (msg.from_participant_id, msg.to_participant_id):
            continue
        frm = part_by_id.get(msg.from_participant_id)
        to = part_by_id.get(msg.to_participant_id)
        if frm is None or to is None or frm.node_id is None or to.node_id is None:
            left += 1  # второй конец всё ещё непривязан — цеплять не к чему
            continue
        candidates = [
            edge
            for edge in edges
            for leg in legs_for_edge(edge)
            if leg.leg == msg.leg
            and resolve_to_participant(leg.from_id, participant_ids, all_nodes) == frm.node_id
            and resolve_to_participant(leg.to_id, participant_ids, all_nodes) == to.node_id
        ]

        if len(candidates) == 1:
            msg.edge_id = candidates[0].id
            attached.append(msg.id)
        else:
            left += 1
    return len(attached), left, attached


def detach_messages(proc: BusinessProcess, part: ProcessParticipant) -> int:
    """Отцепить шаги участника от каналов — компенсация подхвата при снятии привязки.
    Без неё undo оставил бы шаги привязанными к каналам узла, которого у участника уже
    нет: концы плеча перестали бы проецироваться на него."""
    detached = 0
    for msg in proc.messages:
        if msg.edge_id is None:
            continue
        if part.id in (msg.from_participant_id, msg.to_participant_id):
            msg.edge_id = None
            detached += 1
    return detached


def fragment_out(frag: ProcessFragment) -> FragmentOut:
    """Фрагмент в контракт. Ветви — по возрастанию границы (порядок держит relationship),
    первой ветви среди них нет: она начинается с from_order, её условие — в guard."""
    return FragmentOut(
        id=frag.id,
        kind=frag.kind,  # type: ignore[arg-type]
        from_order=frag.from_order,
        to_order=frag.to_order,
        guard=frag.guard,
        branches=[BranchOut(start_order=b.start_order, guard=b.guard) for b in frag.branches],
    )


def docs_for_messages(
    db: Session, msgs: Iterable[ProcessMessage]
) -> dict[uuid.UUID, NodeDoc]:
    """Схемы, на которые ссылаются шаги, — ОДНИМ запросом (см. message_out).

    Лениво по одной это был бы N+1: у монолита в процессе десяток шагов. Тело схемы не
    тянем — оно отложено (NodeDoc.content), а витрине нужны только имя и узел.
    """
    ids = {m.doc_id for m in msgs if m.doc_id}
    if not ids:
        return {}
    return {d.id: d for d in db.query(NodeDoc).filter(NodeDoc.id.in_(ids)).all()}


def build_process_detail(
    db: Session, proc: BusinessProcess, all_nodes: dict[uuid.UUID, Node]
) -> ProcessDetail:
    """Полная сборка процесса: участники (по order), сообщения (по order, с плечами
    и валидностью), фрагменты (по from_order). Связь сообщения подгружается лениво
    с кэшем (одна и та же связь у многих сообщений не грузится повторно)."""
    parts = sorted(proc.participants, key=lambda p: p.order)
    part_by_id = {p.id: p for p in parts}
    edge_cache: dict[uuid.UUID, Edge | None] = {}

    def edge_of(eid: uuid.UUID | None) -> Edge | None:
        if eid is None:
            return None
        if eid not in edge_cache:
            edge_cache[eid] = db.get(Edge, eid)
        return edge_cache[eid]

    doc_by_id = docs_for_messages(db, proc.messages)
    messages = [
        message_out(m, edge_of(m.edge_id), part_by_id, doc_by_id)
        for m in sorted(proc.messages, key=lambda m: m.order)
    ]
    fragments = [fragment_out(f) for f in sorted(proc.fragments, key=lambda f: f.from_order)]
    scope_node = all_nodes.get(proc.scope_node_id) if proc.scope_node_id else None
    return ProcessDetail(
        id=proc.id,
        name=proc.name,
        scope_node_id=proc.scope_node_id,
        scope_name=scope_node.name if scope_node else None,
        participants=[participant_out(p, participant_node(p, all_nodes)) for p in parts],
        messages=messages,
        fragments=fragments,
    )
