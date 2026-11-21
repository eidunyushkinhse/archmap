"""Импорт бизнес-процесса из текста mermaid sequenceDiagram.

Разбор живёт на бэке (как и импорт YAML): сопоставление имён с узлами и подбор
каналов всё равно требуют базы, а вторая реализация на клиенте неизбежно разошлась
бы с этой. Заодно импорт достаётся API и MCP-агенту.

ПОДДЕРЖИВАЕМОЕ ПОДМНОЖЕСТВО: participant/actor (с алиасом и без), стрелки
->> / -->> / -) / -> / --> / --), самосообщения, alt/opt/loop/par + else + end.
Не поддерживаем: autonumber, activate/deactivate, note, box, ссылки. Непонятые
строки НЕ выпадают молча — они уходят в отчёт (unsupported), иначе пользователь
считал бы импорт полным.

Две директивы кругового прогона архива (строки-комментарии mermaid): «%% archmap-doc:
адрес схемы» перед шагом — привязка шага к схеме логики, и «%% archmap-node: адрес
узла» перед участником — узел участника, чьё имя в проекте не уникально (тёзки).
Адрес узла — путь с уточнителями тёзок (app/node_ref.py); разрешился однозначно —
участник привязывается к этому узлу, иначе сопоставление по имени, как всегда.
"""

import re
import uuid
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from app import versions
from app.domain_types import (
    FRAGMENT_KINDS,
    FragmentKind,
    ImportDocStatus,
    ImportStepStatus,
    MessageLeg,
    pick,
)
from app.models.business_process import BusinessProcess
from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.process_fragment import ProcessFragment, ProcessFragmentBranch
from app.models.process_message import ProcessMessage
from app.models.process_participant import ProcessParticipant
from app.models.project import Project
from app.models.user import User
from app.node_ref import NodeIndex, node_addresses, qualified_node_hits
from app.processes import legs_for_edge, node_path, resolve_to_participant
from app.schemas.process_import import (
    ImportNodeCandidate,
    ImportParticipantPreview,
    ImportStepPreview,
    ProcessImportPreview,
    ProcessImportResult,
    ProcessReplaceResult,
)
from app.text import sequence_text

# Стрелка → плечо канала. Вид (синхронный/событие) определяет сам канал в схеме,
# поэтому здесь важно только направление: forward или return.
_ARROWS: list[tuple[str, MessageLeg]] = [
    ("-->>", "return"),
    ("--)", "forward"),
    ("-->", "return"),
    ("->>", "forward"),
    ("-)", "forward"),
    ("->", "forward"),
]
_PARTICIPANT_RE = re.compile(r"^(?:participant|actor)\s+(.+)$", re.IGNORECASE)
_FRAGMENT_RE = re.compile(r"^(alt|opt|loop|par)\b\s*(.*)$", re.IGNORECASE)
_ELSE_RE = re.compile(r"^else\b\s*(.*)$", re.IGNORECASE)
_IGNORED_RE = re.compile(
    r"^(sequencediagram|autonumber|activate|deactivate|note|box|link|links|title)\b",
    re.IGNORECASE,
)
# Привязка шага к схеме логики в круговом прогоне (Ф7): строка-комментарий ПЕРЕД
# шагом. Ключ — archmap-doc, в семье префикса archmap- из mmd_header.
_DOC_RE = re.compile(r"^%%\s*archmap-doc:\s*(.+)$", re.IGNORECASE)
# Узел СЛЕДУЮЩЕГО участника (архив пишет его участникам с неуникальным именем).
_NODE_RE = re.compile(r"^%%\s*archmap-node:\s*(.+)$", re.IGNORECASE)


@dataclass
class ParsedMessage:
    frm: str  # алиас участника
    to: str
    leg: MessageLeg
    caption: str | None
    # Адрес схемы логики из «%% archmap-doc: путь узла / имя схемы» перед шагом (Ф7).
    # Резолв в doc_id — на применении; не разрешился — шаг едет непривязанным.
    doc_address: str | None = None


