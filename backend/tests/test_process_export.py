"""Экспорт процесса в Mermaid (app/process_export.py, Ф2 архива).

Перенос фронтового toMermaid.test.ts вместе с самим конвертером (решение Р2):
кейсы те же, чтобы гарантия не ослабла при переезде. Паритет с фронтовой
реализацией снят построчно на 10 живых процессах ДО удаления фронтовой копии
(0 расхождений, полевой прогон Ф2).
"""

import uuid

from app.process_export import detail_to_mermaid
from app.schemas.process import (
    BranchOut,
    FragmentOut,
    MessageOut,
    ParticipantOut,
    ProcessDetail,
)


def _part(pid: str, name: str, order: int) -> ParticipantOut:
    return ParticipantOut(
        id=uuid.uuid5(uuid.NAMESPACE_DNS, pid), node_id=None, name=name, role=None,
        shape=None, is_external=None, status=None, order=order,
    )


def _msg(order: int, frm: str, to: str, kind: str, caption: str | None, **kw) -> MessageOut:
    return MessageOut(
        id=uuid.uuid4(), order=order, edge_id=None, leg="forward", kind=kind,
        caption=caption, technology=None,
        from_participant_id=uuid.uuid5(uuid.NAMESPACE_DNS, frm),
        to_participant_id=uuid.uuid5(uuid.NAMESPACE_DNS, to),
        valid=True, **kw,
    )


def _frag(from_order: int, to_order: int, **kw) -> FragmentOut:
    base = {"kind": "alt", "guard": None, "branches": []}
    base.update(kw)
    return FragmentOut(id=uuid.uuid4(), from_order=from_order, to_order=to_order, **base)


def _detail(parts, msgs, frags=()) -> ProcessDetail:
    return ProcessDetail(
        id=uuid.uuid4(), name="P", scope_node_id=None, scope_name=None,
        participants=list(parts), messages=list(msgs), fragments=list(frags),
    )


def test_участники_алиасы_Pn_в_порядке_order():
    out = detail_to_mermaid(_detail([_part("b", "Bob", 1), _part("a", "Alice", 0)], []))
    assert out == "\n".join(
        ["sequenceDiagram", "    participant P1 as Alice", "    participant P2 as Bob"]
    )


def test_стрелки_по_виду_сообщения():
    out = detail_to_mermaid(_detail(
        [_part("a", "A", 0), _part("b", "B", 1)],
        [
            _msg(0, "a", "b", "forward", "запрос"),
            _msg(1, "b", "a", "return", "ответ"),
            _msg(2, "a", "b", "async", "событие"),
            _msg(3, "a", "a", "self", "проверка"),
        ],
    ))
    assert "P1->>P2: запрос" in out
    assert "P2-->>P1: ответ" in out
    assert "P1-)P2: событие" in out
    assert "P1->>P1: проверка" in out


def test_привязка_к_схеме_едет_строкой_archmap_doc_перед_шагом():
    # Круговой прогон (Ф7 эпика процессов): в строку шага адрес не вписать — всё
    # после первого двоеточия mermaid читает как подпись (Д11).
    привязан = _msg(0, "a", "b", "forward", "создать заказ",
                    doc_id=uuid.uuid4(), doc_node_path="Ярмарка / Заказы",
                    doc_name="POST /orders")
    out = detail_to_mermaid(_detail(
        [_part("a", "A", 0), _part("b", "B", 1)],
        [привязан, _msg(1, "b", "a", "return", "ответ")],
    ))
    lines = [ln.strip() for ln in out.split("\n")]
    шаг = lines.index("P1->>P2: создать заказ")
    assert lines[шаг - 1] == "%% archmap-doc: Ярмарка / Заказы / POST /orders"
    assert sum(1 for ln in lines if ln.startswith("%% archmap-doc")) == 1


def test_пустая_реплика_плейсхолдер_тире():
    out = detail_to_mermaid(_detail(
        [_part("a", "A", 0), _part("b", "B", 1)], [_msg(0, "a", "b", "forward", None)],
    ))
    assert "P1->>P2: —" in out


def test_alt_с_веткой_else_оборачивает_и_закрывается_end():
    out = detail_to_mermaid(_detail(
        [_part("a", "A", 0), _part("b", "B", 1)],
        [_msg(0, "a", "b", "forward", "проверить"), _msg(1, "b", "a", "return", "отказ")],
        [_frag(0, 1, guard="успех", branches=[BranchOut(start_order=1, guard="иначе")])],
    ))
    assert out.split("\n")[3:] == [
        "    alt успех",
        "        P1->>P2: проверить",
        "    else иначе",
        "        P2-->>P1: отказ",
        "    end",
    ]


def test_несколько_веток_else_цепочкой():
    out = detail_to_mermaid(_detail(
        [_part("a", "A", 0), _part("b", "B", 1)],
        [
            _msg(0, "a", "b", "forward", "раз"),
            _msg(1, "a", "b", "forward", "два"),
            _msg(2, "a", "b", "forward", "три"),
        ],
        [_frag(0, 2, guard="х", branches=[
            BranchOut(start_order=1, guard="у"), BranchOut(start_order=2, guard=None),
        ])],
    ))
    lines = [ln.strip() for ln in out.split("\n")]
    assert lines.count("else у") == 1 and lines.count("else") == 1
    assert lines.index("else у") < lines.index("else")


def test_вложенные_фрагменты_внешний_раньше_внутренний_закрывается_раньше():
    out = detail_to_mermaid(_detail(
        [_part("a", "A", 0), _part("b", "B", 1)],
        [_msg(0, "a", "b", "forward", "раз"), _msg(1, "a", "b", "forward", "два")],
        [
            _frag(0, 1, kind="loop", guard="широкий"),
            _frag(0, 0, kind="opt", guard="узкий"),
        ],
    ))
    assert out.split("\n")[3:] == [
        "    loop широкий",
        "        opt узкий",
        "            P1->>P2: раз",
        "        end",
        "        P1->>P2: два",
        "    end",
    ]


def test_чистит_точку_с_запятой_и_переводы_строк():
    out = detail_to_mermaid(_detail(
        [_part("a", "A;B\nC", 0), _part("b", "B", 1)],
        [_msg(0, "a", "b", "forward", "раз;\nдва")],
    ))
    assert "participant P1 as A,B C" in out
    assert "P1->>P2: раз, два" in out
