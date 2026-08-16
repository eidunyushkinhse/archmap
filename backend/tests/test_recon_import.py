"""Приём перечня разведки (Ф1 docs/plan-recon.md): разбор файла и строки → заглушки.

Проверяется то, чем этот путь отличается от прочих приёмников: перечень приезжает
через пользователя (ограждения, битый YAML), опознаётся по разделам, а его строки
становятся ЗАГЛУШКАМИ — схемами с пустым телом.

Главный сторож — test_образец_промпта_разбирается: формат диктует промпт (Ф0), под
него подстраивается приёмник, и расхождение обязано валить тест, а не всплывать в
поле.
"""

import uuid

from conftest import ensure_architect, ensure_project

from app.alerts import compute_alerts
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.project import Project
from app.projects import copy_project_schema
from app.recon_import import (
    MAX_ENTRY_LEN,
    MAX_RECON_LINES,
    ParsedRecon,
    apply_recon_plan,
    build_recon_plan,
    looks_like_spec,
    parse_recon_file,
    recon_stubs,
)
from app.recon_prompt import RECON_FILE, build_recon_prompt
from app.restore import build_deletion_snapshot, restore_from_snapshot
from app.routers.nodes import delete_node
from app.routers.recon import recon_import_apply, recon_import_preview
from app.schemas.recon import ReconImportIn

ПЕРЕЧЕНЬ = """# archmap-recon
node: Zulip / backend
operations:
  - GET /messages
  - POST /messages
workers:
  - email_senders
sources:
  - "операции: zerver/lib/rest.py (187 вхождений rest_path)"
doubts:
  - "GET /internal/metrics — похоже на служебный, не уверен"
"""

СПЕКА = """openapi: 3.0.0
info:
  title: API
paths:
  /messages:
    get:
      summary: список
"""


def _разбор(текст: str) -> ParsedRecon:
    parsed = parse_recon_file(текст)
    assert parsed is not None
    return parsed


# ── Опознание файла (Р8) ──────────────────────────────────────────────────────
def test_перечень_разбирается():
    p = _разбор(ПЕРЕЧЕНЬ)
    assert p.node_ref == "Zulip / backend"
    assert p.operations == ["GET /messages", "POST /messages"]
    assert p.workers == ["email_senders"]
    assert p.doubts == ["GET /internal/metrics — похоже на служебный, не уверен"]
    assert p.salvaged is False


def test_образец_промпта_разбирается():
    """Образец из промпта разведки обязан пройти приёмник как есть.

    Промпт — замеренный артефакт, и подстраивается под него приёмник, а не наоборот
    (санкция ТЗ Ф1). Заодно проверяется снос ограждения: пример в промпте обёрнут в
    ```yaml, и вырезать его умеет тот же механизм, что принимает ответ агента.
    """
    p = _разбор(build_recon_prompt("Zulip / backend"))
    assert p.node_ref == "Zulip / backend"
    assert p.operations == ["GET /messages", "POST /messages", "PATCH /messages/{message_id}"]
    assert p.workers == ["email_senders", "missedmessage_emails"]
    assert p.doubts and p.salvaged is False


def test_корневой_комментарий_необязателен():
    """«# archmap-recon» — комментарий, и агент его потеряет; перечнем файл остаётся."""
    p = _разбор("operations:\n  - GET /health\n")
    assert p.operations == ["GET /health"]
    # И наоборот: одних воркеров тоже достаточно (сервис без HTTP — законный случай).
    assert _разбор("workers:\n  - digest_emails\n").workers == ["digest_emails"]


def test_спека_перечнем_не_считается():
    assert parse_recon_file(СПЕКА) is None
    assert looks_like_spec(СПЕКА) is True


def test_чужие_файлы_пакета_пропускаются():
    """Рядом в папке лежат схемы логики и структура данных — их смотрит другой
    разборщик, и перечнем они не притворяются."""
    assert parse_recon_file("flowchart TD\n  A --> B\n") is None
    assert parse_recon_file("# archmap-node: Хранилище\ntables:\n  - name: orders\n") is None
    assert looks_like_spec("flowchart TD\n  A --> B\n") is False


