"""API версий документации (app/routers/versions.py, app/versions.py; Ф1 эпика
doc-versions).

Через настоящие зависимости доступа: читатель видит историю, но не фиксирует;
редактор фиксирует, но не удаляет; удаляет только владелец. Две группы ручек —
объект (/nodes/{id}/versions) и весь проект (/versions) — на одном коде, нумерация
у каждого своя.
"""

import types
import uuid

import pytest
from conftest import ensure_architect, make_project
from fastapi.testclient import TestClient

from app import demo, demo_limits, personal_tokens, restore
from app.auth import create_access_token
from app.config import settings
from app.database import get_db
from app.demo_limits import DEMO_LIMIT_CODE
from app.main import app
from app.models.business_process import BusinessProcess
from app.models.config_param import ConfigParam
from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.node_version import NodeVersion
from app.models.process_message import ProcessMessage
from app.models.process_participant import ProcessParticipant
from app.models.project_member import ProjectMember
from app.models.user import User
from app.versions import create_version, pending

API = "/api/v1"
DOC = "flowchart TD\n  A[POST /orders] --> B[проверить]\n  B --> C[201]"
SPEC = "openapi: 3.0.0\npaths:\n  /orders:\n    post: {summary: Создать}"


@pytest.fixture()
def client(db):
    def _db():
        try:
            yield db
        except Exception:
            # Сессию делят все запросы теста: откатываем её, как прод закрывает свою.
            db.rollback()
            raise

    app.dependency_overrides[get_db] = _db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _headers(user: User, project) -> dict[str, str]:
    token = create_access_token({"sub": user.username, "role": user.role})
    return {"Authorization": f"Bearer {token}", "X-Project-Id": str(project.id)}


@pytest.fixture()
def s(db) -> types.SimpleNamespace:
    """«Магазин» (контейнер) с «Заказами» (схема, спека, параметр) и «Оплатами»; «Банк»
    снаружи, связан с «Заказами». Процесс «Оформление»: Заказы → Оплаты. Владелец,
    редактор и читатель проекта."""
    s = types.SimpleNamespace()
    s.owner = ensure_architect(db)
    s.editor = User(id=uuid.uuid4(), username="editor", hashed_password="x", role="architect")
    s.reader = User(id=uuid.uuid4(), username="reader", hashed_password="x", role="architect")
    db.add_all([s.editor, s.reader])
    s.p = make_project(db, "Магазин", owner=s.owner)
    db.add_all([
        ProjectMember(project_id=s.p.id, user_id=s.editor.id, role="editor"),
        ProjectMember(project_id=s.p.id, user_id=s.reader.id, role="reader"),
    ])
    pid = s.p.id
    s.shop = Node(id=uuid.uuid4(), project_id=pid, name="Магазин")
    s.bank = Node(id=uuid.uuid4(), project_id=pid, name="Банк", is_external=True)
    db.add_all([s.shop, s.bank])
    db.flush()
    s.orders = Node(id=uuid.uuid4(), project_id=pid, name="Заказы", parent_id=s.shop.id,
                    openapi_spec=SPEC)
    s.pay = Node(id=uuid.uuid4(), project_id=pid, name="Оплаты", parent_id=s.shop.id)
    db.add_all([s.orders, s.pay])
    db.flush()
    s.edge = Edge(project_id=pid, source_id=s.orders.id, target_id=s.pay.id, label="оплатить")
    s.e_bank = Edge(project_id=pid, source_id=s.bank.id, target_id=s.orders.id, label="статус")
    s.doc = NodeDoc(node_id=s.orders.id, name="Создать заказ", content=DOC)
    s.param = ConfigParam(node_id=s.orders.id, name="ORDER_TTL_H", default_value="24")
    s.proc = BusinessProcess(project_id=pid, name="Оформление")
    db.add_all([s.edge, s.e_bank, s.doc, s.param, s.proc])
    db.flush()
    p_orders = ProcessParticipant(process_id=s.proc.id, node_id=s.orders.id, name="Заказы", order=0)
    p_pay = ProcessParticipant(process_id=s.proc.id, node_id=s.pay.id, name="Оплаты", order=1)
    db.add_all([p_orders, p_pay])
    db.flush()
    s.step = ProcessMessage(
        process_id=s.proc.id, order=0, edge_id=s.edge.id, leg="forward",
        from_participant_id=p_orders.id, to_participant_id=p_pay.id, caption="оплатить",
    )
    db.add(s.step)
    db.commit()
    s.h = _headers(s.owner, s.p)
    s.h_editor = _headers(s.editor, s.p)
    s.h_reader = _headers(s.reader, s.p)
    s.shop_url = f"{API}/nodes/{s.shop.id}/versions"
    s.orders_url = f"{API}/nodes/{s.orders.id}/versions"
    return s