@dataclass
class ParsedBranch:
    start_row: int
    guard: str | None


@dataclass
class ParsedFragment:
    kind: FragmentKind
    from_row: int
    to_row: int
    guard: str | None
    branches: list[ParsedBranch] = field(default_factory=list)


@dataclass
class ParsedDiagram:
    # Порядок объявления участников = порядок колонок. Алиас → отображаемое имя.
    participants: list[tuple[str, str]] = field(default_factory=list)
    # Алиас → адрес узла из «%% archmap-node: …» перед объявлением участника.
    node_addresses: dict[str, str] = field(default_factory=dict)
    messages: list[ParsedMessage] = field(default_factory=list)
    fragments: list[ParsedFragment] = field(default_factory=list)
    unsupported: list[str] = field(default_factory=list)


def _split_arrow(body: str) -> tuple[str, MessageLeg, str] | None:
    """Разбор «A->>B» на (откуда, стрелка, куда). Стрелки ищем от длинной к короткой:
    иначе «-->>» распался бы по «->»."""
    for arrow, leg in _ARROWS:
        idx = body.find(arrow)
        if idx > 0:
            return body[:idx].strip(), leg, body[idx + len(arrow):].strip()
    return None


def parse_sequence(text: str) -> ParsedDiagram:
    """Текст mermaid → структура. Ошибок не бросает: всё непонятое уходит в
    unsupported, а разобранное остаётся — импорт «почти правильного» файла должен
    доводиться до превью, а не падать на первой странной строке."""
    out = ParsedDiagram()
    seen: dict[str, str] = {}  # алиас → имя
    stack: list[ParsedFragment] = []
    # Отложенный адрес схемы: «%% archmap-doc: …» привязывается к СЛЕДУЮЩЕМУ шагу.
    pending_doc: str | None = None
    # Отложенный адрес узла: «%% archmap-node: …» — к СЛЕДУЮЩЕМУ объявлению участника.
    pending_node: str | None = None

    def drop_pending_node() -> None:
        """Адрес узла, за которым не пришло объявление участника, — в отчёт."""
        nonlocal pending_node
        if pending_node is not None:
            out.unsupported.append(f"%% archmap-node: {pending_node}")
            pending_node = None

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("%%"):
            # Круговой прогон (Ф7): archmap-doc — привязка следующего шага к схеме
            # логики. Непонятая директива семьи archmap- (опечатка в ключе) — в
            # отчёт: раньше она выпадала молча вместе со всеми комментариями, и
            # привязка терялась тихо. ОБЫЧНЫЙ комментарий — по-прежнему законная
            # тишина (тест «комментарии и пустые строки не шумят»): комментарий —
            # это понятая строка без содержимого для импорта, а не непонятая.
            m = _DOC_RE.match(line)
            n = _NODE_RE.match(line)
            if m:
                if pending_doc is not None:
                    # Две привязки подряд: первая осталась бы без шага — в отчёт.
                    out.unsupported.append(f"%% archmap-doc: {pending_doc}")
                pending_doc = m.group(1).strip() or None
            elif n:
                drop_pending_node()  # два адреса подряд: первый остался бы без участника
                pending_node = n.group(1).strip() or None
            elif re.match(r"^%%\s*archmap-", line, re.IGNORECASE):
                out.unsupported.append(line)
            continue

        m = _PARTICIPANT_RE.match(line)
        if m:
            body = m.group(1).strip()
            parts = re.split(r"\s+as\s+", body, maxsplit=1, flags=re.IGNORECASE)
            alias = parts[0].strip()
            name = (parts[1].strip() if len(parts) > 1 else alias) or alias
            if alias not in seen:
                seen[alias] = name
                out.participants.append((alias, name))
                if pending_node is not None:
                    out.node_addresses[alias] = pending_node
                    pending_node = None
            drop_pending_node()
            continue

        drop_pending_node()  # адрес узла относится только к объявлению участника

        m = _FRAGMENT_RE.match(line)
        kind = pick(m.group(1).lower(), FRAGMENT_KINDS) if m else None
        if m and kind is not None:
            guard = m.group(2).strip() or None
            frag = ParsedFragment(
                kind=kind, from_row=len(out.messages), to_row=len(out.messages),
                guard=guard,
            )
            stack.append(frag)
            continue

        m = _ELSE_RE.match(line)
        if m:
            if stack:
                stack[-1].branches.append(
                    ParsedBranch(start_row=len(out.messages), guard=m.group(1).strip() or None)
                )
            else:
                out.unsupported.append(line)  # else без alt — считать его нечем
            continue

        if line.lower() == "end":
            if stack:
                frag = stack.pop()
                # Охват — по последнему сообщению внутри; пустой фрагмент отбрасываем:
                # диапазона позиций у него нет.
                if out.messages and len(out.messages) > frag.from_row:
                    frag.to_row = len(out.messages) - 1
                    out.fragments.append(frag)
            continue

        if _IGNORED_RE.match(line):
            # Заголовок диаграммы молчим, остальное — в отчёт: строка была, а в
            # результат не попала.
            if not re.match(r"^sequencediagram\b", line, re.IGNORECASE):
                out.unsupported.append(line)
            continue

        head, _, caption = line.partition(":")
        split = _split_arrow(head)
        if split is None:
            out.unsupported.append(line)
            continue
        frm, leg, to = split
        if not frm or not to:
            out.unsupported.append(line)
            continue
        for alias in (frm, to):
            if alias not in seen:  # участник без объявления — mermaid это позволяет
                seen[alias] = alias
                out.participants.append((alias, alias))
        text_caption = caption.strip() or None
        out.messages.append(
            ParsedMessage(frm=frm, to=to, leg=leg, caption=text_caption, doc_address=pending_doc)
        )
        pending_doc = None

    # Привязка, за которой не пришло ни одного шага, — в отчёт, а не в тишину.
    if pending_doc is not None:
        out.unsupported.append(f"%% archmap-doc: {pending_doc}")
    drop_pending_node()

    # Незакрытые фрагменты: закрываем последним сообщением — терять блок хуже, чем
    # додумать его конец (пользователь увидит охват в превью).
    while stack:
        frag = stack.pop()
        if out.messages and len(out.messages) > frag.from_row:
            frag.to_row = len(out.messages) - 1
            out.fragments.append(frag)
    out.fragments.sort(key=lambda f: (f.from_row, -f.to_row))
    return out


