"""Процессы руками агента (замечание владельца 2026-11-21, пункт 2): прогноз шагов в превью
ввоза, уточнения сопоставления, замена содержимого процесса диаграммой с версией перед ней
и удаление процесса пачкой.

Превью и применение считают одним plan_import, поэтому прогноз превью обязан совпасть с
итогом применения: это и сторожит первый тест.
"""

import types
import uuid

import pytest
from conftest import make_project, typed
from fastapi.testclient import TestClient

from app import personal_tokens, versions
from app.database import get_db
from app.main import app
from app.models.business_process import BusinessProcess
from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.node_version import NodeVersion
from app.models.process_message import ProcessMessage
from app.models.process_participant import ProcessParticipant
from app.models.user import User
from app.process_import import apply_import, build_preview

PROCESSES = "/api/v1/processes"
DIAGRAM = """sequenceDiagram
    participant Витрина
    participant Заказы
    participant Оплаты
    participant Касса
    Витрина->>Заказы: оформить
    %% archmap-doc: Ярмарка / Заказы / Создать заказ
    Заказы->>Оплаты: оплатить
    Оплаты-->>Заказы: оплачено
    Заказы->>Заказы: пересчитать
    Заказы->>Касса: чек
    Оплаты->>Витрина: уведомить
    %% archmap-doc: Ярмарка / Заказы / Нет такой
    Заказы-->>Витрина: принят
"""


@pytest.fixture()
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


@pytest.fixture()
def s(db) -> types.SimpleNamespace:
    """«Ярмарка»: «Витрина» → «Заказы» (синхронно), «Заказы» → «Оплаты» дважды (REST и
    Kafka-событие) и «Заказы» → «Чеки» синхронно. Узла «Касса» нет, «Чеки» — под другим
    именем. У «Заказов» схема логики «Создать заказ»."""
    s = types.SimpleNamespace()
    s.owner = User(id=uuid.uuid4(), username="owner", hashed_password="x", role="architect")
    db.add(s.owner)
    db.flush()
    s.p = make_project(db, "Ярмарка", owner=s.owner)
    pid = s.p.id
    s.shop = Node(id=uuid.uuid4(), project_id=pid, name="Ярмарка")
    db.add(s.shop)
    db.flush()
    s.front, s.orders, s.pay, s.checks = (
        Node(id=uuid.uuid4(), project_id=pid, name=n, parent_id=s.shop.id)
        for n in ("Витрина", "Заказы", "Оплаты", "Чеки")
    )
    db.add_all([s.front, s.orders, s.pay, s.checks])
    db.flush()
    db.add_all([
        Edge(project_id=pid, source_id=s.front.id, target_id=s.orders.id, label="оформить"),
        Edge(project_id=pid, source_id=s.orders.id, target_id=s.pay.id, label="REST"),
        Edge(project_id=pid, source_id=s.orders.id, target_id=s.pay.id, label="событие",
             is_synchronous=False),
        Edge(project_id=pid, source_id=s.orders.id, target_id=s.checks.id, label="чек"),
    ])
    s.doc = NodeDoc(node_id=s.orders.id, name="Создать заказ", content="flowchart TD\n  A --> B")
    db.add(s.doc)
    typed(db, pid)
    db.commit()
    s.secret = personal_tokens.issue(db, s.owner, "Агент", False, 90).secret
    db.commit()
    return s


def _h(s) -> dict[str, str]:
    return {"Authorization": f"Bearer {s.secret}", "X-Project-Id": str(s.p.id)}


def test_превью_предсказывает_шаги_как_применение(db, s):
    out = build_preview(db, s.p.id, DIAGRAM, "Заказ")
    statuses = [(st.from_name, st.to_name, st.status) for st in out.steps]
    assert statuses == [
        ("Витрина", "Заказы", "attached"),
        # между «Заказами» и «Оплатами» две связи вперёд: выбирать за человека нельзя
        ("Заказы", "Оплаты", "ambiguous"),
        # ответ есть только у синхронной REST, событие ответного плеча не имеет
        ("Оплаты", "Заказы", "attached"),
        ("Заказы", "Заказы", "self"),
        # «Кассы» в схеме нет: участник без объекта
        ("Заказы", "Касса", "unbound"),
        ("Оплаты", "Витрина", "no_channel"),
        ("Заказы", "Витрина", "attached"),
    ]
    assert [st.doc_status for st in out.steps][1] == "linked"
    assert [st.doc_status for st in out.steps][-1] == "unresolved"
    assert (out.attached, out.dangling, out.self_messages) == (3, 3, 1)

    mapping = {p.alias: p.node_id for p in out.participants}
    _, res = apply_import(db, s.p.id, DIAGRAM, "Заказ", mapping)
    assert (res.attached, res.dangling, res.self_messages) == (3, 3, 1)
    assert (res.doc_linked, res.doc_unresolved) == (1, 1)