def _fix(client, url: str, headers, comment: str = "релиз") -> dict:
    res = client.post(url, json={"comment": comment}, headers=headers)
    assert res.status_code == 201, res.text
    return res.json()


def _pending(client, url: str, headers) -> dict:
    res = client.get(url, headers=headers)
    assert res.status_code == 200, res.text
    return res.json()["pending"]


# ── Список, фиксация, pending ──────────────────────────────────────────────────


def test_версий_нет_список_пуст_изменения_есть(client, s):
    res = client.get(s.orders_url, headers=s.h_reader)

    assert res.status_code == 200
    assert res.json() == {"versions": [], "pending": {"changed": True, "items": []}}


def test_фиксация_первой_версии(client, s):
    v1 = _fix(client, s.orders_url, s.h_editor, "  orders 2.1 · ORD-380  ")

    assert (v1["number"], v1["comment"], v1["kind"], v1["restored_from"]) == (
        1, "orders 2.1 · ORD-380", "manual", None,
    )
    assert v1["author"] == "editor" and v1["created_at"]
    stats = v1["stats"]
    assert (stats["nodes"], stats["edges"], stats["docs"], stats["params"], stats["processes"]) == (
        1, 2, 1, 1, 1,
    )
    # Первая — относительно пустого среза: всё добавлено.
    assert {c["status"] for c in stats["changed"]} == {"added"}
    assert {c["category"] for c in stats["changed"]} == {
        "props", "edges", "doc", "spec", "config", "process",
    }

    listed = client.get(s.orders_url, headers=s.h_reader).json()
    assert [v["number"] for v in listed["versions"]] == [1]
    assert listed["versions"][0] == v1
    assert listed["pending"] == {"changed": False, "items": []}


def test_правки_видны_в_pending_и_в_stats_следующей_версии(client, db, s):
    _fix(client, s.shop_url, s.h)
    s.orders.description = "Принимает заказы"
    s.doc.content = DOC + "\n  C --> D[публикует: orders.created]"
    db.add(Edge(project_id=s.p.id, source_id=s.pay.id, target_id=s.bank.id, label="списать"))
    db.add(ConfigParam(node_id=s.orders.id, name="ORDER_CANCEL_MIN", default_value="30"))
    s.step.caption = "провести оплату"
    db.add(Node(id=uuid.uuid4(), project_id=s.p.id, name="Поиск", parent_id=s.shop.id))
    db.commit()
    res = client.patch(f"{API}/nodes/{s.orders.id}", json={"approval": "approved"}, headers=s.h)
    assert res.status_code == 200, res.text

    pend = _pending(client, s.shop_url, s.h)
    assert pend["changed"] is True
    cats = [i["category"] for i in pend["items"]]
    assert cats == ["props", "props", "edges", "doc", "config", "approval", "process"]
    added = next(i for i in pend["items"] if i["status"] == "added")
    assert (added["category"], added["name"], added["node_path"]) == ("props", "Поиск", "Поиск")

    v2 = _fix(client, s.shop_url, s.h, "v2")
    assert [c["item_id"] for c in v2["stats"]["changed"]] == [i["item_id"] for i in pend["items"]]
    assert _pending(client, s.shop_url, s.h)["changed"] is False


def test_фиксация_не_двигает_курсоры_и_дату_проекта(client, db, s):
    db.refresh(s.p)
    before = (s.p.graph_rev, s.p.meta_rev, s.p.updated_at)

    _fix(client, s.orders_url, s.h)

    db.refresh(s.p)
    assert (s.p.graph_rev, s.p.meta_rev, s.p.updated_at) == before


def test_переименование_узла_вне_среза_не_изменение(client, db, s):
    _fix(client, s.shop_url, s.h)
    s.bank.name = "Банк-партнёр"  # связан с «Заказами», но вне «Магазина»
    db.commit()

    assert _pending(client, s.shop_url, s.h) == {"changed": False, "items": []}


