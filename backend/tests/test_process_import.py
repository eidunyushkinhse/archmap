"""Разбор mermaid sequenceDiagram при импорте процесса.

Парсер намеренно не бросает ошибок: непонятая строка уходит в unsupported, а
разобранное остаётся — импорт «почти правильного» файла должен доводиться до
превью, а не падать на первой странной строке.
"""

from app.process_import import parse_sequence

ЭКСПОРТ = """sequenceDiagram
    participant P1 as Покупатель
    participant P2 as Сервис заказов
    P1->>P2: создать заказ
    P2-->>P1: номер заказа
"""


def test_участники_и_шаги_разбираются():
    out = parse_sequence(ЭКСПОРТ)

    assert [name for _, name in out.participants] == ["Покупатель", "Сервис заказов"]
    assert [(m.frm, m.to, m.leg, m.caption) for m in out.messages] == [
        ("P1", "P2", "forward", "создать заказ"),
        ("P2", "P1", "return", "номер заказа"),
    ]
    assert out.unsupported == []


def test_стрелки_читаются_от_длинной_к_короткой():
    # «-->>» не должна распасться по «->»: иначе ответ стал бы вызовом.
    out = parse_sequence("sequenceDiagram\n A-->>B: ответ\n A-)B: событие\n A->B: вызов\n")

    assert [m.leg for m in out.messages] == ["return", "forward", "forward"]


def test_участник_без_объявления_заводится_по_ходу():
    # mermaid это позволяет: participant можно не писать вовсе.
    out = parse_sequence("sequenceDiagram\n Клиент->>Биллинг: платёж\n")

    assert [name for _, name in out.participants] == ["Клиент", "Биллинг"]


def test_алиас_без_as_становится_и_именем():
    out = parse_sequence("sequenceDiagram\n participant Биллинг\n Биллинг->>Биллинг: проверка\n")

    assert out.participants == [("Биллинг", "Биллинг")]


def test_самосообщение_разбирается():
    out = parse_sequence("sequenceDiagram\n A->>A: валидация\n")

    m = out.messages[0]
    assert (m.frm, m.to) == ("A", "A")


def test_фрагмент_с_ветвями():
    out = parse_sequence(
        "sequenceDiagram\n"
        " A->>B: первое\n"
        " alt успех\n"
        "  A->>B: второе\n"
        " else отказ\n"
        "  A->>B: третье\n"
        " else таймаут\n"
        "  A->>B: четвёртое\n"
        " end\n"
    )

    assert len(out.fragments) == 1
    frag = out.fragments[0]
    assert (frag.kind, frag.guard) == ("alt", "успех")
    assert (frag.from_row, frag.to_row) == (1, 3)
    assert [(b.start_row, b.guard) for b in frag.branches] == [(2, "отказ"), (3, "таймаут")]


def test_вложенные_фрагменты():
    out = parse_sequence(
        "sequenceDiagram\n"
        " alt внешний\n"
        "  A->>B: раз\n"
        "  opt внутренний\n"
        "   A->>B: два\n"
        "  end\n"
        " end\n"
    )

    assert [(f.kind, f.from_row, f.to_row) for f in out.fragments] == [
        ("alt", 0, 1),
        ("opt", 1, 1),
    ]


def test_пустой_фрагмент_отбрасывается():
    # Диапазона позиций у него нет — держать нечего.
    out = parse_sequence("sequenceDiagram\n A->>B: раз\n alt пусто\n end\n")

    assert out.fragments == []


def test_незакрытый_фрагмент_закрывается_последним_шагом():
    # Терять блок хуже, чем додумать его конец: охват виден в превью.
    out = parse_sequence("sequenceDiagram\n alt без конца\n A->>B: раз\n A->>B: два\n")

    assert [(f.from_row, f.to_row) for f in out.fragments] == [(0, 1)]