# Экспорт чистит текст так же (схлопывает пробелы, «;» → «,») и подставляет прочерк
# вместо пустой подписи — сверяем по той же норме, иначе сравнение врало бы.
_EXPORT_PLACEHOLDER = "—"


def caption_for_import(raw: str | None) -> str | None:
    """Подпись шага, какой её сохранять. None — подписи нет (шаг покажет пустую).

    Подпись у шага ВСЕГДА СВОЯ (решение пользователя 2026-08-11), выводимых больше
    нет — значит и сверять пришедший текст не с чем: что прочитали, то и сохраняем.
    Прежняя сверка с дефолтом канала (правка f5c3c40) держала ровно ту связь со
    схемой, от которой отказались; вместе с моделью ушла и она.
    Прочерк «—», которым экспорт обозначает пустую подпись, по-прежнему читается как
    «подписи нет», а не как текст из тире.
    """
    if raw is None or sequence_text(raw) in ("", _EXPORT_PLACEHOLDER):
        return None
    return raw


def channels_for(
    edges: list[Edge],
    all_nodes: dict[uuid.UUID, Node],
    participant_ids: set[uuid.UUID],
    from_node: uuid.UUID,
    to_node: uuid.UUID,
    leg: MessageLeg,
) -> list[Edge]:
    """Каналы, чьё плечо `leg` проецируется ровно на эту пару узлов.

    Шаг встаёт на канал, только если он единственный. Несколько кандидатов (между
    парой бывает и REST, и Kafka) — выбирать за пользователя нельзя, шаг останется
    повисшим и попадёт в отчёт.
    """
    return [
        edge
        for edge in edges
        for lg in legs_for_edge(edge)
        if lg.leg == leg
        and resolve_to_participant(lg.from_id, participant_ids, all_nodes) == from_node
        and resolve_to_participant(lg.to_id, participant_ids, all_nodes) == to_node
    ]