# ── Толерантность разбора (Р7) ────────────────────────────────────────────────
def test_ограждение_снимается():
    p = _разбор("Вот перечень:\n\n```yaml\n" + ПЕРЕЧЕНЬ + "```\n")
    assert p.operations == ["GET /messages", "POST /messages"]
    assert p.node_ref == "Zulip / backend"


def test_битый_yaml_разбирается_построчно():
    """Двоеточие в имени объекта роняет разбор ВСЕГО документа — остальные строки целы,
    и терять их нельзя."""
    p = _разбор(
        "# archmap-recon\n"
        "node: Zulip: сервер / backend\n"
        "operations:\n"
        "  - GET /messages\n"
        "  - POST /messages\n"
        "workers:\n"
        "  - email_senders\n"
        "sources:\n"
        "  - операции: rest.py (187 вхождений)\n"
    )
    assert p.salvaged is True
    assert p.node_ref == "Zulip: сервер / backend"
    assert p.operations == ["GET /messages", "POST /messages"]
    # Раздел sources закрывает предыдущий: его строки в перечень не уезжают.
    assert p.workers == ["email_senders"]


def test_построчный_разбор_снимает_кавычки_и_комментарии():
    p = _разбор(
        "node: A: B\n"
        "operations:\n"
        '  - "GET /messages"  # служебный\n'
        "  -\n"
    )
    assert p.salvaged is True
    assert p.operations == ["GET /messages"]


def test_съеденное_двоеточие_не_теряет_строку():
    """«- GET /x: latest» YAML читает словарём — строку собираем обратно, а не выносим."""
    p = _разбор("operations:\n  - GET /messages: latest\n")
    assert p.operations == ["GET /messages: latest"]


def test_строка_операции_не_обязана_быть_http():
    """gRPC и GraphQL дают другие формы — отбраковка по шаблону «МЕТОД /путь» потеряла
    бы реальные точки входа молча."""
    p = _разбор(
        "operations:\n"
        "  - zulip.Messages/Send\n"
        "  - mutation createMessage\n"
        "  - POST /v1/files:upload\n"
    )
    assert p.operations == [
        "zulip.Messages/Send",
        "mutation createMessage",
        "POST /v1/files:upload",
    ]


# ── Строки → заглушки (Р11) ───────────────────────────────────────────────────
def test_заглушки_из_строк():
    stubs, warnings, errors = recon_stubs(_разбор(ПЕРЕЧЕНЬ))
    assert not errors
    assert [(s.name, s.kind, s.operation) for s in stubs] == [
        ("GET /messages", "operation", "GET /messages"),
        ("POST /messages", "operation", "POST /messages"),
        # Воркеру operation не положен: поле означает операцию спеки, а адрес воркера
        # — имя очереди.
        ("email_senders", "worker", None),
    ]
    assert any("сомнение разведчика" in w for w in warnings)


def test_пустые_и_дубли_схлопываются():
    stubs, warnings, _ = recon_stubs(
        ParsedRecon(
            operations=["GET /a", "GET /a", "  ", "GET /b"],
            # Строка и в операциях, и в воркерах — имя схемы уникально в пределах узла,
            # запись обеими уронила бы применение.
            workers=["GET /b", "digest"],
        )
    )
    assert [s.name for s in stubs] == ["GET /a", "GET /b", "digest"]
    assert any("пустых строк перечня пропущено: 1" in w for w in warnings)
    assert any("повторов строк перечня схлопнуто: 2" in w for w in warnings)


def test_длинная_строка_не_создаётся():
    """Молча обрезать нельзя: обрезанный адрес не сойдётся с операцией никогда."""
    длинная = "GET /" + "x" * MAX_ENTRY_LEN
    stubs, warnings, errors = recon_stubs(ParsedRecon(operations=[длинная, "GET /ok"]))
    assert [s.name for s in stubs] == ["GET /ok"]
    assert not errors
    assert any("заглушка не создана" in w for w in warnings)