def test_pending_по_перечню_если_хэш_версии_устарел(db, s):
    """Хэш сохранённой версии посчитан проекцией своего времени: разошёлся без единого
    изменения — «изменений нет», а не «есть» с пустым перечнем."""
    row = create_version(db, s.p, s.owner, s.orders, "v1")
    row.content_hash = "0" * 64
    db.commit()

    assert pending(db, s.p, s.orders).model_dump() == {"changed": False, "items": []}


# ── Дельта и элементы ──────────────────────────────────────────────────────────


def _two_versions(client, db, s) -> None:
    _fix(client, s.orders_url, s.h, "v1")
    s.doc.content = DOC.replace("проверить", "зарезервировать")
    s.orders.technology = "Python 3.12"
    db.commit()
    _fix(client, s.orders_url, s.h, "v2")


def test_дельта_с_предыдущей_с_номером_и_с_текущим(client, db, s):
    _two_versions(client, db, s)

    prev = client.get(f"{s.orders_url}/2/diff", headers=s.h_reader).json()
    assert (prev["base"]["number"], prev["base"]["comment"]) == (1, "v1")
    assert prev["target"]["number"] == 2
    assert [i["item_id"] for i in prev["items"]] == [f"props:{s.orders.id}", f"doc:{s.doc.id}"]
    assert prev["items"][0]["summary"] == "технология"

    by_number = client.get(f"{s.orders_url}/2/diff?base=1", headers=s.h).json()
    assert by_number["items"] == prev["items"]

    # live: от версии n к текущему — что изменилось с v1.
    live = client.get(f"{s.orders_url}/1/diff?base=live", headers=s.h).json()
    assert live["base"]["number"] == 1
    assert live["target"] == {"number": None, "comment": None, "created_at": None}
    assert live["items"] == prev["items"]
    assert client.get(f"{s.orders_url}/2/diff?base=live", headers=s.h).json()["items"] == []

    # У первой версии «с предыдущей» — от пустого: базы нет, всё добавлено.
    first = client.get(f"{s.orders_url}/1/diff", headers=s.h).json()
    assert first["base"] is None
    assert {i["status"] for i in first["items"]} == {"added"}


def test_элемент_дельты_три_представления(client, db, s):
    _two_versions(client, db, s)

    res = client.get(f"{s.orders_url}/2/diff/doc:{s.doc.id}", headers=s.h_reader)

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["item"]["category"] == "doc" and body["item"]["summary"] == "+1 −1"
    marks = [ln["mark"] for ln in body["changes"]["lines"]]
    assert marks[0] == "mod" and "add" in marks and "del" in marks
    assert body["before"] == {"text": DOC, "lines": None, "columns": None, "rows": None}
    assert body["after"]["text"] == DOC.replace("проверить", "зарезервировать")

    props = client.get(f"{s.orders_url}/2/diff/props:{s.orders.id}", headers=s.h).json()
    assert props["changes"]["columns"] == ["Поле", "Было", "Стало"]
    assert props["changes"]["rows"] == [
        {"mark": "mod", "cells": ["технология", "—", "Python 3.12"], "changed": []},
    ]

    for item_id in (f"props:{uuid.uuid4()}", f"edge:{s.edge.id}", "чепуха"):
        res = client.get(f"{s.orders_url}/2/diff/{item_id}", headers=s.h)
        assert res.status_code == 404, item_id


def test_перенос_объекта_подписан_живым_путём(client, db, s):
    _fix(client, s.orders_url, s.h)
    s.orders.parent_id = None
    db.commit()
    _fix(client, s.orders_url, s.h)

    res = client.get(f"{s.orders_url}/2/diff/props:{s.orders.id}", headers=s.h).json()

    assert res["changes"]["rows"] == [
        {"mark": "mod", "cells": ["родитель", "Магазин", "верхний уровень"], "changed": []},
    ]


def test_дельта_отказы(client, db, s):
    _fix(client, s.orders_url, s.h)

    res = client.get(f"{s.orders_url}/1/diff?base=вчера", headers=s.h)
    assert res.status_code == 422
    assert res.json() == {"detail": "С чем сравнивать: prev, live или номер версии"}
    assert client.get(f"{s.orders_url}/1/diff?base=7", headers=s.h).status_code == 404
    assert client.get(f"{s.orders_url}/9/diff", headers=s.h).status_code == 404
    assert client.get(f"{s.orders_url}/9/diff/doc:{s.doc.id}", headers=s.h).status_code == 404


