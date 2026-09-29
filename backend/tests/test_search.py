"""Поиск по знанию проекта (GET /api/v1/search, app/search.py).

Главный сценарий — полевой (2026-09-29): агент получает сырую строку лога с
переменными частями и должен первым же результатом попасть в строку схемы, где
эта ошибка описана, а не перебирать карточки объектов подряд.
"""

import uuid

import pytest
from conftest import ensure_project
from fastapi.testclient import TestClient

from app.auth import create_access_token
from app.database import get_db
from app.main import app
from app.models.broker_channel import BrokerChannel
from app.models.business_process import BusinessProcess
from app.models.channel_field import ChannelField
from app.models.config_param import ConfigParam
from app.models.db_column import DbColumn
from app.models.db_table import DbTable
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.process_message import ProcessMessage
from app.models.process_participant import ProcessParticipant
from app.models.project import Project
from app.models.user import User
from app.search import (
    SNIPPET_LEN,
    SearchQueryError,
    query_tokens,
    search,
    tokens_match,
)

SMS_LOG = "failed to send SMS: SMSDevices not configured for /dev/ttyUSB0"


def _node(db, project, name, parent=None, **kw) -> Node:
    n = Node(id=uuid.uuid4(), name=name, project_id=project.id,
             parent_id=parent.id if parent else None, **kw)
    db.add(n)
    db.flush()
    return n


def _doc(db, node, name, content, operation=None) -> NodeDoc:
    d = NodeDoc(id=uuid.uuid4(), node_id=node.id, name=name, kind="operation",
                operation=operation, content=content)
    db.add(d)
    db.flush()
    return d


def _zabbix(db) -> tuple[Project, NodeDoc]:
    """Сцена по мотивам полевого прогона: схема SMS-отправки с веткой отказа и
    шумовые схемы, где тоже есть failed, send, for, SMS."""
    project = ensure_project(db)
    server = _node(db, project, "Zabbix server")
    alerter = _node(db, project, "Alerter", server,
                    description="Отправщик оповещений: email, SMS, скрипты, webhook")
    sms = _doc(db, alerter, "SMS: отправка", "\n".join([
        "flowchart TD",
        "  A[Получено задание SMS от alert manager] --> B{Устройство в SMSDevices?}",
        "  B -->|да| C[Отправить SMS через модем]",
        "  B -->|нет| E[Ошибка: SMSDevices not configured for <устройство>]",
        "  C --> D[Результат в alert manager]",
    ]))
    _doc(db, alerter, "Email: отправка", "\n".join([
        "flowchart TD",
        "  A[Отправить письмо] --> B{Успешно?}",
        "  B -->|нет| F[failed to send email: SMTP error for recipient]",
    ]))
    _doc(db, alerter, "Webhook: отправка", "\n".join([
        "flowchart TD",
        "  A[Выполнить webhook] --> F[failed to send webhook request for URL]",
    ]))
    _doc(db, alerter, "Скрипт: отправка", "\n".join([
        "flowchart TD",
        "  A[Запустить скрипт] --> E[Ошибка: failed to send for script, SMS не при чём]",
    ]))
    db.add(ConfigParam(node_id=server.id, name="SMSDevices",
                       description="Модемы, через которые разрешено слать SMS"))
    db.commit()
    return project, sms


# ── Главный сценарий ─────────────────────────────────────────────────────────


def test_строка_лога_находит_ветку_отказа_первой(db):
    project, sms = _zabbix(db)

    res = search(db, project.id, SMS_LOG)

    first = res.hits[0]
    assert (first.kind, first.doc_id, first.line_no) == ("doc", sms.id, 4)
    assert "SMSDevices not configured for <устройство>" in first.snippet
    assert first.node_path == "Zabbix server / Alerter"
    assert first.title == "SMS: отправка"
    # Решают редкие слова, а не общие failed/send/SMS.
    assert set(first.matched) == {"smsdevices", "not", "configured"}
    # Шум с failed + send (+ SMS) нашёлся, но ниже.
    noise = [h for h in res.hits if h.title in ("Email: отправка", "Скрипт: отправка")]
    assert len(noise) == 2 and all(h.score < first.score for h in noise)