def _norm_address(raw: str) -> str:
    """Норма адреса схемы: та же чистка, что у экспортёра (схлопнуть пробелы,
    «;» → «,»), плюс casefold — адрес пишет машина, но человек правит руками."""
    return sequence_text(raw).casefold()


def _doc_address_map(
    db: Session, project_id: uuid.UUID, all_nodes: dict[uuid.UUID, Node]
) -> dict[str, list[NodeDoc]]:
    """Полный адрес «путь узла / имя схемы» → схемы проекта (Ф7, круговой прогон).

    Сверка ЦЕЛОЙ строкой, без разбиения на путь и имя: и в имени узла, и в имени
    схемы законен « / », и любое разбиение гадало бы. Значение — СПИСОК: имена
    узлов не уникальны, один адрес может накрыть две схемы; резолвим только
    однозначное — выбирать за пользователя нельзя (тот же принцип, что у
    channels_for). Не разрешилось — шаг едет непривязанным и попадает в алерт
    полноты AL34, что и правильно.
    """
    docs = (
        db.query(NodeDoc)
        .join(Node, Node.id == NodeDoc.node_id)
        .filter(Node.project_id == project_id)
        .all()
    )
    # Узел схемы адресуется и голым путём (как всегда), и путём с уточнителями
    # тёзок (так пишет архив, app/node_ref.py): голый путь тёзок накрывает обе их
    # одноимённые схемы и честно не резолвится, уточнённый — ровно одну.
    addresses = node_addresses(list(all_nodes.values()))
    out: dict[str, list[NodeDoc]] = {}
    for d in docs:
        if d.node_id not in all_nodes:
            continue
        keys = {
            _norm_address(f"{node_path(all_nodes, d.node_id)} / {d.name}"),
            _norm_address(f"{addresses.get(d.node_id, '')} / {d.name}"),
        }
        for addr in keys:
            out.setdefault(addr, []).append(d)
    return out


def _nodes_by_address(
    nodes: list[Node], parsed: "ParsedDiagram"
) -> dict[str, Node]:
    """Алиас → узел по «%% archmap-node: адрес» — только однозначный: точный путь,
    иначе путь с уточнителями тёзок. Не разрешилось — участник сопоставляется по
    имени, как всегда (выбирать за пользователя из тёзок нельзя)."""
    if not parsed.node_addresses:
        return {}
    flat, _fulls, _by_bare, by_path = NodeIndex.of(nodes)
    out: dict[str, Node] = {}
    for alias, address in parsed.node_addresses.items():
        hits = by_path.get(address) or qualified_node_hits(address, flat)
        if len(hits) == 1:
            out[alias] = flat[hits[0]]
    return out


def match_nodes_by_name(db: Session, project_id: uuid.UUID, names: list[str]) -> dict[str, list[Node]]:
    """Кандидаты-узлы для каждого имени из диаграммы. Сравнение регистронезависимое и
    без краевых пробелов; имена узлов НЕ уникальны (ограничения в БД нет), поэтому
    список — норма, а не исключение."""
    nodes = db.query(Node).filter(Node.project_id == project_id).all()
    by_key: dict[str, list[Node]] = {}
    for node in nodes:
        by_key.setdefault(node.name.strip().casefold(), []).append(node)
    return {name: by_key.get(name.strip().casefold(), []) for name in names}


@dataclass
class PartPlan:
    """Участник, каким его запишет ввоз: имя — узла, если привязан, иначе из диаграммы."""

    alias: str
    name: str
    node: Node | None