# ── Тексты на версии ───────────────────────────────────────────────────────────


def test_тексты_на_версии(client, db, s):
    _two_versions(client, db, s)

    doc1 = client.get(f"{s.orders_url}/1/doc/{s.doc.id}", headers=s.h_reader).json()
    assert doc1 == {"name": "Создать заказ", "text": DOC}
    doc2 = client.get(f"{s.orders_url}/2/doc/{s.doc.id}", headers=s.h).json()
    assert "зарезервировать" in doc2["text"]
    spec = client.get(f"{s.orders_url}/1/spec/{s.orders.id}", headers=s.h).json()
    assert spec == {"name": "Заказы", "text": SPEC}
    proc = client.get(f"{s.orders_url}/1/process/{s.proc.id}", headers=s.h).json()
    assert proc["name"] == "Оформление"
    assert "sequenceDiagram" in proc["text"]
    assert "оплатить" in proc["text"]

    missing = [
        f"{s.orders_url}/1/doc/{uuid.uuid4()}",
        f"{s.orders_url}/1/spec/{s.pay.id}",  # «Оплат» в срезе «Заказов» нет
        f"{s.orders_url}/1/process/{uuid.uuid4()}",
        f"{s.orders_url}/5/doc/{s.doc.id}",
    ]
    for url in missing:
        assert client.get(url, headers=s.h).status_code == 404, url


# ── Комментарий ────────────────────────────────────────────────────────────────


def test_комментарий_пустой_и_слишком_длинный_422(client, db, s):
    res = client.post(s.orders_url, json={"comment": "   "}, headers=s.h)
    assert res.status_code == 422
    assert res.json() == {"detail": "Комментарий версии не может быть пустым"}

    res = client.post(s.orders_url, json={"comment": "x" * 513}, headers=s.h)
    assert res.status_code == 422
    assert res.json() == {"detail": "Поле «comment» длиннее 512 символов"}
    assert db.query(NodeVersion).count() == 0


# ── Права и изоляция ───────────────────────────────────────────────────────────


def test_читатель_видит_но_не_фиксирует(client, s):
    assert client.get(s.orders_url, headers=s.h_reader).status_code == 200
    res = client.post(s.orders_url, json={"comment": "v1"}, headers=s.h_reader)
    assert res.status_code == 403


def test_удаляет_только_владелец(client, s):
    _fix(client, s.orders_url, s.h_editor)

    assert client.delete(f"{s.orders_url}/1", headers=s.h_editor).status_code == 403
    assert client.delete(f"{s.orders_url}/1", headers=s.h_reader).status_code == 403
    assert client.delete(f"{s.orders_url}/1", headers=s.h).status_code == 204
    assert client.delete(f"{s.orders_url}/1", headers=s.h).status_code == 404
    assert client.get(s.orders_url, headers=s.h).json()["versions"] == []


def test_номер_max_плюс_один_пропуски_остаются(client, s):
    for comment in ("v1", "v2", "v3"):
        _fix(client, s.orders_url, s.h, comment)
    assert client.delete(f"{s.orders_url}/2", headers=s.h).status_code == 204

    # Пропуск не заполняется: следующая — v4, а не v2.
    assert _fix(client, s.orders_url, s.h, "v4")["number"] == 4
    numbers = [v["number"] for v in client.get(s.orders_url, headers=s.h).json()["versions"]]
    assert numbers == [4, 3, 1]
    # «Предыдущая» у v3 — v1, а не несуществующая v2.
    diff = client.get(f"{s.orders_url}/3/diff", headers=s.h).json()
    assert diff["base"]["number"] == 1
    # max + 1 (ТЗ §3): номер удалённой ПОСЛЕДНЕЙ версии освобождается.
    assert client.delete(f"{s.orders_url}/4", headers=s.h).status_code == 204
    assert _fix(client, s.orders_url, s.h, "v4 заново")["number"] == 4


def test_узел_другого_проекта_404(client, db, s):
    other = make_project(db, "Другой")
    stranger = Node(id=uuid.uuid4(), project_id=other.id, name="Чужой")
    db.add(stranger)
    db.commit()

    url = f"{API}/nodes/{stranger.id}/versions"
    assert client.get(url, headers=s.h).status_code == 404
    assert client.post(url, json={"comment": "v1"}, headers=s.h).status_code == 404