def test_not_отличает_ветку_отказа(db):
    """`not` не стоп-слово: без него строки «configured» и «not configured» равны,
    и выше встала бы ранняя по номеру — ветка УСПЕХА."""
    project = ensure_project(db)
    svc = _node(db, project, "Alerter")
    doc = _doc(db, svc, "SMS", "\n".join([
        "flowchart TD",
        "  B -->|да| C[SMSDevices configured for <устройство>: отправить]",
        "  B -->|нет| E[SMSDevices not configured for <устройство>]",
    ]))
    db.commit()

    assert "not" in query_tokens(SMS_LOG)
    first = search(db, project.id, SMS_LOG).hits[0]
    assert (first.doc_id, first.line_no) == (doc.id, 3)


# ── Токены, веса, окончания ──────────────────────────────────────────────────


def test_токены_запроса():
    # «to», «for», числа и повторы отброшены; переменная часть осталась, но не мешает.
    assert query_tokens("cannot process alertid:123: unsupported media type: 7") == [
        "cannot", "process", "alertid", "unsupported", "media", "type",
    ]
    assert query_tokens(SMS_LOG) == [
        "failed", "send", "sms", "smsdevices", "not", "configured", "dev", "ttyusb0",
    ]
    assert query_tokens("Почему и как это починить?") == ["починить"]


def test_окончания_сравниваются_без_двух_последних_символов():
    assert tokens_match("оповещения", "оповещение")
    assert tokens_match("оповещение", "оповещениями")
    assert tokens_match("failed", "fail")
    # Короткие — только точно; длины расходятся не больше чем на два.
    assert not tokens_match("sms", "smsdevices")
    assert not tokens_match("send", "sends")
    assert not tokens_match("status", "statistics")


def test_русские_окончания_находят_строку(db):
    project = ensure_project(db)
    svc = _node(db, project, "Escalator")
    doc = _doc(db, svc, "Эскалация", "flowchart TD\n  A[Отправка оповещения по email]")
    db.commit()

    res = search(db, project.id, "не пришло оповещение на email")

    assert (res.hits[0].doc_id, res.hits[0].line_no) == (doc.id, 2)
    assert set(res.hits[0].matched) == {"оповещение", "email"}


def test_частое_слово_не_перебивает_редкое(db):
    """IDF: строка с двумя частыми словами ниже строки с частым и редким."""
    project = ensure_project(db)
    svc = _node(db, project, "Alert manager")
    frequent = "\n".join(f"  N{i}[alert queue шаг {i}]" for i in range(8))
    doc = _doc(db, svc, "Очередь", "flowchart TD\n" + frequent + "\n  Z[alert escalation]")
    db.commit()

    res = search(db, project.id, "alert queue escalation")

    assert res.hits[0].line_no == 10 and res.hits[0].doc_id == doc.id
    assert res.hits[0].matched[0] == "escalation"
    assert res.hits[0].score > res.hits[1].score


def test_фраза_целиком_получает_бонус(db):
    """Слова вразброс и та же фраза подряд набирают одинаково по токенам; бонус
    ставит фразу выше, хоть она и ниже по номеру строки."""
    project = ensure_project(db)
    svc = _node(db, project, "Alert manager")
    doc = _doc(db, svc, "Способы доставки", "\n".join([
        "flowchart TD",
        "  A[type of media is unsupported] --> B",
        "  G -->|иначе| T[FAILED: unsupported media type]",
    ]))
    db.commit()

    res = search(db, project.id, "unsupported media type")

    assert (res.hits[0].doc_id, res.hits[0].line_no) == (doc.id, 3)
    assert res.hits[0].score > res.hits[1].score


def test_сниппет_обрезан_вокруг_совпадения(db):
    project = ensure_project(db)
    svc = _node(db, project, "Alerter")
    line = "  A[" + "начало " * 60 + "SMSDevices not configured" + " хвост" * 60 + "]"
    _doc(db, svc, "Длинная", "flowchart TD\n" + line)
    db.commit()

    hit = search(db, project.id, SMS_LOG).hits[0]

    assert hit.snippet.startswith("…") and hit.snippet.endswith("…")
    assert "SMSDevices" in hit.snippet
    assert len(hit.snippet) <= SNIPPET_LEN + 2


# ── Все виды единиц ──────────────────────────────────────────────────────────


