"""Удаление пачкой с версией перед ним (app/deletions.py, POST /api/v1/deletions).

Главный сторож — возврат: агент удалил пачку токеном, человек откатил версию «Перед
удалением агентом» и получил удалённое обратно с теми же id. Остальное — срез версии
(ближайший общий родитель), пункты, уходящие вместе с объектом, dry_run, «изменений не
было» без новой версии, принадлежность проекту и права.
"""

import types
import uuid

import pytest
from conftest import make_project, typed
from fastapi.testclient import TestClient

from app import deletions, personal_tokens, versions
from app.database import get_db
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
from app.versions_restore import restore_version

URL = "/api/v1/deletions"
DOC = "flowchart TD\n  A[POST /orders] --> B[201]"


@pytest.fixture()
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _user(db, username: str) -> User:
    u = User(id=uuid.uuid4(), username=username, hashed_password="x", role="architect")
    db.add(u)
    db.flush()
    return u


@pytest.fixture()
def s(db) -> types.SimpleNamespace:
    """«Ярмарка» (система): «Заказы» с вложенным «Кэш заказов» (схема, параметр) и
    «Оплаты». Снаружи на верхнем уровне — «Банк». Связи «Заказы → Оплаты», «Кэш → Банк».
    Процесс «Оформление» с участником «Кэш» и шагом по связи «Кэш → Банк» со схемой."""
    s = types.SimpleNamespace()
    s.owner = _user(db, "owner")
    s.p = make_project(db, "Ярмарка", owner=s.owner)
    pid = s.p.id
    s.shop = Node(id=uuid.uuid4(), project_id=pid, name="Ярмарка")
    s.bank = Node(id=uuid.uuid4(), project_id=pid, name="Банк", is_external=True)
    db.add_all([s.shop, s.bank])
    db.flush()
    s.orders = Node(id=uuid.uuid4(), project_id=pid, name="Заказы", parent_id=s.shop.id)
    s.pay = Node(id=uuid.uuid4(), project_id=pid, name="Оплаты", parent_id=s.shop.id)
    db.add_all([s.orders, s.pay])
    db.flush()
    s.cache = Node(id=uuid.uuid4(), project_id=pid, name="Кэш заказов", parent_id=s.orders.id)
    db.add(s.cache)
    db.flush()
    s.e_pay = Edge(project_id=pid, source_id=s.orders.id, target_id=s.pay.id, label="оплатить")
    s.e_bank = Edge(project_id=pid, source_id=s.cache.id, target_id=s.bank.id, label="статус")
    s.doc = NodeDoc(node_id=s.cache.id, name="Прогрев", content=DOC)
    s.param = ConfigParam(node_id=s.cache.id, name="CACHE_TTL", default_value="60")
    db.add_all([s.e_pay, s.e_bank, s.doc, s.param])
    db.flush()
    s.proc = BusinessProcess(project_id=pid, name="Оформление")
    db.add(s.proc)
    db.flush()
    s.p_cache = ProcessParticipant(process_id=s.proc.id, node_id=s.cache.id, name="Кэш", order=0)
    s.p_bank = ProcessParticipant(process_id=s.proc.id, node_id=s.bank.id, name="Банк", order=1)
    db.add_all([s.p_cache, s.p_bank])
    db.flush()
    s.step = ProcessMessage(
        process_id=s.proc.id, order=0, edge_id=s.e_bank.id, leg="forward",
        from_participant_id=s.p_cache.id, to_participant_id=s.p_bank.id, caption="статус",
        doc_id=s.doc.id,
    )
    db.add(s.step)
    typed(db, pid)
    db.commit()
    s.secret = personal_tokens.issue(db, s.owner, "Агент", False, 90).secret
    db.commit()
    return s


def _h(secret: str, project) -> dict[str, str]:
    return {"Authorization": f"Bearer {secret}", "X-Project-Id": str(project.id)}


def _post(client, s, items, **body):
    payload = {"items": [{"kind": k, "id": str(i)} for k, i in items], **body}
    return client.post(URL, headers=_h(s.secret, s.p), json=payload)


def _versions(db, project) -> list[NodeVersion]:
    return db.query(NodeVersion).filter(NodeVersion.project_id == project.id).all()