def test_непонятые_строки_уходят_в_отчёт():
    # Молча выпасть они не могут: пользователь считал бы импорт полным.
    out = parse_sequence(
        "sequenceDiagram\n"
        " autonumber\n"
        " Note right of A: примечание\n"
        " A->>B: раз\n"
        " какая-то ерунда\n"
    )

    assert len(out.messages) == 1
    assert out.unsupported == ["autonumber", "Note right of A: примечание", "какая-то ерунда"]


def test_комментарии_и_пустые_строки_не_шумят():
    out = parse_sequence("sequenceDiagram\n\n %% это комментарий\n A->>B: раз\n")

    assert out.unsupported == []
    assert len(out.messages) == 1


def test_else_без_alt_не_роняет_разбор():
    out = parse_sequence("sequenceDiagram\n A->>B: раз\n else сирота\n")

    assert len(out.messages) == 1
    assert out.unsupported == ["else сирота"]


def test_шаг_без_подписи():
    out = parse_sequence("sequenceDiagram\n A->>B\n")

    assert out.messages[0].caption is None


# ── Превью и применение (нужна база) ──────────────────────────────────────────
import uuid  # noqa: E402

from conftest import ensure_architect, ensure_project  # noqa: E402

from app.models.edge import Edge  # noqa: E402
from app.models.node import Node  # noqa: E402
from app.models.process_fragment import ProcessFragment  # noqa: E402
from app.models.process_message import ProcessMessage  # noqa: E402
from app.models.process_participant import ProcessParticipant  # noqa: E402
from app.process_import import apply_import, build_preview  # noqa: E402
from app.routers.processes import get_process, import_process  # noqa: E402
from app.schemas.process_import import ProcessImportApply  # noqa: E402


def _узел(db, name, parent=None):
    node = Node(id=uuid.uuid4(), name=name, project_id=ensure_project(db).id,
                parent_id=parent.id if parent else None)
    db.add(node)
    db.flush()
    return node


def _связь(db, src, tgt, sync=True):
    edge = Edge(id=uuid.uuid4(), project_id=ensure_project(db).id,
                source_id=src.id, target_id=tgt.id, is_synchronous=sync)
    db.add(edge)
    db.flush()
    return edge


def test_превью_сопоставляет_имена_с_узлами(db):
    покупатель = _узел(db, "Покупатель")
    db.commit()

    out = build_preview(db, ensure_project(db).id, ЭКСПОРТ, None)

    по_имени = {p.name: p for p in out.participants}
    assert по_имени["Покупатель"].node_id == покупатель.id
    assert по_имени["Сервис заказов"].node_id is None  # такого узла в схеме нет
    assert (out.message_count, out.fragment_count) == (2, 0)


def test_превью_не_выбирает_из_тёзок(db):
    # Имена узлов не уникальны — выбирать за пользователя нельзя.
    а = _узел(db, "Общий")
    _узел(db, "Общий", parent=а)
    db.commit()

    out = build_preview(db, ensure_project(db).id, "sequenceDiagram\n Общий->>X: раз\n", None)

    p = next(p for p in out.participants if p.name == "Общий")
    assert p.node_id is None
    assert len(p.candidates) == 2
    assert {c.parent_name for c in p.candidates} == {None, "Общий"}  # чем различать


def test_превью_ничего_не_пишет(db):
    _узел(db, "Покупатель")
    db.commit()

    build_preview(db, ensure_project(db).id, ЭКСПОРТ, None)

    assert db.query(ProcessMessage).count() == 0
    assert db.query(ProcessParticipant).count() == 0


def test_импорт_ставит_шаги_на_каналы_схемы(db):
    # Главный сценарий: возврат своего экспорта. Каналы есть — стрелки не должны
    # оказаться сломанными.
    покупатель = _узел(db, "Покупатель")
    заказы = _узел(db, "Сервис заказов")
    связь = _связь(db, покупатель, заказы, sync=True)
    db.commit()
    preview = build_preview(db, ensure_project(db).id, ЭКСПОРТ, None)
    mapping = {p.alias: p.node_id for p in preview.participants}

    _, res = apply_import(db, ensure_project(db).id, ЭКСПОРТ, "Оплата", mapping)
    db.commit()

    assert (res.attached, res.dangling, res.unbound) == (2, 0, 0)
    assert {m.edge_id for m in db.query(ProcessMessage).all()} == {связь.id}