def test_потолок_строк_блокирует_перечень():
    parsed = ParsedRecon(operations=[f"GET /op{i}" for i in range(MAX_RECON_LINES + 1)])
    stubs, _, errors = recon_stubs(parsed)
    assert stubs == []
    assert errors and str(MAX_RECON_LINES) in errors[0]
    # Ровно потолок — ещё перечень (Zulip с его 212 строками должен проходить с запасом).
    stubs, _, errors = recon_stubs(
        ParsedRecon(operations=[f"GET /op{i}" for i in range(MAX_RECON_LINES)])
    )
    assert len(stubs) == MAX_RECON_LINES and not errors


def test_спасённый_файл_помечен_замечанием():
    _, warnings, _ = recon_stubs(ParsedRecon(operations=["GET /a"], salvaged=True))
    assert any("разобран построчно" in w for w in warnings)


# ── План и применение ─────────────────────────────────────────────────────────
def _node(db, name, parent=None, shape="service"):
    n = Node(
        id=uuid.uuid4(),
        name=name,
        shape=shape,
        parent_id=parent.id if parent else None,
        project_id=ensure_project(db).id,
    )
    db.add(n)
    db.flush()
    return n


def _doc(db, node, name, kind="operation", operation=None, content=""):
    d = NodeDoc(
        id=uuid.uuid4(),
        node_id=node.id,
        name=name,
        kind=kind,
        operation=operation,
        content=content,
    )
    db.add(d)
    db.flush()
    return d


def _план(db, текст=ПЕРЕЧЕНЬ, window=None, имя="archmap-recon.yaml"):
    nodes = db.query(Node).filter(Node.project_id == ensure_project(db).id).all()
    return build_recon_plan(db, nodes, [(имя, текст)], window)


def _применить(db, текст=ПЕРЕЧЕНЬ, window=None):
    plan = _план(db, текст, window)
    if not plan.report.errors:
        apply_recon_plan(db, plan)
        db.flush()
    return plan.report


def _действия(report) -> dict[str, str]:
    return {i.name: i.action for i in report.items}


ПЕРЕЧЕНЬ_BACKEND = """# archmap-recon
node: backend
operations:
  - GET /messages
  - POST /messages
workers:
  - email_senders
"""


def test_четыре_действия_превью(db):
    """Ключ сопоставления: операция описана по ИМЕНИ ИЛИ по operation, воркер — по имени."""
    backend = _node(db, "backend")
    # Схема, написанная ДО разведки: называется по-человечески, операция — в поле.
    _doc(db, backend, "Отправка сообщения", operation="POST /messages", content="flowchart TD\n A")
    # Заглушка прошлого захода разведки: имя совпадает со строкой, тело пустое.
    _doc(db, backend, "GET /messages", operation="GET /messages")
    # Схема, которой в перечне больше нет.
    _doc(db, backend, "GET /old", operation="GET /old")
    # Обзор в перечень не входит по природе — исчезнувшим его объявлять нельзя.
    _doc(db, backend, "Обзор", kind="overview", content="flowchart TD\n B")

    report = _план(db, ПЕРЕЧЕНЬ_BACKEND).report
    assert not report.errors
    assert report.node_path == "backend"
    assert _действия(report) == {
        "GET /messages": "unchanged",
        "POST /messages": "described",
        "email_senders": "create",
        "GET /old": "vanished",
    }
    # Человек должен видеть, ЧТО закрыло операцию, если имена разошлись.
    описана = next(i for i in report.items if i.action == "described")
    assert описана.doc_name == "Отправка сообщения"


def test_применение_создаёт_заглушки(db):
    backend = _node(db, "backend")
    report = _применить(db, ПЕРЕЧЕНЬ_BACKEND)

    assert (report.applied, report.created) == (True, 3)
    docs = {d.name: d for d in db.query(NodeDoc).filter(NodeDoc.node_id == backend.id).all()}
    assert set(docs) == {"GET /messages", "POST /messages", "email_senders"}
    assert docs["POST /messages"].kind == "operation"
    assert docs["POST /messages"].operation == "POST /messages"
    # Тело пустое — это и есть заглушка; воркеру адрес операции не положен.
    assert docs["POST /messages"].content == ""
    assert (docs["email_senders"].kind, docs["email_senders"].operation) == ("worker", None)