@dataclass
class StepPlan:
    msg: ParsedMessage
    frm: PartPlan
    to: PartPlan
    edge: Edge | None
    status: ImportStepStatus
    doc: NodeDoc | None
    doc_status: ImportDocStatus | None


@dataclass
class ImportPlan:
    """Расчёт ввоза без записи: общий у превью и применения, поэтому прогноз превью по
    шагам совпадает с тем, что запишет применение."""

    parsed: ParsedDiagram
    parts: list[PartPlan]
    steps: list[StepPlan]


def _load_nodes(db: Session, project_id: uuid.UUID) -> dict[uuid.UUID, Node]:
    return {n.id: n for n in db.query(Node).filter(Node.project_id == project_id).all()}


def _plan_parts(
    parsed: ParsedDiagram, mapping: dict[str, uuid.UUID | None], all_nodes: dict[uuid.UUID, Node]
) -> list[PartPlan]:
    """Несопоставленные участники заводятся непривязанными (решение пользователя): шаг
    сценария не должен пропадать из-за того, что имя не нашлось в схеме."""
    used: set[uuid.UUID] = set()
    parts: list[PartPlan] = []
    for alias, disp in parsed.participants:
        node_id = mapping.get(alias)
        node = all_nodes.get(node_id) if node_id else None
        # Узел, уже занятый другим участником, привязать нельзя (uq_participant_node):
        # такой участник остаётся непривязанным, а не роняет весь импорт.
        if node is not None and node.id in used:
            node = None
        if node is not None:
            used.add(node.id)
        parts.append(PartPlan(alias=alias, name=node.name if node else disp, node=node))
    return parts


def _step_status(
    frm: PartPlan, to: PartPlan, found: list[Edge]
) -> tuple[Edge | None, ImportStepStatus]:
    # Самосообщение (внутренняя операция участника) канала C4 не имеет и иметь не
    # должно — оно НЕ повисшее. Считаем его отдельно, а не вычитанием из общего числа
    # шагов: прежняя формула len(messages) − attached записывала каждую внутреннюю
    # операцию в «без связи» и врала в отчёте (находка приёмки 2026-08-10). Тот же
    # принцип у reattach_dangling и алерта AL26 — там самосообщения исключены явно.
    if frm is to:
        return None, "self"
    if frm.node is None or to.node is None:
        return None, "unbound"
    if len(found) == 1:
        return found[0], "attached"
    return None, "ambiguous" if found else "no_channel"


def plan_import(
    db: Session,
    project_id: uuid.UUID,
    parsed: ParsedDiagram,
    mapping: dict[str, uuid.UUID | None],
    all_nodes: dict[uuid.UUID, Node],
) -> ImportPlan:
    """Участники по mapping, у каждого шага — канал (только единственный подходящий) и
    схема логики по адресу (только однозначный). Ничего не пишет."""
    parts = _plan_parts(parsed, mapping, all_nodes)
    by_alias = {p.alias: p for p in parts}
    edges = db.query(Edge).filter(Edge.project_id == project_id).all()
    participant_ids = {p.node.id for p in parts if p.node is not None}
    # Адреса привязок (Ф7) — картой один раз на импорт, не запросом на шаг.
    doc_map = (
        _doc_address_map(db, project_id, all_nodes)
        if any(m.doc_address for m in parsed.messages)
        else {}
    )
    steps: list[StepPlan] = []
    for msg in parsed.messages:
        frm, to = by_alias[msg.frm], by_alias[msg.to]
        found = (
            channels_for(edges, all_nodes, participant_ids, frm.node.id, to.node.id, msg.leg)
            if frm is not to and frm.node is not None and to.node is not None
            else []
        )
        edge, status = _step_status(frm, to, found)
        # Привязка к схеме (Ф7): только однозначный адрес; промах и коллизия — шаг
        # едет непривязанным и честно попадает в алерт полноты AL34.
        doc: NodeDoc | None = None
        doc_status: ImportDocStatus | None = None
        if msg.doc_address:
            candidates = doc_map.get(_norm_address(msg.doc_address), [])
            doc = candidates[0] if len(candidates) == 1 else None
            doc_status = "linked" if doc is not None else "unresolved"
        steps.append(StepPlan(msg, frm, to, edge, status, doc, doc_status))
    return ImportPlan(parsed=parsed, parts=parts, steps=steps)