def test_импорт_оставляет_несопоставленного_непривязанным(db):
    """Решение пользователя: шаг сценария не должен пропадать из-за того, что имя не
    нашлось в схеме. Участник заводится непривязанным, шаги — повисшими."""
    _узел(db, "Покупатель")
    db.commit()
    preview = build_preview(db, ensure_project(db).id, ЭКСПОРТ, None)
    mapping = {p.alias: p.node_id for p in preview.participants}

    proc, res = apply_import(db, ensure_project(db).id, ЭКСПОРТ, None, mapping)
    db.commit()

    assert (res.participants, res.unbound) == (2, 1)
    assert (res.messages, res.attached, res.dangling) == (2, 0, 2)
    сирота = db.query(ProcessParticipant).filter(ProcessParticipant.node_id.is_(None)).one()
    assert сирота.name == "Сервис заказов"  # имя из диаграммы сохранено


def test_импорт_переносит_фрагменты_с_ветвями(db):
    текст = (
        "sequenceDiagram\n"
        " A->>B: раз\n"
        " alt успех\n"
        "  A->>B: два\n"
        " else отказ\n"
        "  A->>B: три\n"
        " end\n"
    )

    _, res = apply_import(db, ensure_project(db).id, текст, None, {})
    db.commit()

    assert res.fragments == 1
    frag = db.query(ProcessFragment).one()
    assert (frag.from_order, frag.to_order, frag.guard) == (1, 2, "успех")
    assert [(b.start_order, b.guard) for b in frag.branches] == [(2, "отказ")]


def test_импорт_не_привязывает_двух_участников_к_одному_узлу(db):
    # uq_participant_node этого не допустит — но роняться импорт не должен:
    # второй остаётся непривязанным.
    узел = _узел(db, "Общий")
    db.commit()
    текст = "sequenceDiagram\n participant P1 as Общий\n participant P2 as Общий\n P1->>P2: раз\n"

    _, res = apply_import(
        db, ensure_project(db).id, текст, None, {"P1": узел.id, "P2": узел.id}
    )
    db.commit()

    assert res.unbound == 1
    assert db.query(ProcessParticipant).filter(ProcessParticipant.node_id == узел.id).count() == 1


def test_импорт_создаёт_читаемый_процесс(db):
    # Сквозная проверка: импортированный процесс отдаётся штатным эндпоинтом.
    _узел(db, "Покупатель")
    db.commit()

    res = import_process(
        ProcessImportApply(text=ЭКСПОРТ, name="Оплата", mapping={}),
        db=db, project=ensure_project(db), user=ensure_architect(db),
    )

    detail = get_process(res.process_id, db=db, project=ensure_project(db), _=ensure_architect(db))
    assert detail.name == "Оплата"
    assert [p.name for p in detail.participants] == ["Покупатель", "Сервис заказов"]
    assert all(p.node_id is None for p in detail.participants)  # mapping пуст
    assert [m.caption for m in detail.messages] == ["создать заказ", "номер заказа"]


def test_импорт_отчитывается_о_непонятых_строках(db):
    res = import_process(
        ProcessImportApply(text="sequenceDiagram\n autonumber\n A->>B: раз\n", mapping={}),
        db=db, project=ensure_project(db), user=ensure_architect(db),
    )

    assert res.unsupported == ["autonumber"]


def test_импорт_отбрасывает_ветвь_на_первой_строке_охвата(db):
    """`else` сразу за `alt`: первой ветви не досталось бы ни одного шага. То же
    правило держит API (from_order < start_order ≤ to_order) — импорт не имеет права
    класть в базу то, что этот же бэк потом отвергнет при правке."""
    текст = (
        "sequenceDiagram\n"
        " alt успех\n"
        " else отказ\n"
        "  A->>B: раз\n"
        " end\n"
    )

    _, res = apply_import(db, ensure_project(db).id, текст, None, {})
    db.commit()

    assert res.fragments == 1
    frag = db.query(ProcessFragment).one()
    assert (frag.from_order, frag.to_order) == (0, 0)
    assert frag.branches == []  # ветвь была бы пустой — не заводим


