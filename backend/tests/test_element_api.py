"""Элемент архитектуры в API узла (docs/plan-c4-elements.md, фаза Ф1).

Действующий элемент (element_effective) считает app/element.py, а проставляет перед
отдачей app/element_marks — в КАЖДОЙ выдаче узла: выдачи роутера узлов, граф уровня
(локалы, гости и предки гостей), контекст-схема, граф развёртывания. Атрибут модели по
умолчанию None (камень 2): выдача, забывшая его проставить, отдаст null, и сторож ниже
это увидит — на дереве, где null законен только у «Пользователя».
"""

import uuid
from collections.abc import Iterable
from typing import Any

import pytest
from conftest import ensure_architect, make_project
from fastapi.testclient import TestClient

from app.auth import create_access_token
from app.database import get_db
from app.main import app
from app.models.edge import Edge
from app.models.node import Node
from app.models.project import Project
from app.models.user import User

URL = "/api/v1/nodes"


@pytest.fixture()
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _h(user: User, project: Project) -> dict[str, str]:
    token = create_access_token({"sub": user.username, "role": user.role})
    return {"Authorization": f"Bearer {token}", "X-Project-Id": str(project.id)}


def _shop(db, orders_element: str | None) -> tuple[Project, dict[str, uuid.UUID]]:
    """Система shop: контейнер orders (хранимое — orders_element) с листом api и
    составным jobs (внутри nightly); рядом лист billing и база orders-db; у корня —
    «Пользователь». Связи сквозные, чтобы на графах уровня были гости с предками.
    Возвращает id узлов по имени."""
    p = make_project(db, "Ярмарка")

    def node(name: str, parent: Node | None = None, **fields: Any) -> Node:
        n = Node(
            id=uuid.uuid4(),
            project_id=p.id,
            name=name,
            parent_id=parent.id if parent else None,
            **fields,
        )
        db.add(n)
        return n

    shop = node("shop")
    orders = node("orders", shop, element=orders_element)
    api = node("api", orders)
    jobs = node("jobs", orders)
    nightly = node("nightly", jobs)
    billing = node("billing", shop)
    orders_db = node("orders-db", shop, shape="database")
    buyer = node("Покупатель", shape="person")
    for src, dst in ((buyer, billing), (billing, api), (api, orders_db), (nightly, billing)):
        db.add(Edge(id=uuid.uuid4(), project_id=p.id, source_id=src.id, target_id=dst.id))
    db.commit()
    ids = {n.name: n.id for n in (shop, orders, api, jobs, nightly, billing, orders_db, buyer)}
    return p, ids


def _call(client: TestClient, db, method: str, path: str, **kw: Any) -> Any:
    """Запрос через HTTP на ЧИСТОЙ сессии. Тестовый клиент делит с тестом одну сессию, и
    вычисляемые атрибуты, проставленные прошлой выдачей, остались бы на экземплярах
    карты идентичности — выдача, забывшая элемент, отдала бы чужое значение, и сторож
    промолчал бы. В проде у каждого запроса своя сессия; здесь её заменяет expunge_all."""
    db.expunge_all()
    r = client.request(method, path, **kw)
    assert r.status_code in (200, 201), (method, path, r.text)
    return r.json()


class _Seen:
    """Сверяет element_effective каждого узла выдачи с ожиданием по имени и помнит,
    кого видел и где: сторож обязан пройти по всем узлам дерева."""

    def __init__(self, expected: dict[str, str | None]) -> None:
        self.expected = expected
        self.names: set[str] = set()

    def check(self, items: Iterable[dict[str, Any]], where: str) -> None:
        for item in items:
            name = item["name"]
            assert "element_effective" in item, f"{where}: {name} без element_effective"
            assert item["element_effective"] == self.expected[name], (where, name)
            self.names.add(name)

    def graph(self, data: dict[str, Any], where: str) -> None:
        self.check(data["nodes"], f"{where}: локалы")
        self.check(data["endpoints"], f"{where}: гости")
        for ghost in data["endpoints"]:
            self.check(ghost["ancestors"], f"{where}: предки {ghost['name']}")