def _counts(plan: ImportPlan) -> dict[str, int]:
    status = [st.status for st in plan.steps]
    return {
        "attached": status.count("attached"),
        "self_messages": status.count("self"),
        "dangling": sum(1 for x in status if x in ("no_channel", "ambiguous", "unbound")),
    }


def build_preview(
    db: Session,
    project_id: uuid.UUID,
    text: str,
    name: str | None,
    overrides: dict[str, uuid.UUID | None] | None = None,
) -> "ProcessImportPreview":
    """Что получится из текста и с чем сопоставились имена. Ничего не пишет.

    overrides — уточнения поверх автосопоставления; по итоговому сопоставлению
    считается прогноз по шагам (тот же plan_import, что у применения)."""
    parsed = parse_sequence(text)
    names = [n for _, n in parsed.participants]
    matches = match_nodes_by_name(db, project_id, names)
    all_nodes = _load_nodes(db, project_id)
    by_address = _nodes_by_address(list(all_nodes.values()), parsed)
    participants = []
    for alias, disp in parsed.participants:
        cands = matches.get(disp, [])
        addressed = by_address.get(alias)
        if addressed is not None and addressed not in cands:
            cands = [*cands, addressed]  # переименованный узел: выбор должен его знать
        participants.append(
            ImportParticipantPreview(
                alias=alias,
                name=disp,
                # Авто-сопоставление ТОЛЬКО однозначное: по адресу узла (архив пишет
                # его тёзкам) либо по единственному кандидату имени — имена узлов не
                # уникальны, и выбирать за пользователя из тёзок нельзя.
                node_id=(
                    addressed.id if addressed is not None
                    else cands[0].id if len(cands) == 1 else None
                ),
                candidates=[
                    ImportNodeCandidate(
                        id=c.id,
                        name=c.name,
                        parent_name=(
                            all_nodes[c.parent_id].name
                            if c.parent_id and c.parent_id in all_nodes
                            else None
                        ),
                    )
                    for c in cands
                ],
            )
        )
    mapping: dict[str, uuid.UUID | None] = {p.alias: p.node_id for p in participants}
    mapping.update(overrides or {})
    plan = plan_import(db, project_id, parsed, mapping, all_nodes)
    return ProcessImportPreview(
        name=(name or "").strip() or "Импортированный процесс",
        participants=participants,
        message_count=len(parsed.messages),
        fragment_count=len(parsed.fragments),
        unsupported=parsed.unsupported,
        doc_refs=sum(1 for m in parsed.messages if m.doc_address),
        steps=[
            ImportStepPreview(
                order=order,
                from_name=st.frm.name,
                to_name=st.to.name,
                caption=caption_for_import(st.msg.caption),
                status=st.status,
                doc_address=st.msg.doc_address,
                doc_status=st.doc_status,
            )
            for order, st in enumerate(plan.steps)
        ],
        **_counts(plan),
    )