def test_повторный_прогон_идемпотентен(db):
    """Критерий приёмки 2 эпика: второй заход — ноль созданий, ноль дублей, описанное цело."""
    backend = _node(db, "backend")
    _doc(db, backend, "Отправка сообщения", operation="POST /messages", content="flowchart TD\n A")
    _применить(db, ПЕРЕЧЕНЬ_BACKEND)
    db.flush()

    второй = _применить(db, ПЕРЕЧЕНЬ_BACKEND)

    assert второй.created == 0
    assert set(_действия(второй).values()) == {"unchanged", "described"}
    docs = db.query(NodeDoc).filter(NodeDoc.node_id == backend.id).all()
    # Дубля поверх описанной операции нет: схема «POST /messages» так и не создана.
    assert {d.name for d in docs} == {"GET /messages", "email_senders", "Отправка сообщения"}
    описана = next(d for d in docs if d.name == "Отправка сообщения")
    assert описана.content == "flowchart TD\n A" and описана.version == 1


def test_исчезнувшее_не_удаляется(db):
    """Расхождение показываем, а сносят его руками (Р13)."""
    backend = _node(db, "backend")
    _doc(db, backend, "GET /old", operation="GET /old", content="flowchart TD\n A")
    report = _применить(db, ПЕРЕЧЕНЬ_BACKEND)

    assert _действия(report)["GET /old"] == "vanished"
    старая = db.query(NodeDoc).filter(NodeDoc.name == "GET /old").one()
    assert старая.content == "flowchart TD\n A"


def test_воркер_сопоставляется_только_по_имени(db):
    """Поле operation воркерам не положено — не угадываем, показываем создание."""
    backend = _node(db, "backend")
    _doc(db, backend, "Рассылка писем", operation="email_senders", content="flowchart TD\n A")
    report = _план(db, "node: backend\nworkers:\n  - email_senders\n").report
    assert _действия(report) == {"email_senders": "create", "Рассылка писем": "vanished"}


def test_пустой_перечень_объясняется(db):
    """Пустое превью без слов — тупик; и человек должен сразу знать, что схемы,
    ушедшие в «исчезли из кода», никто не тронул."""
    backend = _node(db, "backend")
    _doc(db, backend, "GET /old", operation="GET /old", content="flowchart TD\n A")
    report = _план(db, "node: backend\noperations: []\nworkers: []\n").report

    assert not report.errors
    assert any("перечень пуст" in w for w in report.warnings)
    assert _действия(report) == {"GET /old": "vanished"}


# ── Адресация (Р9, Р10) ───────────────────────────────────────────────────────
def test_адрес_частичным_путём(db):
    корень = _node(db, "Zulip")
    _node(db, "backend", корень)
    report = _план(db, "node: Zulip / backend\noperations:\n  - GET /a\n").report
    assert (report.node_path, report.errors) == ("Zulip / backend", [])


def test_адрес_не_найден_подсказывает(db):
    корень = _node(db, "Zulip")
    _node(db, "backend", корень)
    report = _план(db, "node: Zulip / bakend\noperations:\n  - GET /a\n").report
    assert report.errors and "не найден" in report.errors[0]
    # did-you-mean и перечень объектов проекта: без них слабая модель гадает вслепую.
    assert "похоже на «Zulip / backend»" in report.errors[0]
    assert "Zulip / backend" in report.errors[0]
    assert report.items == []


def test_без_адреса_берётся_объект_окна(db):
    backend = _node(db, "backend")
    report = _применить(db, "operations:\n  - GET /a\n", window=backend.id)
    assert report.node_path == "backend" and report.created == 1
    # Без адреса И без окна применять некуда — это ошибка, а не тихий пропуск.
    пустой = _план(db, "operations:\n  - GET /b\n").report
    assert пустой.errors and "не сказало" in пустой.errors[0]


