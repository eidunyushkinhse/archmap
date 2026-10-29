"""Элемент архитектуры в API узла (docs/plan-c4-elements.md, фаза Ф1): выдачи и правки.

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


# ── Правки: POST и PATCH (Р3, Р5, Р6, структурный курсор, CAS) ────────────────


def _tree(db, spec: list[tuple[str, str | None, dict[str, Any]]]) -> tuple[Project, dict[str, uuid.UUID]]:
    """Дерево из списка (имя, имя родителя, поля): родитель объявляется раньше детей."""
    p = make_project(db, "Ярмарка")
    ids: dict[str, uuid.UUID] = {}
    for name, parent, fields in spec:
        node_id = uuid.uuid4()
        db.add(Node(id=node_id, project_id=p.id, name=name,
                    parent_id=ids[parent] if parent else None, **fields))
        ids[name] = node_id
    db.commit()
    return p, ids


def _patch(client: TestClient, db, h: dict[str, str], node_id: uuid.UUID, body: dict[str, Any]):
    db.expunge_all()
    return client.patch(f"{URL}/{node_id}", headers=h, json=body)


def test_post_и_patch_принимают_и_возвращают_элемент(client, db):
    owner = ensure_architect(db)
    p, ids = _tree(db, [("shop", None, {})])
    h = _h(owner, p)

    created = _call(client, db, "POST", URL, headers=h,
                    json={"name": "orders", "parent_id": str(ids["shop"]), "element": "container"})
    assert (created["element"], created["element_effective"]) == ("container", "container")
    orders = created["id"]

    r = _patch(client, db, h, orders, {"element": "system"})
    assert r.status_code == 200, r.text
    assert (r.json()["element"], r.json()["element_effective"]) == ("system", "container")
    # Без ключа — не трогаем: фронт и MCP шлют только то, что правят.
    r = _patch(client, db, h, orders, {"description": "Заказы покупателей"})
    assert r.json()["element"] == "system"
    # Явный null — «не сказано»: очистка разрешена всегда.
    r = _patch(client, db, h, orders, {"element": None})
    assert r.status_code == 200, r.text
    assert r.json()["element"] is None
    # Значение вне словаря — отказ контракта.
    assert _patch(client, db, h, orders, {"element": "component"}).status_code == 422


def test_р3_у_листа_элемент_хранится_как_намерение(client, db):
    owner = ensure_architect(db)
    p, ids = _tree(db, [("shop", None, {}), ("billing", "shop", {})])
    h = _h(owner, p)

    r = _patch(client, db, h, ids["billing"], {"element": "container"})
    assert r.status_code == 200, r.text
    # Лист — контейнер при любом хранимом; намерение срабатывает с первым ребёнком.
    assert (r.json()["element"], r.json()["element_effective"]) == ("container", "container")
    kid = _call(client, db, "POST", URL, headers=h,
                json={"name": "payments-worker", "parent_id": str(ids["billing"])})
    assert kid["element_effective"] == "component"
    parent = _call(client, db, "GET", f"{URL}/{ids['billing']}", headers=h)
    assert parent["element_effective"] == "container"


def test_элемент_задаётся_только_у_сервиса(client, db):
    owner = ensure_architect(db)
    p, ids = _tree(db, [
        ("shop", None, {}),
        ("orders-db", "shop", {"shape": "database"}),
        ("billing", "shop", {}),
    ])
    h = _h(owner, p)
    only = {"detail": "Элемент архитектуры задаётся только у сервиса."}

    r = _patch(client, db, h, ids["orders-db"], {"element": "container"})
    assert (r.status_code, r.json()) == (422, only)
    # Форма — после правки из того же запроса: сервис, ставший базой, — отказ…
    r = _patch(client, db, h, ids["billing"], {"shape": "database", "element": "container"})
    assert (r.status_code, r.json()) == (422, only)
    # …а база, ставшая сервисом, — можно.
    r = _patch(client, db, h, ids["orders-db"], {"shape": "service", "element": "container"})
    assert r.status_code == 200, r.text
    db.expunge_all()
    r = client.post(URL, headers=h, json={"name": "Покупатель", "shape": "person", "element": "system"})
    assert (r.status_code, r.json()) == (422, only)
    # Отказ ничего не записал.
    db.expunge_all()
    billing = db.get(Node, ids["billing"])
    assert (billing.shape, billing.element, billing.version) == ("service", None, 1)


def test_внутри_контейнера_элемент_не_задаётся(client, db):
    owner = ensure_architect(db)
    p, ids = _tree(db, [
        ("shop", None, {}),
        ("orders", "shop", {"element": "container"}),
        ("api", "orders", {}),
        ("jobs", "orders", {}),
        ("nightly", "jobs", {}),
    ])
    h = _h(owner, p)
    inside = (
        "Объект «{name}» лежит внутри контейнера «orders» и считается его компонентом. "
        "Элемент архитектуры задаётся у самого контейнера."
    )

    for name in ("api", "jobs", "nightly"):
        for value in ("system", "container"):
            r = _patch(client, db, h, ids[name], {"element": value})
            assert (r.status_code, r.json()) == (422, {"detail": inside.format(name=name)}), name
    # Создание внутри составного компонента — тот же отказ с именем нового объекта.
    db.expunge_all()
    r = client.post(URL, headers=h,
                    json={"name": "cron", "parent_id": str(ids["jobs"]), "element": "system"})
    assert (r.status_code, r.json()) == (422, {"detail": inside.format(name="cron")})
    # Очистка — всегда можно.
    assert _patch(client, db, h, ids["api"], {"element": None}).status_code == 200
    # Перенос в том же запросе: узел, выносимый из контейнера, уже не компонент.
    r = _patch(client, db, h, ids["jobs"], {"parent_id": str(ids["shop"]), "element": "container"})
    assert r.status_code == 200, r.text
    assert r.json()["element_effective"] == "container"


@pytest.mark.parametrize(
    ("shape", "inner", "outer", "text"),
    [
        (
            "database", "zeta-db", "beta-db",
            "Внутри лежит база данных «zeta-db», она не может входить в состав контейнера. "
            "Вынесите её на уровень выше и повторите.",
        ),
        (
            "broker", "zeta-events", "beta-events",
            "Внутри лежит брокер «zeta-events», он не может входить в состав контейнера. "
            "Вынесите его на уровень выше и повторите.",
        ),
    ],
    ids=["база", "брокер"],
)
def test_р6_база_и_брокер_не_входят_в_контейнер(client, db, shape, inner, outer, text):
    owner = ensure_architect(db)
    # Обход в глубину с детьми по имени: alpha раньше beta-…, а внутри alpha лежит
    # zeta-… — она и названа, хотя beta-… ближе к корню.
    p, ids = _tree(db, [
        ("orders", None, {}),
        (outer, "orders", {"shape": shape}),
        ("alpha", "orders", {}),
        (inner, "alpha", {"shape": shape}),
    ])
    h = _h(owner, p)
    r = _patch(client, db, h, ids["orders"], {"element": "container"})
    assert (r.status_code, r.json()) == (422, {"detail": text})
    # Система с базой или брокером внутри — норма, как и до эпика.
    assert _patch(client, db, h, ids["orders"], {"element": "system"}).status_code == 200


def test_р5_контейнер_не_входит_в_контейнер(client, db):
    owner = ensure_architect(db)
    p, ids = _tree(db, [
        ("shop", None, {}),
        ("billing", "shop", {}),
        ("orders", "shop", {"element": "container"}),
        ("api", "orders", {}),
    ])
    h = _h(owner, p)
    r = _patch(client, db, h, ids["shop"], {"element": "container"})
    assert (r.status_code, r.json()) == (422, {"detail": (
        "Внутри «shop» уже есть контейнер «orders». Контейнер не может входить в состав "
        "другого контейнера. Сначала измените элемент архитектуры у «orders»."
    )})
    assert _patch(client, db, h, ids["shop"], {"element": "system"}).status_code == 200


def test_пользователь_внутри_контейнера_не_отказ(client, db):
    """«Пользователь» внутри контейнера — замечание панели (AL25), а не отказ правки."""
    owner = ensure_architect(db)
    p, ids = _tree(db, [
        ("orders", None, {}),
        ("api", "orders", {}),
        ("Покупатель", "orders", {"shape": "person"}),
    ])
    r = _patch(client, db, _h(owner, p), ids["orders"], {"element": "container"})
    assert r.status_code == 200, r.text


def test_прежнее_значение_повторно_не_проверяется(client, db):
    """Отказы — на СМЕНУ значения, как у формы (reparent.validate_shape_change): полный
    набор полей, который шлёт Undo правки, не падает от состояния, пришедшего иначе
    (ввоз, перенос) и к правке не относящегося."""
    owner = ensure_architect(db)
    p, ids = _tree(db, [
        ("orders", None, {"element": "container"}),
        ("orders-db", "orders", {"shape": "database"}),
    ])
    r = _patch(client, db, _h(owner, p), ids["orders"], {"name": "orders-v2", "element": "container"})
    assert r.status_code == 200, r.text


def test_смена_элемента_двигает_схему_а_не_мету(client, db):
    owner = ensure_architect(db)
    p, ids = _tree(db, [("shop", None, {}), ("orders", "shop", {}), ("api", "orders", {})])
    h = _h(owner, p)

    def revs() -> tuple[int, int]:
        db.expunge_all()
        project = db.get(Project, p.id)
        return project.graph_rev, project.meta_rev

    g0, m0 = revs()
    assert _patch(client, db, h, ids["orders"], {"element": "container"}).status_code == 200
    # Элемент меняет вид всего поддерева: соседние сессии перерисовывают схему.
    assert revs() == (g0 + 1, m0)
    # То же значение повторно — не изменение: курсоры стоят.
    assert _patch(client, db, h, ids["orders"], {"element": "container"}).status_code == 200
    assert revs() == (g0 + 1, m0)
    assert _patch(client, db, h, ids["orders"], {"element": None}).status_code == 200
    assert revs() == (g0 + 2, m0)


def test_cas_общим_путём(client, db):
    owner = ensure_architect(db)
    p, ids = _tree(db, [("orders", None, {})])
    h = _h(owner, p)
    r = _patch(client, db, h, ids["orders"], {"element": "container", "base_version": 1})
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 2
    # Правка от устаревшей версии — 409, значение не меняется.
    r = _patch(client, db, h, ids["orders"], {"element": None, "base_version": 1})
    assert r.status_code == 409
    db.expunge_all()
    assert db.get(Node, ids["orders"]).element == "container"