def _все_виды(db, project) -> dict[str, object]:
    """По уникальному слову на каждый вид единицы."""
    front = _node(db, project, "Шлюз", description="Балансировщик frontdoor")
    front.openapi_spec = "openapi: 3.0.0\npaths:\n  /widgets:\n    get:\n      summary: list gizmoz"
    pay = _node(db, project, "Платежи", front)
    doc = _doc(db, pay, "Приём платежа", "flowchart TD\n  A[Проверить quotacheck]",
               operation="POST /payments/intake")
    base = _node(db, project, "БД платежей", pay, shape="database")
    table = DbTable(node_id=base.id, name="ledger", description="Журнал проводок")
    db.add(table)
    db.flush()
    db.add(DbColumn(table_id=table.id, name="amount_cents", type="bigint",
                    description="Сумма в копейках"))
    broker = _node(db, project, "Брокер", shape="broker")
    channel = BrokerChannel(node_id=broker.id, name="invoice_events", kind="topic")
    db.add(channel)
    db.flush()
    db.add(ChannelField(channel_id=channel.id, name="payer_ref", type="string"))
    db.add(ConfigParam(node_id=pay.id, name="FEATURE_TURBO", default_value="false",
                       description="Включает ускоренный режим"))
    proc = BusinessProcess(id=uuid.uuid4(), name="Оформление подписки", project_id=project.id)
    db.add(proc)
    db.flush()
    a = ProcessParticipant(id=uuid.uuid4(), process_id=proc.id, node_id=front.id,
                           name="Шлюз", order=0)
    b = ProcessParticipant(id=uuid.uuid4(), process_id=proc.id, node_id=pay.id,
                           name="Платежи", order=1)
    db.add_all([a, b])
    db.flush()
    msg = ProcessMessage(id=uuid.uuid4(), process_id=proc.id, order=0, leg="forward",
                         from_participant_id=a.id, to_participant_id=b.id,
                         caption="Списать абонплату", doc_id=doc.id)
    db.add(msg)
    db.commit()
    return {"front": front, "pay": pay, "doc": doc, "base": base, "broker": broker,
            "proc": proc, "msg": msg}


@pytest.mark.parametrize(
    ("query", "kind", "title"),
    [
        ("frontdoor", "node", "Шлюз"),
        ("intake", "doc", "Приём платежа"),
        ("quotacheck", "doc", "Приём платежа"),
        ("gizmoz", "spec", "OpenAPI"),
        ("ledger", "table", "ledger"),
        ("amount_cents", "column", "ledger.amount_cents"),
        ("invoice_events", "channel", "invoice_events"),
        ("payer_ref", "field", "invoice_events.payer_ref"),
        ("feature_turbo", "param", "FEATURE_TURBO"),
        ("подписки", "process", "Оформление подписки"),
        ("абонплату", "step", "Оформление подписки"),
    ],
)
def test_каждый_вид_находится(db, query, kind, title):
    project = ensure_project(db)
    scene = _все_виды(db, project)

    res = search(db, project.id, query)

    # Имя таблицы (канала) есть и в адресе её колонки (поля) — вторая находка ниже.
    assert res.total == (2 if kind in ("table", "channel") else 1)
    hit = res.hits[0]
    assert (hit.kind, hit.title) == (kind, title)
    if query == "quotacheck":
        assert hit.line_no == 2 and hit.doc_id == scene["doc"].id
    if kind == "spec":
        assert hit.line_no == 5 and hit.node_path == "Шлюз"
    if kind in ("table", "column"):
        assert hit.node_path == "Шлюз / Платежи / БД платежей"
    if kind in ("process", "step"):
        assert hit.process_id == scene["proc"].id and hit.node_id is None
    if kind == "step":
        # Шаг, привязанный к схеме, ведёт и к ней.
        assert hit.message_id == scene["msg"].id and hit.doc_id == scene["doc"].id


def test_колонка_и_поле_ищутся_по_адресу(db):
    """«таблица.колонка» и «канал.поле» — так их называют пометки схем и логи."""
    project = ensure_project(db)
    _все_виды(db, project)

    column = search(db, project.id, "ledger.amount_cents").hits[0]
    field = search(db, project.id, "invoice_events payer_ref").hits[0]

    assert (column.kind, column.title) == ("column", "ledger.amount_cents")
    assert column.snippet == "ledger.amount_cents bigint · Сумма в копейках"
    assert (field.kind, field.title) == ("field", "invoice_events.payer_ref")


def test_заголовок_схемы_без_номера_строки(db):
    project = ensure_project(db)
    scene = _все_виды(db, project)

    hit = search(db, project.id, "intake").hits[0]

    assert hit.line_no is None and hit.doc_id == scene["doc"].id
    assert hit.snippet == "Приём платежа · POST /payments/intake"