def test_уточнение_сопоставления_меняет_прогноз(db, s):
    out = build_preview(db, s.p.id, DIAGRAM, None, {"Касса": s.checks.id})
    касса = next(p for p in out.participants if p.alias == "Касса")
    # кандидатов по имени нет, автосопоставление пустое; прогноз считается с уточнением
    assert касса.node_id is None and касса.candidates == []
    step = next(st for st in out.steps if st.to_name == "Чеки")
    assert step.status == "attached"
    assert out.dangling == 2


def test_замена_процесса_с_версией_перед_ней(client, db, s):
    created = client.post(
        f"{PROCESSES}/import", headers=_h(s),
        json={"text": DIAGRAM, "name": "Заказ", "mapping": {"Витрина": str(s.front.id)}},
    )
    assert created.status_code == 201, created.text
    pid = created.json()["process_id"]

    новый = "sequenceDiagram\n    Витрина->>Заказы: оформить\n    Заказы-->>Витрина: принят\n"
    mapping = {"Витрина": str(s.front.id), "Заказы": str(s.orders.id)}
    r = client.post(
        f"{PROCESSES}/{pid}/import", headers=_h(s),
        json={"text": новый, "name": "Оформление заказа", "mapping": mapping},
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["process_id"] == pid
    assert (out["participants"], out["messages"], out["attached"]) == (2, 2, 2)
    assert out["version_created"] is True

    db.expire_all()
    proc = db.get(BusinessProcess, uuid.UUID(pid))
    assert proc.name == "Оформление заказа"
    assert db.query(ProcessMessage).filter(ProcessMessage.process_id == proc.id).count() == 2
    assert db.query(ProcessParticipant).filter(ProcessParticipant.process_id == proc.id).count() == 2
    [row] = db.query(NodeVersion).filter(NodeVersion.project_id == s.p.id).all()
    assert (row.node_id, row.kind, row.number) == (None, "pre_replace", out["version_number"])
    assert row.comment == "Перед заменой процесса «Заказ» из диаграммы"
    # прежний текст процесса лежит в версии: его можно ввезти заново
    old = versions.process_text(versions.snapshot_of(row), proc.id)
    assert old is not None and "Касса" in old.text


def test_замена_без_изменений_с_версии_новую_не_сохраняет(client, db, s):
    _, res = apply_import(db, s.p.id, DIAGRAM, "Заказ", {})
    # как в API: ввоз и фиксация версии — разные запросы, у каждого своя сессия
    db.commit()
    db.expire_all()
    manual = versions.create_version(db, s.p, s.owner, None, "релиз 1.4")
    db.commit()
    r = client.post(
        f"{PROCESSES}/{res.process_id}/import", headers=_h(s),
        json={"text": "sequenceDiagram\n    А->>Б: раз\n", "mapping": {}},
    )
    assert r.status_code == 200, r.text
    assert (r.json()["version_number"], r.json()["version_created"]) == (manual.number, False)


def test_замена_чужого_процесса_404(client, db, s):
    other = make_project(db, "Плёнка", owner=s.owner)
    alien, _ = apply_import(db, other.id, DIAGRAM, "Чужой", {})
    db.commit()
    r = client.post(
        f"{PROCESSES}/{alien.id}/import", headers=_h(s), json={"text": DIAGRAM, "mapping": {}}
    )
    assert r.status_code == 404


def test_удаление_процесса_пачкой_с_версией_проекта(client, db, s):
    proc, _ = apply_import(db, s.p.id, DIAGRAM, "Заказ", {})
    db.commit()
    proc_id = proc.id
    r = client.post(
        "/api/v1/deletions", headers=_h(s),
        json={"items": [{"kind": "process", "id": str(proc_id)}], "reason": "черновик"},
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["items"][0]["label"] == "«Заказ»"
    assert out["totals"]["processes"] == 1 and out["totals"]["nodes"] == 0
    assert out["version"]["node_id"] is None and out["version"]["created"] is True
    db.expire_all()
    assert db.get(BusinessProcess, proc_id) is None
    [row] = db.query(NodeVersion).filter(NodeVersion.project_id == s.p.id).all()
    assert row.comment == "Перед удалением агентом: «Заказ». Причина: черновик"
    assert versions.process_text(versions.snapshot_of(row), proc_id) is not None


# Находка 2 (2026-11-24): после «Заменить из Mermaid» строка обещала «Прежний вариант
# сохранён в версии N», но взять его человеку было нечем: элемент-процесс версии показывал
# только таблицы шагов. Теперь «было» и «стало» несут текст диаграммы этого варианта тем же
# преобразованием, что экспорт процесса, из состояния на своей стороне.
def _steps(client, s, pid: str) -> dict[str, list]:
    """Процесс по шагам из выдачи процесса: участники (имя, объект, порядок), шаги (кто,
    кому, подпись, вид, связь, плечо, схема) и фрагменты; id участников сменились при
    замене, поэтому концы шагов — именами."""
    d = client.get(f"{PROCESSES}/{pid}", headers=_h(s)).json()
    names = {p["id"]: p["name"] for p in d["participants"]}
    return {
        "participants": [(p["name"], p["node_id"], p["order"]) for p in d["participants"]],
        "steps": [
            (m["order"], names[m["from_participant_id"]], names[m["to_participant_id"]], m["caption"],
             m["kind"], m["edge_id"], m["leg"], m["doc_id"])
            for m in sorted(d["messages"], key=lambda m: m["order"])
        ],
        "fragments": [
            (f["kind"], f["from_order"], f["to_order"], f["guard"], [(b["start_order"], b["guard"]) for b in f["branches"]])
            for f in sorted(d["fragments"], key=lambda f: (f["from_order"], f["to_order"]))
        ],
    }


def _auto(client, s, text: str) -> dict[str, str | None]:
    """Сопоставление участников, которое окно ввоза предлагает само (однозначные имена)."""
    prev = client.post(f"{PROCESSES}/import/preview", headers=_h(s), json={"text": text}).json()
    return {p["alias"]: p["node_id"] for p in prev["participants"]}


def _item(client, s, number: int, pid: str, base: str = "live") -> dict:
    r = client.get(f"/api/v1/versions/{number}/diff/process:{pid}", headers=_h(s), params={"base": base})
    assert r.status_code == 200, r.text
    return r.json()


def test_версия_отдаёт_текст_диаграммы_прежнего_варианта(client, db, s):
    created = client.post(f"{PROCESSES}/import", headers=_h(s), json={"text": DIAGRAM, "name": "Заказ"})
    pid = created.json()["process_id"]
    old_text = client.get(f"{PROCESSES}/{pid}/export", headers=_h(s)).json()["content"]
    новый = "sequenceDiagram\n    Витрина->>Заказы: оформить\n    Заказы-->>Витрина: принят\n"
    r = client.post(f"{PROCESSES}/{pid}/import", headers=_h(s), json={"text": новый, "mapping": {}})
    number = r.json()["version_number"]
    new_text = client.get(f"{PROCESSES}/{pid}/export", headers=_h(s)).json()["content"]

    detail = _item(client, s, number, pid)
    # «Было в vN» — прежний вариант тем же текстом, что выгрузил бы экспорт до замены;
    # «Стало сейчас» — текущий. Таблица шагов на месте, у «изменений» текста нет.
    assert detail["before"]["mermaid"] == old_text
    assert detail["after"]["mermaid"] == new_text
    assert detail["before"]["columns"] is not None and detail["before"]["rows"]
    assert detail["changes"]["mermaid"] is None
    # Сравнение «с начала» у первой версии: «было» пусто, «стало» — вариант версии.
    first = _item(client, s, number, pid, base="prev")
    assert first["before"]["mermaid"] is None and first["after"]["mermaid"] == old_text
    # Прочие элементы текста диаграммы не несут.
    doc_items = [i["item_id"] for i in client.get(
        f"/api/v1/versions/{number}/diff", headers=_h(s), params={"base": "prev"}).json()["items"]
        if not i["item_id"].startswith("process:")]
    other = client.get(f"/api/v1/versions/{number}/diff/{doc_items[0]}", headers=_h(s),
                       params={"base": "prev"}).json()
    assert all(other[side].get("mermaid") is None for side in ("changes", "before", "after"))


def test_текст_из_версии_восстанавливает_процесс(client, db, s):
    # В диаграмме есть всё, что текст обязан пронести: шаг на связи и повисший, ответ,
    # внутренний шаг, участник без объекта («Касса»), привязка шага к схеме логики.
    # Сопоставление участников — как предлагает окно ввоза.
    created = client.post(f"{PROCESSES}/import", headers=_h(s),
                          json={"text": DIAGRAM, "name": "Заказ", "mapping": _auto(client, s, DIAGRAM)})
    pid = created.json()["process_id"]
    original = _steps(client, s, pid)
    assert any(st[7] is not None for st in original["steps"])
    assert ("Касса", None, 3) in original["participants"]
    новый = "sequenceDiagram\n    Витрина->>Заказы: оформить\n    Заказы-->>Витрина: принят\n"
    r = client.post(f"{PROCESSES}/{pid}/import", headers=_h(s), json={"text": новый, "mapping": {}})
    assert _steps(client, s, pid) != original
    number = r.json()["version_number"]

    # Человек берёт текст с вкладки «Было в vN» и вставляет его в «Заменить процесс»;
    # сопоставление участников — как предлагает окно ввоза.
    text = _item(client, s, number, pid)["before"]["mermaid"]
    back = client.post(f"{PROCESSES}/{pid}/import", headers=_h(s),
                       json={"text": text, "mapping": _auto(client, s, text)})
    assert back.status_code == 200, back.text
    assert _steps(client, s, pid) == original