def test_токен_удаляет_пачкой_с_версией_у_общего_родителя(client, db, s):
    ids = {"cache": s.cache.id, "e_pay": s.e_pay.id, "shop": s.shop.id}
    r = _post(client, s, [("node", s.cache.id), ("edge", s.e_pay.id)], reason="дубль прогона")
    assert r.status_code == 200, r.text
    out = r.json()
    # «Кэш» лежит в «Заказах», связь соединяет «Заказы» и «Оплаты»: общий родитель — «Ярмарка».
    assert out["version"]["node_id"] == str(ids["shop"])
    assert out["version"]["label"] == "Ярмарка"
    assert out["version"]["created"] is True
    totals = out["totals"]
    assert (totals["nodes"], totals["edges"], totals["docs"], totals["facts"]) == (1, 2, 1, 1)
    # участник «Кэш», шаг по связи «Кэш → Банк» и шаг со схемой «Прогрев»
    assert totals["process_links"] == 3
    labels = [i["label"] for i in out["items"]]
    assert labels == ["Ярмарка / Заказы / Кэш заказов", "Ярмарка / Заказы → Ярмарка / Оплаты"]

    db.expire_all()
    assert db.get(Node, ids["cache"]) is None and db.get(Edge, ids["e_pay"]) is None
    [row] = _versions(db, s.p)
    assert (row.node_id, row.kind, row.number) == (ids["shop"], "pre_delete", out["version"]["number"])
    assert row.comment == (
        "Перед удалением агентом: «Кэш заказов», «Заказы → Оплаты». Причина: дубль прогона"
    )


def test_откат_к_версии_возвращает_удалённое_с_теми_же_id(client, db, s):
    ids = {"cache": s.cache.id, "e_bank": s.e_bank.id, "doc": s.doc.id, "param": s.param.id}
    r = _post(client, s, [("node", s.cache.id)])
    assert r.status_code == 200, r.text
    # «Кэш» лежит в «Заказах»: версия у них, а не выше, откат заденет меньше соседних правок.
    assert r.json()["version"]["node_id"] == str(s.orders.id)
    number = r.json()["version"]["number"]
    db.expire_all()
    orders = db.get(Node, s.orders.id)
    version = versions.get_version(db, s.p, orders, number)
    assert version is not None
    restore_version(db, s.p, s.owner, orders, version)
    db.commit()
    db.expire_all()
    cache = db.get(Node, ids["cache"])
    assert cache is not None and cache.parent_id == s.orders.id
    assert db.get(Edge, ids["e_bank"]) is not None
    assert db.get(NodeDoc, ids["doc"]).content == DOC
    assert db.get(ConfigParam, ids["param"]).default_value == "60"
    # Привязки процессов откат не возвращает: ответ удаления о них предупредил.
    assert db.get(ProcessParticipant, s.p_cache.id).node_id is None


def test_dry_run_только_считает(client, db, s):
    r = _post(client, s, [("node", s.orders.id)], dry_run=True)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["dry_run"] is True
    assert out["version"] == {
        "node_id": str(s.shop.id), "label": "Ярмарка", "number": None, "created": False,
    }
    # «Заказы» с «Кэшем»; связи «Заказы → Оплаты» и «Кэш → Банк»
    assert (out["totals"]["nodes"], out["totals"]["edges"]) == (2, 2)
    db.expire_all()
    assert db.get(Node, s.orders.id) is not None
    assert _versions(db, s.p) == []


def test_пункты_внутри_удаляемого_объекта_уходят_вместе_с_ним(client, db, s):
    orders, cache_id = str(s.orders.id), s.cache.id
    items = [
        ("node", s.cache.id), ("doc", s.doc.id), ("edge", s.e_bank.id), ("node", s.orders.id),
    ]
    r = _post(client, s, items)
    assert r.status_code == 200, r.text
    out = r.json()
    assert [i["covered_by"] for i in out["items"]] == [orders, orders, orders, None]
    # Версия у родителя «Заказов», а не у «Заказов»: их история уходит вместе с ними.
    assert out["version"]["node_id"] == str(s.shop.id)
    assert _versions(db, s.p)[0].comment == "Перед удалением агентом: «Заказы»"
    db.expire_all()
    assert db.get(Node, uuid.UUID(orders)) is None and db.get(Node, cache_id) is None


