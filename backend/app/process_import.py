"""Импорт бизнес-процесса из текста mermaid sequenceDiagram.

Разбор живёт на бэке (как и импорт YAML): сопоставление имён с узлами и подбор
каналов всё равно требуют базы, а вторая реализация на клиенте неизбежно разошлась
бы с этой. Заодно импорт достаётся API и MCP-агенту.

ПОДДЕРЖИВАЕМОЕ ПОДМНОЖЕСТВО: participant/actor (с алиасом и без), стрелки
->> / -->> / -) / -> / --> / --), самосообщения, alt/opt/loop/par + else + end.
Не поддерживаем: autonumber, activate/deactivate, note, box, ссылки. Непонятые
строки НЕ выпадают молча — они уходят в отчёт (unsupported), иначе пользователь
считал бы импорт полным.
"""

import re
import uuid
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from app.models.business_process import BusinessProcess
from app.models.edge import Edge
from app.models.node import Node
from app.models.process_fragment import ProcessFragment, ProcessFragmentBranch
from app.models.process_message import ProcessMessage
from app.models.process_participant import ProcessParticipant
from app.processes import legs_for_edge, resolve_to_participant
from app.schemas.process_import import (
    ImportNodeCandidate,
    ImportParticipantPreview,
    ProcessImportPreview,
    ProcessImportResult,
)