def test_версии_объекта_и_проекта_нумеруются_отдельно(client, s):
    _fix(client, s.orders_url, s.h)
    _fix(client, s.shop_url, s.h)
    root = f"{API}/versions"

    assert client.get(root, headers=s.h).json() == {
        "versions": [], "pending": {"changed": True, "items": []},
    }
    v1 = _fix(client, root, s.h_editor, "проект 1.0")
    assert v1["number"] == 1 and v1["stats"]["nodes"] == 4

    diff = client.get(f"{root}/1/diff", headers=s.h).json()
    paths = {i["node_path"] for i in diff["items"] if i["category"] == "props"}
    assert paths == {"Магазин", "Магазин / Заказы", "Магазин / Оплаты", "Банк"}
    assert client.get(f"{root}/1/doc/{s.doc.id}", headers=s.h).json()["text"] == DOC
    assert client.delete(f"{root}/1", headers=s.h).status_code == 204
    # Версии объектов от удаления версии проекта не пострадали.
    assert len(client.get(s.orders_url, headers=s.h).json()["versions"]) == 1


# ── Демо ───────────────────────────────────────────────────────────────────────


def test_демо_предел_версий_409(client, db, s, monkeypatch):
    monkeypatch.setattr(settings, "demo_mode", True)
    demo_limits.install()  # в проде — main.lifespan; TestClient без with его не запускает
    monkeypatch.setattr(demo, "MAX_VERSIONS", 1)
    _fix(client, s.orders_url, s.h)

    res = client.post(f"{API}/versions", json={"comment": "v1"}, headers=s.h)

    assert res.status_code == 409
    assert res.json() == {
        "detail": "Демо-проект поддерживает до 1 версий документации. "
        "Удалите ненужные, чтобы зафиксировать новые.",
        "code": DEMO_LIMIT_CODE,
    }
    assert db.query(NodeVersion).count() == 1


# ── Откат ──────────────────────────────────────────────────────────────────────


def test_превью_отката(client, db, s):
    _fix(client, s.shop_url, s.h)

    res = client.get(f"{s.shop_url}/1/restore-preview", headers=s.h_reader)

    assert res.status_code == 200, res.text
    assert res.json() == {"pending": False, "deleted_nodes": 0, "has_processes": True}
    db.add(Node(id=uuid.uuid4(), project_id=s.p.id, name="Поиск", parent_id=s.shop.id))
    db.commit()
    assert client.get(f"{s.shop_url}/1/restore-preview", headers=s.h).json() == {
        "pending": True, "deleted_nodes": 1, "has_processes": True,
    }
    assert client.get(f"{s.shop_url}/9/restore-preview", headers=s.h).status_code == 404


def test_откат_версии_замечания_курсоры(client, db, s):
    _fix(client, s.orders_url, s.h, "v1")
    s.orders.technology = "Go"
    db.delete(s.bank)  # связь «Банк → Заказы» вернуть будет не к чему
    db.commit()
    db.refresh(s.p)
    before = (s.p.graph_rev, s.p.meta_rev)

    res = client.post(f"{s.orders_url}/1/restore", headers=s.h_editor)

    assert res.status_code == 200, res.text
    assert res.json() == {
        "created": [2, 3],
        "deleted_nodes": 0,
        "remarks": ["связь «Банк → Магазин / Заказы» не восстановлена: объекта «Банк» больше нет"],
    }
    listed = client.get(s.orders_url, headers=s.h).json()
    assert [(v["number"], v["kind"], v["comment"], v["restored_from"]) for v in listed["versions"]] == [
        (3, "restore", "Откат к v1", 1),
        (2, "pre_restore", "Перед откатом к v1", None),
        (1, "manual", "v1", None),
    ]
    assert listed["versions"][0]["author"] == "editor"
    assert listed["pending"] == {"changed": False, "items": []}
    db.expire_all()
    assert db.get(Node, s.orders.id).technology is None
    # Откат меняет и схему (объекты, связи), и мету (тексты, факты): оба курсора.
    assert s.p.graph_rev > before[0] and s.p.meta_rev > before[1]


def test_откат_нечего_восстанавливать_422(client, s):
    _fix(client, s.orders_url, s.h)

    res = client.post(f"{s.orders_url}/1/restore", headers=s.h)

    assert res.status_code == 422
    assert res.json() == {"detail": "Нечего восстанавливать: документация совпадает с v1"}