def test_оркестраторный_прогон_берёт_объединённый_файл(db):
    """ОСНОВНОЙ путь: оркестраторная кнопка (дефолт) оставляет в репозитории три похожих
    файла — объединённый перечень в корне и два служебных прогона разведчиков. Папку
    тащат целиком, и отказ там, где машина знает ответ, — лишняя ручная работа."""
    backend = _node(db, "backend")
    nodes = db.query(Node).all()
    plan = build_recon_plan(
        db,
        nodes,
        [
            ("archmap-orch/recon-1.yaml", ПЕРЕЧЕНЬ_BACKEND),
            (f"zulip/{RECON_FILE}", ПЕРЕЧЕНЬ_BACKEND),  # базовое имя, а не полный путь
            ("archmap-orch/recon-2.yaml", ПЕРЕЧЕНЬ_BACKEND),
        ],
        None,
    )
    assert not plan.report.errors
    assert plan.node is not None and plan.node.id == backend.id
    # Пропуск громкий: отбрасывать принесённые файлы молча нельзя.
    взято = next(w for w in plan.report.warnings if "взят объединённый" in w)
    assert f"«zulip/{RECON_FILE}»" in взято
    assert "archmap-orch/recon-1.yaml" in взято and "archmap-orch/recon-2.yaml" in взято


def test_несколько_перечней_без_канонического_вопрос(db):
    """Прогоны разведчиков без объединённого файла — выбирать не из чего, это вопрос."""
    _node(db, "backend")
    nodes = db.query(Node).all()
    plan = build_recon_plan(
        db,
        nodes,
        [
            ("archmap-orch/recon-1.yaml", ПЕРЕЧЕНЬ_BACKEND),
            ("archmap-orch/recon-2.yaml", ПЕРЕЧЕНЬ_BACKEND),
        ],
        None,
    )
    assert plan.report.errors and "несколько перечней" in plan.report.errors[0]
    assert "archmap-orch/recon-1.yaml" in plan.report.errors[0]
    assert f"«{RECON_FILE}»" in plan.report.errors[0]
    assert plan.node is None


def test_два_канонических_имени_вопрос(db):
    """Один и тот же файл из разных папок — разные объекты; молчаливый выбор первого
    увёл бы перечень не туда."""
    _node(db, "backend")
    nodes = db.query(Node).all()
    plan = build_recon_plan(
        db,
        nodes,
        [
            (f"zulip/{RECON_FILE}", ПЕРЕЧЕНЬ_BACKEND),
            (f"zabbix/{RECON_FILE}", ПЕРЕЧЕНЬ_BACKEND),
        ],
        None,
    )
    assert plan.report.errors and "несколько перечней" in plan.report.errors[0]
    assert plan.node is None


def test_спека_вместо_перечня_объясняется(db):
    _node(db, "backend")
    nodes = db.query(Node).all()
    plan = build_recon_plan(db, nodes, [("openapi.yaml", СПЕКА)], None)
    assert plan.report.errors and "OpenAPI-спека" in plan.report.errors[0]


def test_перечень_среди_папки_находится(db):
    """Пользователь вправе перетащить папку целиком — соседи перечню не мешают."""
    backend = _node(db, "backend")
    nodes = db.query(Node).all()
    plan = build_recon_plan(
        db,
        nodes,
        [
            ("api.yaml", СПЕКА),
            ("logic.mmd", "flowchart TD\n  A --> B\n"),
            ("archmap-recon.yaml", ПЕРЕЧЕНЬ_BACKEND),
        ],
        None,
    )
    assert not plan.report.errors and plan.node is not None and plan.node.id == backend.id


def test_контейнер_адресат_предупреждает(db):
    """Р15: заглушки у контейнера дадут штатный алерт AL24 — узнать об этом надо здесь."""
    корень = _node(db, "Zulip")
    _node(db, "backend", корень)
    report = _план(db, "node: Zulip\noperations:\n  - GET /a\n").report
    assert not report.errors
    assert any("контейнер" in w for w in report.warnings)