# Стрелка → плечо канала. Вид (синхронный/событие) определяет сам канал в схеме,
# поэтому здесь важно только направление: forward или return.
_ARROWS: list[tuple[str, str]] = [
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


@dataclass
class ParsedMessage:
    frm: str  # алиас участника
    to: str
    leg: str  # forward | return
    caption: str | None


@dataclass
class ParsedBranch:
    start_row: int
    guard: str | None


@dataclass
class ParsedFragment:
    kind: str
    from_row: int
    to_row: int
    guard: str | None
    branches: list[ParsedBranch] = field(default_factory=list)


@dataclass
class ParsedDiagram:
    # Порядок объявления участников = порядок колонок. Алиас → отображаемое имя.
    participants: list[tuple[str, str]] = field(default_factory=list)
    messages: list[ParsedMessage] = field(default_factory=list)
    fragments: list[ParsedFragment] = field(default_factory=list)
    unsupported: list[str] = field(default_factory=list)


def _split_arrow(body: str) -> tuple[str, str, str] | None:
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

    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("%%"):
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
            continue

        m = _FRAGMENT_RE.match(line)
        if m:
            guard = m.group(2).strip() or None
            frag = ParsedFragment(
                kind=m.group(1).lower(), from_row=len(out.messages), to_row=len(out.messages),
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
        out.messages.append(ParsedMessage(frm=frm, to=to, leg=leg, caption=text_caption))

    # Незакрытые фрагменты: закрываем последним сообщением — терять блок хуже, чем
    # додумать его конец (пользователь увидит охват в превью).
    while stack:
        frag = stack.pop()
        if out.messages and len(out.messages) > frag.from_row:
            frag.to_row = len(out.messages) - 1
            out.fragments.append(frag)
    out.fragments.sort(key=lambda f: (f.from_row, -f.to_row))
    return out


def find_channel(
    edges: list[Edge],
    all_nodes: dict[uuid.UUID, Node],
    participant_ids: set[uuid.UUID],
    from_node: uuid.UUID,
    to_node: uuid.UUID,
    leg: str,
) -> Edge | None:
    """Единственный канал, чьё плечо `leg` проецируется ровно на эту пару узлов.

    Несколько кандидатов (между парой бывает и REST, и Kafka) — возвращаем None:
    выбирать за пользователя нельзя, шаг останется повисшим и попадёт в отчёт.
    """
    found = [
        edge
        for edge in edges
        for lg in legs_for_edge(edge)
        if lg.leg == leg
        and resolve_to_participant(lg.from_id, participant_ids, all_nodes) == from_node
        and resolve_to_participant(lg.to_id, participant_ids, all_nodes) == to_node
    ]
    return found[0] if len(found) == 1 else None


def match_nodes_by_name(db: Session, project_id: uuid.UUID, names: list[str]) -> dict[str, list[Node]]:
    """Кандидаты-узлы для каждого имени из диаграммы. Сравнение регистронезависимое и
    без краевых пробелов; имена узлов НЕ уникальны (ограничения в БД нет), поэтому
    список — норма, а не исключение."""
    nodes = db.query(Node).filter(Node.project_id == project_id).all()
    by_key: dict[str, list[Node]] = {}
    for node in nodes:
        by_key.setdefault(node.name.strip().casefold(), []).append(node)
    return {name: by_key.get(name.strip().casefold(), []) for name in names}


def build_preview(
    db: Session, project_id: uuid.UUID, text: str, name: str | None
) -> "ProcessImportPreview":
    """Что получится из текста и с чем сопоставились имена. Ничего не пишет."""
    parsed = parse_sequence(text)
    names = [n for _, n in parsed.participants]
    matches = match_nodes_by_name(db, project_id, names)
    all_nodes = {n.id: n for n in db.query(Node).filter(Node.project_id == project_id).all()}
    participants = []
    for alias, disp in parsed.participants:
        cands = matches.get(disp, [])
        participants.append(
            ImportParticipantPreview(
                alias=alias,
                name=disp,
                # Авто-сопоставление ТОЛЬКО при единственном кандидате: имена узлов не
                # уникальны, и выбирать за пользователя из тёзок нельзя.
                node_id=cands[0].id if len(cands) == 1 else None,
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
    return ProcessImportPreview(
        name=(name or "").strip() or "Импортированный процесс",
        participants=participants,
        message_count=len(parsed.messages),
        fragment_count=len(parsed.fragments),
        unsupported=parsed.unsupported,
    )


def apply_import(
    db: Session,
    project_id: uuid.UUID,
    text: str,
    name: str | None,
    mapping: dict[str, uuid.UUID | None],
) -> tuple[BusinessProcess, "ProcessImportResult"]:
    """Создаёт НОВЫЙ процесс из диаграммы. Слияние с существующим — отдельная задача.

    Несопоставленные участники заводятся непривязанными (решение пользователя): шаг
    сценария не должен пропадать из-за того, что имя не нашлось в схеме. Шаги встают
    на канал, только если он единственный подходящий; остальные — повисшими.
    """
    parsed = parse_sequence(text)
    all_nodes = {n.id: n for n in db.query(Node).filter(Node.project_id == project_id).all()}
    proc = BusinessProcess(
        id=uuid.uuid4(),
        name=(name or "").strip() or "Импортированный процесс",
        project_id=project_id,
    )
    db.add(proc)
    db.flush()

    used: set[uuid.UUID] = set()
    part_by_alias: dict[str, ProcessParticipant] = {}
    for order, (alias, disp) in enumerate(parsed.participants):
        node_id = mapping.get(alias)
        node = all_nodes.get(node_id) if node_id else None
        # Узел, уже занятый другим участником, привязать нельзя (uq_participant_node):
        # такой участник остаётся непривязанным, а не роняет весь импорт.
        if node is not None and node.id in used:
            node = None
        if node is not None:
            used.add(node.id)
        part = ProcessParticipant(
            id=uuid.uuid4(),
            process_id=proc.id,
            node_id=node.id if node else None,
            name=node.name if node else disp,
            order=order,
        )
        db.add(part)
        part_by_alias[alias] = part
    db.flush()

    edges = db.query(Edge).filter(Edge.project_id == project_id).all()
    participant_ids = {p.node_id for p in part_by_alias.values() if p.node_id is not None}
    attached = 0
    for order, msg in enumerate(parsed.messages):
        frm = part_by_alias[msg.frm]
        to = part_by_alias[msg.to]
        edge: Edge | None = None
        if frm.id != to.id and frm.node_id is not None and to.node_id is not None:
            edge = find_channel(
                edges, all_nodes, participant_ids, frm.node_id, to.node_id, msg.leg
            )
        if edge is not None:
            attached += 1
        db.add(
            ProcessMessage(
                id=uuid.uuid4(),
                process_id=proc.id,
                order=order,
                edge_id=edge.id if edge else None,
                leg=msg.leg,
                from_participant_id=frm.id,
                to_participant_id=to.id,
                caption=msg.caption,
            )
        )

    for frag in parsed.fragments:
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

    unbound = sum(1 for p in part_by_alias.values() if p.node_id is None)
    result = ProcessImportResult(
        process_id=proc.id,
        participants=len(part_by_alias),
        unbound=unbound,
        messages=len(parsed.messages),
        attached=attached,
        dangling=len(parsed.messages) - attached,
        fragments=len(parsed.fragments),
        unsupported=parsed.unsupported,
    )
    return proc, result