def test_откат_права_изоляция_и_токен(client, db, s):
    _fix(client, s.orders_url, s.h)
    s.orders.technology = "Go"
    db.commit()

    assert client.post(f"{s.orders_url}/1/restore", headers=s.h_reader).status_code == 403
    assert client.post(f"{s.orders_url}/7/restore", headers=s.h).status_code == 404
    other = make_project(db, "Другой")
    stranger = Node(id=uuid.uuid4(), project_id=other.id, name="Чужой")
    db.add(stranger)
    db.commit()
    alien = f"{API}/nodes/{stranger.id}/versions/1"
    assert client.post(f"{alien}/restore", headers=s.h).status_code == 404
    assert client.get(f"{alien}/restore-preview", headers=s.h).status_code == 404
    # Откат удаляет объекты, появившиеся после версии: личным токеном нельзя (Р4), как
    # и «Принять переход». Превью — чтение, им можно.
    secret = personal_tokens.issue(db, s.editor, "Агент", False, 90).secret
    db.commit()
    token = {"Authorization": f"Bearer {secret}", "X-Project-Id": str(s.p.id)}
    res = client.post(f"{s.orders_url}/1/restore", headers=token)
    assert res.status_code == 403
    assert res.json() == {"detail": personal_tokens.SESSION_ONLY_DETAIL}
    assert client.get(f"{s.orders_url}/1/restore-preview", headers=token).status_code == 200
    db.expire_all()
    assert db.query(NodeVersion).count() == 1
    assert db.get(Node, s.orders.id).technology == "Go"


def test_откат_сверх_предела_версий_демо_409_ничего_не_применено(client, db, s, monkeypatch):
    monkeypatch.setattr(settings, "demo_mode", True)
    demo_limits.install()  # в проде — main.lifespan; TestClient без with его не запускает
    monkeypatch.setattr(demo, "MAX_VERSIONS", 2)
    _fix(client, s.orders_url, s.h)
    s.orders.technology = "Go"
    db.commit()

    # «Перед откатом» и «Откат к v1» — две версии сверх одной: предел 2 превышен.
    res = client.post(f"{s.orders_url}/1/restore", headers=s.h)

    assert res.status_code == 409
    assert res.json()["code"] == DEMO_LIMIT_CODE
    db.expire_all()
    assert db.query(NodeVersion).count() == 1
    assert db.get(Node, s.orders.id).technology == "Go"


def test_отказ_воссоздания_409_не_применяет_ничего(client, db, s, monkeypatch):
    """Дубль имени в снимке (restore.RestoreError 409) на данных версии невозможен:
    у схем и фактов ключ имени — внутри объекта-владельца из среза, а имена объектов не
    уникальны. Проверяется перевод отказа и одна транзакция: к воссозданию уже записаны
    версия «Перед откатом» и поля уцелевших строк — после отказа нет ни того, ни
    другого."""
    _fix(client, s.orders_url, s.h)
    s.orders.technology = "Go"
    db.delete(s.doc)  # схему придётся воссоздавать
    db.commit()
    detail = "В снимке повторяется имя (схема логики): «Создать заказ»"

    def refuse(*_args: object, **_kwargs: object) -> None:
        raise restore.RestoreError(detail, 409)

    monkeypatch.setattr(restore, "apply_snapshot", refuse)
    res = client.post(f"{s.orders_url}/1/restore", headers=s.h)

    assert res.status_code == 409
    assert res.json() == {"detail": detail}
    db.expire_all()
    assert db.query(NodeVersion).count() == 1
    assert db.get(Node, s.orders.id).technology == "Go"


def test_откат_версии_проекта(client, db, s):
    root = f"{API}/versions"
    _fix(client, root, s.h, "проект 1.0")
    search_id = uuid.uuid4()
    db.add(Node(id=search_id, project_id=s.p.id, name="Поиск"))
    db.commit()

    assert client.get(f"{root}/1/restore-preview", headers=s.h).json()["deleted_nodes"] == 1
    res = client.post(f"{root}/1/restore", headers=s.h)

    assert res.status_code == 200, res.text
    assert res.json()["created"] == [2, 3] and res.json()["deleted_nodes"] == 1
    db.expire_all()
    assert db.get(Node, search_id) is None