# ── Порог, кап, limit, kinds ─────────────────────────────────────────────────


def test_порог_два_токена(db):
    """Одно общее слово с запросом — ещё не находка: строки только с SMS или только
    с webhook отсеяны, прошёл один объект, где есть оба."""
    project, _ = _zabbix(db)

    res = search(db, project.id, "SMS webhook")

    assert res.total == 1
    assert (res.hits[0].kind, res.hits[0].title) == ("node", "Alerter")


def test_кап_три_строки_на_схему(db):
    project = ensure_project(db)
    svc = _node(db, project, "Alert manager")
    body = "\n".join(f"  N{i}[retry backoff шаг {i}]" for i in range(6))
    doc = _doc(db, svc, "Повторы", "flowchart TD\n" + body)
    db.add(ConfigParam(node_id=svc.id, name="RetryBackoff", description="retry backoff в секундах"))
    db.commit()

    res = search(db, project.id, "retry backoff")

    from_doc = [h for h in res.hits if h.doc_id == doc.id]
    assert len(from_doc) == 3
    assert all(h.more_in_group == 3 for h in from_doc)
    assert res.total == 7
    assert [h.kind for h in res.hits].count("param") == 1


def _params(db, project, n) -> None:
    svc = _node(db, project, "Alerter")
    for i in range(n):
        db.add(ConfigParam(node_id=svc.id, name=f"P{i}", description="retry policy"))
    _doc(db, svc, "Повтор", "flowchart TD\n  A[retry policy]")
    db.commit()


def test_limit_и_total(db):
    project = ensure_project(db)
    _params(db, project, 5)

    res = search(db, project.id, "retry policy", limit=2)

    assert len(res.hits) == 2 and res.total == 6


def test_kinds_фильтрует_виды(db):
    project = ensure_project(db)
    _params(db, project, 5)

    res = search(db, project.id, "retry policy", kinds={"doc"})

    assert [h.kind for h in res.hits] == ["doc"] and res.total == 1


def test_пустой_запрос_и_запрос_без_значимых_слов(db):
    project = ensure_project(db)
    with pytest.raises(SearchQueryError, match="Пустой запрос"):
        search(db, project.id, "   ")
    with pytest.raises(SearchQueryError, match="нет значимых слов"):
        search(db, project.id, "to be or 42 for the")


# ── Изоляция ─────────────────────────────────────────────────────────────────


def test_изоляция_проектов(db):
    p1, _ = _zabbix(db)
    p2 = Project(id=uuid.uuid4(), name="Чужой")
    db.add(p2)
    db.flush()
    other = _node(db, p2, "Чужой alerter")
    _doc(db, other, "SMS", "flowchart TD\n  E[SMSDevices not configured for <x>]")
    db.commit()

    mine = search(db, p1.id, SMS_LOG)
    theirs = search(db, p2.id, SMS_LOG)

    assert all(h.node_path and h.node_path.startswith("Zabbix server") for h in mine.hits)
    assert [h.node_path for h in theirs.hits] == ["Чужой alerter"]


# ── HTTP: роли, валидация, параметры ─────────────────────────────────────────


@pytest.fixture()
def viewer_client(db):
    """Настоящая аутентификация читателем: поиск — чтение, ему открыт."""
    db.add(User(id=uuid.uuid4(), username="reader", hashed_password="x", role="viewer"))
    db.commit()
    app.dependency_overrides[get_db] = lambda: db
    token = create_access_token({"sub": "reader", "role": "viewer"})
    try:
        client = TestClient(app)
        client.headers["Authorization"] = f"Bearer {token}"
        yield client
    finally:
        app.dependency_overrides.clear()