# Действующий элемент при orders = container: всё внутри orders — компоненты (и
# составной jobs, и его ребёнок), лист вне контейнера — сам контейнер, база тоже.
WITH_CONTAINER: dict[str, str | None] = {
    "shop": "system",
    "orders": "container",
    "api": "component",
    "jobs": "component",
    "nightly": "component",
    "cron": "component",
    "billing": "container",
    "orders-db": "container",
    "Покупатель": None,
}
# Сегодняшняя картина (element = null у всех): узел с детьми — система, лист — контейнер.
LEGACY: dict[str, str | None] = {
    "shop": "system",
    "orders": "system",
    "api": "container",
    "jobs": "system",
    "nightly": "container",
    "cron": "container",
    "billing": "container",
    "orders-db": "container",
    "Покупатель": None,
}


@pytest.mark.parametrize(
    ("orders_element", "expected"),
    [("container", WITH_CONTAINER), (None, LEGACY)],
    ids=["контейнер", "всё-null"],
)
def test_действующий_элемент_во_всех_выдачах(client, db, orders_element, expected):
    owner = ensure_architect(db)
    p, n = _shop(db, orders_element)
    h = _h(owner, p)
    seen = _Seen(expected)

    def get(path: str, **params: Any) -> Any:
        return _call(client, db, "GET", path, headers=h, params=params)

    # Создание: новый узел внутри составного компонента — тоже компонент.
    body = {"name": "cron", "parent_id": str(n["jobs"])}
    seen.check([_call(client, db, "POST", URL, headers=h, json=body)], "POST /nodes")
    body = {"description": "REST заказов"}
    seen.check(
        [_call(client, db, "PATCH", f"{URL}/{n['api']}", headers=h, json=body)],
        "PATCH /nodes/{id}",
    )

    seen.check(get(URL), "GET /nodes")
    seen.check(get(URL, parent_id=str(n["shop"])), "GET /nodes?parent_id")
    seen.check(get(f"{URL}/search", q="o"), "GET /nodes/search")
    every = get(f"{URL}/all")
    seen.check(every, "GET /nodes/all")
    for name, node_id in n.items():
        seen.check([get(f"{URL}/{node_id}")], f"GET /nodes/{{id}} {name}")
    for name in ("shop", "orders", "jobs"):
        seen.check(get(f"{URL}/{n[name]}/children"), f"children {name}")
    seen.check(get(f"{URL}/{n['shop']}/descendants"), "descendants shop")

    seen.graph(get(f"{URL}/graph"), "граф корня")
    for name in ("shop", "orders", "jobs"):
        seen.graph(get(f"{URL}/{n[name]}/graph"), f"граф уровня {name}")
    for name in ("api", "nightly", "billing"):
        seen.graph(get(f"{URL}/{n[name]}/context-graph"), f"контекст {name}")
    seen.check(get("/api/v1/deployment/graph")["nodes"], "развёртывание проекта")
    seen.check(
        get("/api/v1/deployment/graph", level=str(n["shop"]))["nodes"],
        "развёртывание уровня shop",
    )

    assert seen.names == set(expected)
    # Хранимое значение отдаётся как есть: null — «не сказано».
    stored = {item["name"]: item["element"] for item in every}
    assert stored == {name: (orders_element if name == "orders" else None) for name in expected}


def test_гости_и_предки_на_графе_уровня(client, db):
    """Цепочка предков гостя несёт элементы по порядку «корень → родитель»: по ней фронт
    строит вложенные рамки гостей."""
    owner = ensure_architect(db)
    p, _ = _shop(db, "container")
    data = _call(client, db, "GET", f"{URL}/graph", headers=_h(owner, p))
    ghosts = {g["name"]: g for g in data["endpoints"]}
    nightly = ghosts["nightly"]
    assert nightly["element_effective"] == "component"
    assert [(a["name"], a["element_effective"]) for a in nightly["ancestors"]] == [
        ("shop", "system"),
        ("orders", "container"),
        ("jobs", "component"),
    ]