def test_без_изменений_с_версии_новую_не_сохраняют(client, db, s):
    manual = versions.create_version(db, s.p, s.owner, s.shop, "релиз 1.4")
    db.commit()
    r = _post(client, s, [("edge", s.e_pay.id)])
    assert r.status_code == 200, r.text
    assert r.json()["version"] == {
        "node_id": str(s.shop.id), "label": "Ярмарка", "number": manual.number, "created": False,
    }
    assert len(_versions(db, s.p)) == 1


def test_объект_верхнего_уровня_версия_всего_проекта(client, db, s):
    r = _post(client, s, [("node", s.bank.id)])
    assert r.status_code == 200, r.text
    assert r.json()["version"]["node_id"] is None and r.json()["version"]["label"] is None
    [row] = _versions(db, s.p)
    assert row.node_id is None and row.kind == "pre_delete"


def test_чужой_id_отказ_всей_пачки(client, db, s):
    other = make_project(db, "Плёнка", owner=s.owner)
    alien = Node(project_id=other.id, name="Чужой")
    db.add(alien)
    db.commit()
    r = _post(client, s, [("edge", s.e_pay.id), ("node", alien.id)])
    assert r.status_code == 404
    assert r.json()["detail"] == f"Объекта {alien.id} в проекте нет"
    r = _post(client, s, [("doc", uuid.uuid4())])
    assert r.status_code == 404 and r.json()["detail"].startswith("Схемы логики")
    db.expire_all()
    assert db.get(Edge, s.e_pay.id) is not None and db.get(Node, alien.id) is not None
    assert _versions(db, s.p) == []


def test_пустая_пачка_и_неизвестный_вид_422(client, s):
    assert client.post(URL, headers=_h(s.secret, s.p), json={"items": []}).status_code == 422
    bad = {"items": [{"kind": "project", "id": str(s.p.id)}]}
    assert client.post(URL, headers=_h(s.secret, s.p), json=bad).status_code == 422


def test_токен_только_чтение_и_читатель_не_удаляют(client, db, s):
    ro = personal_tokens.issue(db, s.owner, "Читалка", True, 90).secret
    reader = _user(db, "reader")
    db.add(ProjectMember(project_id=s.p.id, user_id=reader.id, role="reader"))
    db.commit()
    reader_secret = personal_tokens.issue(db, reader, "Агент читателя", False, 90).secret
    db.commit()
    body = {"items": [{"kind": "edge", "id": str(s.e_pay.id)}]}
    r = client.post(URL, headers=_h(ro, s.p), json=body)
    assert r.status_code == 403 and r.json()["detail"] == personal_tokens.READ_ONLY_DETAIL
    assert client.post(URL, headers=_h(reader_secret, s.p), json=body).status_code == 403
    db.expire_all()
    assert db.get(Edge, s.e_pay.id) is not None


def test_метод_DELETE_токеном_закрыт_и_называет_путь_пачкой(client, s):
    r = client.delete(f"/api/v1/edges/{s.e_pay.id}", headers=_h(s.secret, s.p))
    assert r.status_code == 403
    assert "POST /api/v1/deletions" in r.json()["detail"]


def test_комментарий_перечисляет_три_имени_и_обрезается():
    def target(name: str):
        return types.SimpleNamespace(short=name)

    five = [target(n) for n in ("А", "Б", "В", "Г", "Д")]
    assert deletions._comment(five, None) == "Перед удалением агентом: «А», «Б», «В» и ещё 2"
    long = deletions._comment(five[:1], "я" * 600)
    assert len(long) == deletions.COMMENT_MAX and long.endswith("…")


def test_общий_предок():
    a, b, c, d = (uuid.uuid4() for _ in range(4))
    nodes = {
        a: Node(id=a, name="a", parent_id=None),
        b: Node(id=b, name="b", parent_id=a),
        c: Node(id=c, name="c", parent_id=b),
        d: Node(id=d, name="d", parent_id=a),
    }
    assert deletions.common_ancestor(nodes, [c, d]) == a
    assert deletions.common_ancestor(nodes, [c, b]) == b
    assert deletions.common_ancestor(nodes, [c, None]) is None
    # цикл в данных не вешает обход
    nodes[a].parent_id = c
    assert deletions.common_ancestor(nodes, [c]) is not None