# ── Подписи: своя или выводимая из канала ─────────────────────────────────────
# API отдаёт наружу УЖЕ ВЫЧИСЛЕННУЮ подпись и не сообщает, своя она или выведенная.
# Экспорт пишет её как есть — и импорт, приняв за свою, замораживал бы копию: шаг
# переставал следовать за каналом.
def test_подпись_равная_метке_канала_не_замораживается(db):
    покупатель = _узел(db, "Покупатель")
    заказы = _узел(db, "Сервис заказов")
    _связь(db, покупатель, заказы, sync=True)
    db.commit()
    # Экспорт вызова без своей подписи пишет метку канала.
    текст = ("sequenceDiagram\n participant P1 as Покупатель\n"
             " participant P2 as Сервис заказов\n P1->>P2: связь\n")
    db.query(Edge).one().label = "связь"
    db.commit()
    preview = build_preview(db, ensure_project(db).id, текст, None)
    mapping = {p.alias: p.node_id for p in preview.participants}

    apply_import(db, ensure_project(db).id, текст, None, mapping)
    db.commit()

    assert db.query(ProcessMessage).one().caption is None  # снова следует за каналом


def test_ответ_со_словом_ответ_не_замораживается(db):
    # «ответ» — дефолт плеча ответа, а не текст пользователя.
    покупатель = _узел(db, "Покупатель")
    заказы = _узел(db, "Сервис заказов")
    _связь(db, покупатель, заказы, sync=True)
    db.commit()
    текст = ("sequenceDiagram\n participant P1 as Покупатель\n"
             " participant P2 as Сервис заказов\n P2-->>P1: ответ\n")
    preview = build_preview(db, ensure_project(db).id, текст, None)

    apply_import(db, ensure_project(db).id, текст, None,
                 {p.alias: p.node_id for p in preview.participants})
    db.commit()

    assert db.query(ProcessMessage).one().caption is None


def test_своя_подпись_сохраняется(db):
    покупатель = _узел(db, "Покупатель")
    заказы = _узел(db, "Сервис заказов")
    _связь(db, покупатель, заказы, sync=True)
    db.query(Edge).one().label = "REST"
    db.commit()
    текст = ("sequenceDiagram\n participant P1 as Покупатель\n"
             " participant P2 as Сервис заказов\n P1->>P2: создать заказ\n")
    preview = build_preview(db, ensure_project(db).id, текст, None)

    apply_import(db, ensure_project(db).id, текст, None,
                 {p.alias: p.node_id for p in preview.participants})
    db.commit()

    assert db.query(ProcessMessage).one().caption == "создать заказ"


def test_прочерк_читается_как_отсутствие_подписи(db):
    # Экспорт ставит «—» вместо пустой подписи; это заглушка, а не текст из тире.
    текст = "sequenceDiagram\n A->>B: —\n"

    apply_import(db, ensure_project(db).id, текст, None, {})
    db.commit()

    assert db.query(ProcessMessage).one().caption is None


def test_сравнение_идёт_по_очищенному_тексту(db):
    # Экспорт схлопывает пробелы и меняет «;» на «,» — сверять надо по той же норме,
    # иначе подпись «замёрзнет» из-за форматирования метки.
    покупатель = _узел(db, "Покупатель")
    заказы = _узел(db, "Сервис заказов")
    _связь(db, покупатель, заказы, sync=True)
    db.query(Edge).one().label = "чтение;  запись"
    db.commit()
    текст = ("sequenceDiagram\n participant P1 as Покупатель\n"
             " participant P2 as Сервис заказов\n P1->>P2: чтение, запись\n")
    preview = build_preview(db, ensure_project(db).id, текст, None)

    apply_import(db, ensure_project(db).id, текст, None,
                 {p.alias: p.node_id for p in preview.participants})
    db.commit()

    assert db.query(ProcessMessage).one().caption is None