def test_читатель_может_искать(db, viewer_client):
    project, sms = _zabbix(db)

    resp = viewer_client.get(
        "/api/v1/search", params={"q": SMS_LOG}, headers={"X-Project-Id": str(project.id)}
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["hits"][0]["doc_id"] == str(sms.id) and body["hits"][0]["line_no"] == 4
    assert body["tokens"][:3] == ["failed", "send", "sms"]


def test_http_422_на_пустой_запрос(db, viewer_client):
    project = ensure_project(db)
    db.commit()
    headers = {"X-Project-Id": str(project.id)}

    for params in ({}, {"q": ""}, {"q": "to be 42"}):
        resp = viewer_client.get("/api/v1/search", params=params, headers=headers)
        assert resp.status_code == 422
        assert isinstance(resp.json()["detail"], str)


def test_http_limit_и_kinds(db, viewer_client):
    project = ensure_project(db)
    _params(db, project, 5)
    headers = {"X-Project-Id": str(project.id)}

    resp = viewer_client.get(
        "/api/v1/search", params={"q": "retry policy", "limit": 3}, headers=headers
    )
    assert resp.status_code == 200 and len(resp.json()["hits"]) == 3
    assert resp.json()["total"] == 6

    resp = viewer_client.get(
        "/api/v1/search",
        params=[("q", "retry policy"), ("kinds", "doc"), ("kinds", "node")],
        headers=headers,
    )
    assert [h["kind"] for h in resp.json()["hits"]] == ["doc"]

    assert viewer_client.get(
        "/api/v1/search", params={"q": "retry", "limit": 101}, headers=headers
    ).status_code == 422
    assert viewer_client.get(
        "/api/v1/search", params={"q": "retry", "kinds": "nonsense"}, headers=headers
    ).status_code == 422


def test_http_без_проекта_400(viewer_client):
    assert viewer_client.get("/api/v1/search", params={"q": "retry"}).status_code == 400


# ── Одна схема: GET /nodes/{node_id}/docs/{doc_id} ───────────────────────────


def _doc_url(node, doc) -> str:
    return f"/api/v1/nodes/{node.id}/docs/{doc.id}"


def test_одна_схема_целиком_с_метой(db, viewer_client):
    project = ensure_project(db)
    scene = _все_виды(db, project)
    headers = {"X-Project-Id": str(project.id)}

    resp = viewer_client.get(_doc_url(scene["pay"], scene["doc"]), headers=headers)

    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == str(scene["doc"].id) and body["name"] == "Приём платежа"
    assert body["content"] == "flowchart TD\n  A[Проверить quotacheck]"
    assert body["operation"] == "POST /payments/intake" and body["kind"] == "operation"
    assert body["node_path"] == "Шлюз / Платежи"
    assert body["described"] is True
    assert body["processes"] == [{
        "doc_id": str(scene["doc"].id), "process_id": str(scene["proc"].id),
        "process_name": "Оформление подписки", "steps": 1,
    }]
    # Обратный индекс узла по-прежнему отвечает: /usage объявлен раньше /{doc_id}.
    usage = viewer_client.get(f"/api/v1/nodes/{scene['pay'].id}/docs/usage", headers=headers)
    assert usage.status_code == 200 and len(usage.json()) == 1


def test_одна_схема_заглушка_не_описана(db, viewer_client):
    project = ensure_project(db)
    svc = _node(db, project, "Alerter")
    stub = _doc(db, svc, "POST /alerts", "")
    db.commit()

    body = viewer_client.get(
        _doc_url(svc, stub), headers={"X-Project-Id": str(project.id)}
    ).json()

    assert body["described"] is False and body["content"] == ""
    assert body["processes"] == [] and body["node_path"] == "Alerter"


def test_одна_схема_404_на_чужой_узел_и_чужую_схему(db, viewer_client):
    project = ensure_project(db)
    a = _node(db, project, "A")
    b = _node(db, project, "B")
    doc_b = _doc(db, b, "Схема B", "flowchart TD")
    other = Project(id=uuid.uuid4(), name="Чужой")
    db.add(other)
    db.flush()
    foreign = _node(db, other, "Чужой узел")
    foreign_doc = _doc(db, foreign, "Чужая схема", "flowchart TD")
    db.commit()
    headers = {"X-Project-Id": str(project.id)}

    # Схема чужого узла того же проекта.
    resp = viewer_client.get(_doc_url(a, doc_b), headers=headers)
    assert resp.status_code == 404 and resp.json()["detail"] == "Схема не найдена"
    # Узел и схема чужого проекта.
    resp = viewer_client.get(_doc_url(foreign, foreign_doc), headers=headers)
    assert resp.status_code == 404 and resp.json()["detail"] == "Узел не найден"
    # Схема чужого проекта под своим узлом.
    resp = viewer_client.get(_doc_url(a, foreign_doc), headers=headers)
    assert resp.status_code == 404
    # Несуществующая.
    resp = viewer_client.get(f"/api/v1/nodes/{a.id}/docs/{uuid.uuid4()}", headers=headers)
    assert resp.status_code == 404