def _write(db: Session, proc: BusinessProcess, plan: ImportPlan) -> ProcessImportResult:
    """Записать участников, шаги и фрагменты плана в процесс (пустой)."""
    rows: dict[str, ProcessParticipant] = {}
    for order, part in enumerate(plan.parts):
        row = ProcessParticipant(
            id=uuid.uuid4(),
            process_id=proc.id,
            node_id=part.node.id if part.node else None,
            name=part.name,
            order=order,
        )
        db.add(row)
        rows[part.alias] = row
    db.flush()
    for order, st in enumerate(plan.steps):
        db.add(
            ProcessMessage(
                id=uuid.uuid4(),
                process_id=proc.id,
                order=order,
                edge_id=st.edge.id if st.edge else None,
                leg=st.msg.leg,
                from_participant_id=rows[st.msg.frm].id,
                to_participant_id=rows[st.msg.to].id,
                caption=caption_for_import(st.msg.caption),
                doc_id=st.doc.id if st.doc else None,
            )
        )
    for frag in plan.parsed.fragments:
        db.add(
            ProcessFragment(
                id=uuid.uuid4(),
                process_id=proc.id,
                kind=frag.kind,
                # Строки диаграммы = order сообщений: импорт нумерует их подряд.
                from_order=frag.from_row,
                to_order=frag.to_row,
                guard=frag.guard,
                branches=[
                    ProcessFragmentBranch(start_order=b.start_row, guard=b.guard)
                    for b in frag.branches
                    # Ветвь должна начинаться СТРОГО внутри охвата — то же правило,
                    # что держит API (иначе первой ветви не досталось бы ни шага).
                    if frag.from_row < b.start_row <= frag.to_row
                ],
            )
        )
    docs = [st.doc_status for st in plan.steps]
    return ProcessImportResult(
        process_id=proc.id,
        participants=len(plan.parts),
        unbound=sum(1 for p in plan.parts if p.node is None),
        messages=len(plan.steps),
        fragments=len(plan.parsed.fragments),
        unsupported=plan.parsed.unsupported,
        doc_linked=docs.count("linked"),
        doc_unresolved=docs.count("unresolved"),
        **_counts(plan),
    )


def apply_import(
    db: Session,
    project_id: uuid.UUID,
    text: str,
    name: str | None,
    mapping: dict[str, uuid.UUID | None],
) -> tuple[BusinessProcess, "ProcessImportResult"]:
    """Создаёт НОВЫЙ процесс из диаграммы; заменить содержимое существующего —
    replace_import. mapping — сопоставление целиком: алиаса нет или null — участник
    без объекта. Шаги встают на канал, только если он единственный подходящий;
    остальные — повисшими.
    """
    parsed = parse_sequence(text)
    plan = plan_import(db, project_id, parsed, mapping, _load_nodes(db, project_id))
    proc = BusinessProcess(
        id=uuid.uuid4(),
        name=(name or "").strip() or "Импортированный процесс",
        project_id=project_id,
    )
    db.add(proc)
    db.flush()
    return proc, _write(db, proc, plan)


PRE_REPLACE = "Перед заменой процесса «{name}» из диаграммы"


def replace_import(
    db: Session,
    project: Project,
    user: User,
    proc: BusinessProcess,
    text: str,
    name: str | None,
    mapping: dict[str, uuid.UUID | None],
) -> ProcessReplaceResult:
    """Заменить содержимое существующего процесса диаграммой: id, область и место в
    проекте остаются, участники, шаги и фрагменты пишутся заново (привязки шагов к
    схемам переживают замену через «%% archmap-doc», как в экспорте). Перед заменой
    сохраняется версия всего проекта: в ней остаётся прежний текст процесса (откат
    процессы не трогает, текст берут из версии и ввозят заново). Без коммита."""
    parsed = parse_sequence(text)
    version, created = versions.ensure_version(
        db, project, user, None, PRE_REPLACE.format(name=proc.name), kind="pre_replace"
    )
    # Шаги — первыми: они ссылаются на участников.
    proc.messages.clear()
    proc.fragments.clear()
    db.flush()
    proc.participants.clear()
    db.flush()
    if name and name.strip():
        proc.name = name.strip()
    plan = plan_import(db, project.id, parsed, mapping, _load_nodes(db, project.id))
    result = _write(db, proc, plan)
    db.flush()
    # Строки пишутся по внешнему ключу, мимо коллекций процесса: очищенные выше
    # коллекции в памяти пусты, и чтение в той же сессии (снимок версии) видело бы
    # процесс без шагов. Сброс заставит перечитать их из БД.
    db.expire(proc)
    return ProcessReplaceResult(
        **result.model_dump(),
        version_number=version.number if version is not None else None,
        version_created=created,
    )