# ── Ловушки: заглушка — это документация, которой нет ─────────────────────────
def test_массовые_заглушки_не_рождают_алертов(db):
    """Пустая схема не участвует в резолве пометок (alerts.py: `if not content`), но
    двести пустых схем не должны родить и никакого другого алерта."""
    _node(db, "backend")
    db.flush()
    было = compute_alerts(db, ensure_project(db).id).model_dump()

    перечень = "node: backend\noperations:\n" + "".join(f"  - GET /op{i}\n" for i in range(200))
    report = _применить(db, перечень)
    assert report.created == 200

    assert compute_alerts(db, ensure_project(db).id).model_dump() == было
    # Заглушка у ЛИСТА алерта «контейнер со своей документацией» не даёт.
    assert compute_alerts(db, ensure_project(db).id).container_own_docs == []


def test_копия_проекта_переживает_заглушки(db):
    backend = _node(db, "backend")
    _применить(db, ПЕРЕЧЕНЬ_BACKEND)
    db.commit()

    dst = Project(id=uuid.uuid4(), name="Копия")
    db.add(dst)
    db.flush()
    copy_project_schema(db, ensure_project(db).id, dst.id)
    db.commit()

    копия = db.query(Node).filter(Node.project_id == dst.id).one()
    docs = db.query(NodeDoc).filter(NodeDoc.node_id == копия.id).all()
    assert sorted(d.name for d in docs) == sorted(
        d.name for d in db.query(NodeDoc).filter(NodeDoc.node_id == backend.id).all()
    )
    assert all(d.content == "" for d in docs)


def test_удаление_и_восстановление_переживают_заглушки(db):
    backend = _node(db, "backend")
    _применить(db, ПЕРЕЧЕНЬ_BACKEND)
    db.commit()

    snap = build_deletion_snapshot(db, backend.id)
    delete_node(backend.id, db=db, project=ensure_project(db), user=ensure_architect(db))
    assert db.query(NodeDoc).count() == 0

    restore_from_snapshot(db, snap, project_id=ensure_project(db).id)
    db.flush()
    docs = db.query(NodeDoc).filter(NodeDoc.node_id == backend.id).all()
    assert sorted(d.name for d in docs) == ["GET /messages", "POST /messages", "email_senders"]
    assert all(d.content == "" for d in docs)


# ── Ручки ─────────────────────────────────────────────────────────────────────
def _вход(текст=ПЕРЕЧЕНЬ_BACKEND, node_id=None, имя="archmap-recon.yaml"):
    return ReconImportIn(files=[{"name": имя, "content": текст}], node_id=node_id)


def test_превью_ничего_не_пишет(db):
    _node(db, "backend")
    r = recon_import_preview(
        _вход(), db=db, project=ensure_project(db), _=ensure_architect(db)
    )
    assert not r.applied and r.created == 0
    assert [i.action for i in r.items] == ["create", "create", "create"]
    assert db.query(NodeDoc).count() == 0


def test_применение_пишет_и_двигает_курсор_меты(db):
    """Схемы — мета узла: поллинг страницы обязан увидеть появление заглушек, а тост
    схемы (graph_rev) от этого всплывать не должен."""
    _node(db, "backend")
    project = ensure_project(db)
    db.commit()
    g0, m0 = project.graph_rev, project.meta_rev

    r = recon_import_apply(_вход(), db=db, project=project, user=ensure_architect(db))
    db.refresh(project)

    assert (r.applied, r.created) == (True, 3)
    assert db.query(NodeDoc).count() == 3
    assert (project.graph_rev, project.meta_rev) == (g0, m0 + 1)


def test_ошибка_не_пишет_ничего(db):
    _node(db, "backend")
    r = recon_import_apply(
        _вход("node: нет-такого\noperations:\n  - GET /a\n"),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )
    assert not r.applied and r.errors and r.created == 0
    assert db.query(NodeDoc).count() == 0


def test_повторное_применение_ручкой_не_двигает_мету(db):
    """Второй прогон того же перечня — ноль созданий, и курсор меты стоит: сессиям
    соседей нечего перечитывать."""
    _node(db, "backend")
    project = ensure_project(db)
    arch = ensure_architect(db)
    recon_import_apply(_вход(), db=db, project=project, user=arch)
    db.refresh(project)
    m1 = project.meta_rev

    r = recon_import_apply(_вход(), db=db, project=project, user=arch)
    db.refresh(project)

    assert r.created == 0 and db.query(NodeDoc).count() == 3
    assert project.meta_rev == m1
