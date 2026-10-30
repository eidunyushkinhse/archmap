"""Смена элемента и перенос узла с последствиями для размещения (Р18 эпика
docs/plan-c4-elements.md, app/element_change.py).

Сторожим пять видов переноса площадок (система → контейнер объединением, контейнер →
система раздачей единицам — и листьям бывшего составного компонента, вход в контейнер,
выход из него, первый вложенный объект у листа с площадками — при создании и переносе),
отсутствие спящих экземпляров после операции, «ничего не переезжает»
(none), явные site_ids поверх переноса, элемент и родителя в одном PATCH, превью = итог,
отказы превью теми же текстами, что у PATCH, и курсоры.
"""

import uuid
from typing import Any

import pytest
from conftest import ensure_architect, make_project
from fastapi.testclient import TestClient

from app.auth import create_access_token
from app.database import get_db
from app.main import app
from app.models.config_param import ConfigParam
from app.models.deployment_instance import DeploymentInstance
from app.models.deployment_site import DeploymentSite
from app.models.node import Node
from app.models.node_doc import NodeDoc
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


class Scene:
    """Дерево узлов с площадками: (имя, родитель, поля, площадки). Площадки проекта —
    prod-eu и prod-ru (порядок имени — порядок строк окна)."""

    def __init__(self, db, client: TestClient, spec: list[tuple[str, str | None, dict[str, Any], list[str]]]):
        self.db = db
        self.client = client
        self.project = make_project(db, "Ярмарка")
        self.project_id = self.project.id
        self.h = _h(ensure_architect(db), self.project)
        self.sites = {}
        for name in ("prod-ru", "prod-eu"):
            site = DeploymentSite(id=uuid.uuid4(), project_id=self.project.id, name=name)
            db.add(site)
            self.sites[name] = site.id
        self.ids: dict[str, uuid.UUID] = {}
        for name, parent, fields, sites in spec:
            node_id = uuid.uuid4()
            db.add(Node(id=node_id, project_id=self.project.id, name=name,
                        parent_id=self.ids[parent] if parent else None, **fields))
            db.flush()
            self.ids[name] = node_id
            for site in sites:
                db.add(DeploymentInstance(project_id=self.project.id, node_id=node_id,
                                          site_id=self.sites[site]))
        db.commit()

    def get(self, path: str, **params: Any):
        self.db.expunge_all()
        return self.client.get(path, headers=self.h, params=params)

    def preview_element(self, name: str, element: str) -> dict[str, Any]:
        r = self.get(f"{URL}/{self.ids[name]}/element-preview", element=element)
        assert r.status_code == 200, r.text
        return r.json()

    def preview_move(self, name: str, parent: str | None) -> dict[str, Any]:
        params = {"parent_id": str(self.ids[parent])} if parent else {}
        r = self.get(f"{URL}/{self.ids[name]}/move-preview", **params)
        assert r.status_code == 200, r.text
        return r.json()

    def create(self, name: str, parent: str, **fields: Any):
        """POST узла под parent; id запоминается под именем (для own)."""
        self.db.expunge_all()
        r = self.client.post(
            URL, headers=self.h, json={"name": name, "parent_id": str(self.ids[parent]), **fields}
        )
        assert r.status_code == 201, r.text
        self.ids[name] = uuid.UUID(r.json()["id"])
        return r

    def patch(self, name: str, body: dict[str, Any]):
        self.db.expunge_all()
        return self.client.patch(f"{URL}/{self.ids[name]}", headers=self.h, json=body)

    def own(self) -> dict[str, list[str]]:
        """Собственные экземпляры узлов (по имени) — все, в том числе спящие."""
        self.db.expunge_all()
        names = {v: k for k, v in self.ids.items()}
        site_names = {v: k for k, v in self.sites.items()}
        out: dict[str, list[str]] = {}
        for inst in self.db.query(DeploymentInstance).all():
            out.setdefault(names[inst.node_id], []).append(site_names[inst.site_id])
        return {k: sorted(v) for k, v in sorted(out.items())}

    def revs(self) -> tuple[int, int]:
        self.db.expunge_all()
        p = self.db.get(Project, self.project_id)
        return p.graph_rev, p.meta_rev

    def shown(self, rows: list[dict[str, Any]]) -> None:
        """Превью равно итогу: площадки каждой строки «после» — ровно действующее
        размещение объекта (NodeResponse.sites, app/deployment.placement_map)."""
        for row in rows:
            r = self.get(f"{URL}/{row['node_id']}")
            assert [s["name"] for s in r.json()["sites"]] == row["sites"], row["name"]


def _rows(preview: dict[str, Any], key: str) -> list[tuple[str, list[str]]]:
    return [(r["name"], r["sites"]) for r in preview[key]]


def test_система_в_контейнер_объединяет_площадки_единиц(client, db):
    s = Scene(db, client, [
        ("shop", None, {}, []),
        ("orders", "shop", {}, []),
        ("api", "orders", {"openapi_spec": "openapi: 3.0.0"}, ["prod-eu", "prod-ru"]),
        ("jobs", "orders", {}, []),
        ("nightly", "jobs", {}, ["prod-ru"]),
        ("scheduler", "orders", {}, ["prod-eu"]),
    ])
    db.add(ConfigParam(node_id=s.ids["scheduler"], name="CRON", value_type="string"))
    db.commit()

    p = s.preview_element("orders", "container")
    assert p["kind"] == "system_to_container"
    # Единицы до — в обходе в глубину с детьми по имени (nightly — внутри системы jobs).
    assert _rows(p, "before") == [
        ("api", ["prod-eu", "prod-ru"]), ("nightly", ["prod-ru"]), ("scheduler", ["prod-eu"]),
    ]
    assert _rows(p, "after") == [("orders", ["prod-eu", "prod-ru"])]
    assert p["docs_names"] == ["api", "scheduler"]
    assert p["container_name"] is None

    g0, m0 = s.revs()
    r = s.patch("orders", {"element": "container"})
    assert r.status_code == 200, r.text
    # Компоненты экземпляров не держат: спящих остатков от операции нет.
    assert s.own() == {"orders": ["prod-eu", "prod-ru"]}
    assert [x["name"] for x in r.json()["sites"]] == ["prod-eu", "prod-ru"]
    s.shown(p["after"])
    # Схема — структурным полем, мета — потому что изменились экземпляры.
    assert s.revs() == (g0 + 1, m0 + 1)


def test_контейнер_в_систему_раздаёт_площадки_и_листьям_составного(client, db):
    s = Scene(db, client, [
        ("shop", None, {}, []),
        ("orders", "shop", {"element": "container"}, ["prod-eu"]),
        ("api", "orders", {}, ["prod-ru"]),  # спящий экземпляр компонента
        ("jobs", "orders", {}, []),
        ("nightly", "jobs", {}, []),
        ("cron", "jobs", {}, []),
        ("Оператор", "orders", {"shape": "person"}, []),
    ])
    db.add(ConfigParam(node_id=s.ids["orders"], name="FEATURE_X", value_type="bool"))
    db.commit()

    p = s.preview_element("orders", "system")
    assert p["kind"] == "container_to_system"
    assert _rows(p, "before") == [("orders", ["prod-eu"])]
    # Составной jobs стал системой: площадки получают его листья, «Пользователь» — нет.
    assert _rows(p, "after") == [
        ("api", ["prod-eu"]), ("cron", ["prod-eu"]), ("nightly", ["prod-eu"]),
    ]
    assert p["docs_names"] == ["orders"]

    assert s.patch("orders", {"element": "system"}).status_code == 200
    assert s.own() == {"api": ["prod-eu"], "cron": ["prod-eu"], "nightly": ["prod-eu"]}
    s.shown(p["after"])


def test_вход_в_контейнер_добавляет_площадки_переносимого(client, db):
    s = Scene(db, client, [
        ("shop", None, {}, []),
        ("orders", "shop", {"element": "container"}, ["prod-eu"]),
        ("api", "orders", {}, []),
        ("billing", "shop", {}, []),
        ("gateway", "billing", {"openapi_spec": "openapi: 3.0.0"}, ["prod-ru"]),
        ("ledger", "billing", {}, ["prod-eu"]),
    ])
    # В компонент — целевой контейнер ближайший, orders.
    p = s.preview_move("billing", "api")
    assert p["kind"] == "join_container"
    assert p["container_name"] == "orders"
    assert _rows(p, "before") == [
        ("orders", ["prod-eu"]), ("gateway", ["prod-ru"]), ("ledger", ["prod-eu"]),
    ]
    assert _rows(p, "after") == [("orders", ["prod-eu", "prod-ru"])]
    assert p["docs_names"] == ["gateway"]

    r = s.patch("billing", {"parent_id": str(s.ids["api"])})
    assert r.status_code == 200, r.text
    assert s.own() == {"orders": ["prod-eu", "prod-ru"]}
    s.shown(p["after"])


def test_выход_из_контейнера_даёт_площадки_прежнего(client, db):
    s = Scene(db, client, [
        ("shop", None, {}, []),
        ("orders", "shop", {"element": "container"}, ["prod-eu", "prod-ru"]),
        ("api", "orders", {}, []),
        ("worker", "orders", {}, ["prod-ru"]),  # спящий — снимется
        ("handler", "worker", {}, []),
    ])
    p = s.preview_move("worker", "shop")
    assert p["kind"] == "leave_container"
    assert p["container_name"] == "orders"
    assert _rows(p, "before") == [("orders", ["prod-eu", "prod-ru"])]
    # Составной worker вне контейнера — система: площадки получает его лист.
    assert _rows(p, "after") == [
        ("orders", ["prod-eu", "prod-ru"]), ("handler", ["prod-eu", "prod-ru"]),
    ]
    assert p["docs_names"] == []

    assert s.patch("worker", {"parent_id": str(s.ids["shop"])}).status_code == 200
    assert s.own() == {"handler": ["prod-eu", "prod-ru"], "orders": ["prod-eu", "prod-ru"]}
    s.shown(p["after"])
    # Лист наружу — в корень: площадки получает он сам.
    p = s.preview_move("api", None)
    assert _rows(p, "after")[-1] == ("api", ["prod-eu", "prod-ru"])
    assert s.patch("api", {"parent_id": None}).status_code == 200
    assert s.own()["api"] == ["prod-eu", "prod-ru"]


@pytest.mark.parametrize(
    ("name", "op", "target"),
    [
        ("billing", "move", "shop2"),  # контейнер → контейнер (система в систему)
        ("api", "move", "jobs"),  # компонент → компонент того же контейнера
        ("api", "move", "payments"),  # компонент → компонент другого контейнера
        ("billing", "element", "system"),  # лист без детей
        ("Покупатель", "move", None),  # «Пользователь»
        ("orders", "element", "container"),  # то же значение
    ],
)
def test_ничего_не_переезжает(client, db, name, op, target):
    s = Scene(db, client, [
        ("shop", None, {}, []),
        ("shop2", None, {}, []),
        ("orders", "shop", {"element": "container"}, ["prod-eu"]),
        ("api", "orders", {}, []),
        ("jobs", "orders", {}, []),
        ("nightly", "jobs", {}, []),
        ("payments", "shop", {"element": "container"}, ["prod-ru"]),
        ("gateway", "payments", {}, []),
        ("billing", "shop", {}, ["prod-ru"]),
        ("Покупатель", "shop", {"shape": "person"}, []),
    ])
    before = s.own()
    p = s.preview_move(name, target) if op == "move" else s.preview_element(name, target)
    assert (p["kind"], p["before"], p["after"], p["docs_names"]) == ("none", [], [], [])
    body = {"parent_id": str(s.ids[target]) if target else None} if op == "move" else {"element": target}
    assert s.patch(name, body).status_code == 200
    assert s.own() == before


def test_site_ids_в_том_же_patch_ложатся_поверх(client, db):
    s = Scene(db, client, [
        ("orders", None, {}, []),
        ("api", "orders", {}, ["prod-eu"]),
        ("scheduler", "orders", {}, ["prod-eu"]),
    ])
    r = s.patch("orders", {"element": "container", "site_ids": [str(s.sites["prod-ru"])]})
    assert r.status_code == 200, r.text
    assert s.own() == {"orders": ["prod-ru"]}


def test_элемент_и_родитель_в_одном_patch_последовательно(client, db):
    """Сначала перенос (выход из контейнера: лист составного получает площадки orders),
    потом элемент (система → контейнер: узел собирает площадки своего листа)."""
    s = Scene(db, client, [
        ("shop", None, {}, []),
        ("orders", "shop", {"element": "container"}, ["prod-eu"]),
        ("api", "orders", {}, []),
        ("jobs", "orders", {}, []),
        ("nightly", "jobs", {}, []),
    ])
    r = s.patch("jobs", {"parent_id": str(s.ids["shop"]), "element": "container"})
    assert r.status_code == 200, r.text
    assert (r.json()["element_effective"], [x["name"] for x in r.json()["sites"]]) == (
        "container", ["prod-eu"],
    )
    assert s.own() == {"jobs": ["prod-eu"], "orders": ["prod-eu"]}


def test_составной_компонент_контейнером_становится_целиком(client, db):
    """Узел с хранимым «контейнер», перенесённый внутрь контейнера, — составной
    компонент (Р5): его площадки уходят новому контейнеру, его части — без экземпляров."""
    s = Scene(db, client, [
        ("orders", None, {"element": "container"}, ["prod-eu"]),
        ("api", "orders", {}, []),
        ("payments", None, {"element": "container"}, ["prod-ru"]),
        ("gateway", "payments", {}, ["prod-eu"]),  # спящий
    ])
    p = s.preview_move("payments", "orders")
    assert _rows(p, "after") == [("orders", ["prod-eu", "prod-ru"])]
    assert s.patch("payments", {"parent_id": str(s.ids["orders"])}).status_code == 200
    assert s.own() == {"orders": ["prod-eu", "prod-ru"]}


def test_документация_контейнера_ставшего_системой_по_схемам(client, db):
    s = Scene(db, client, [("orders", None, {"element": "container"}, []), ("api", "orders", {}, [])])
    assert s.preview_element("orders", "system")["docs_names"] == []
    db.add(NodeDoc(node_id=s.ids["orders"], name="Старт заказа", kind="operation", content="graph TD"))
    db.commit()
    p = s.preview_element("orders", "system")
    assert (p["kind"], p["before"], p["after"], p["docs_names"]) == (
        "container_to_system", [], [], ["orders"],
    )


def test_отказы_превью_теми_же_текстами(client, db):
    s = Scene(db, client, [
        ("orders", None, {"element": "container"}, []),
        ("api", "orders", {}, []),
        ("shop", None, {}, []),
        ("shop-db", "shop", {"shape": "database"}, []),
        ("orders-db", None, {"shape": "database"}, []),
    ])

    def both(name: str, path: str, params: dict[str, str], body: dict[str, Any]) -> tuple[int, str]:
        r = s.get(f"{URL}/{s.ids[name]}/{path}", **params)
        w = s.patch(name, body)
        assert (r.status_code, r.json()) == (w.status_code, w.json()), path
        return r.status_code, r.json()["detail"]

    # Элемент: внутри контейнера и база внутри будущего контейнера — 422.
    code, text = both("api", "element-preview", {"element": "system"}, {"element": "system"})
    assert code == 422 and text.startswith("Объект «api» лежит внутри контейнера «orders»")
    code, text = both("shop", "element-preview", {"element": "container"}, {"element": "container"})
    assert code == 422 and "база данных «shop-db»" in text
    # Перенос: внутрь собственного потомка и база в контейнер — 400.
    code, _ = both("orders", "move-preview", {"parent_id": str(s.ids["api"])},
                   {"parent_id": str(s.ids["api"])})
    assert code == 400
    code, text = both("orders-db", "move-preview", {"parent_id": str(s.ids["orders"])},
                      {"parent_id": str(s.ids["orders"])})
    assert code == 400 and text.startswith("База данных «orders-db» не может входить")


def test_превью_только_редактору(client, db):
    s = Scene(db, client, [("orders", None, {}, [])])
    reader = User(id=uuid.uuid4(), username="reader", hashed_password="x", role="viewer")
    db.add(reader)
    db.commit()
    headers = _h(reader, s.project)
    db.expunge_all()
    r = client.get(f"{URL}/{s.ids['orders']}/element-preview", params={"element": "container"},
                   headers=headers)
    assert r.status_code in (403, 404)


# --- Правило 5: первый вложенный объект у листа с площадками ---

@pytest.mark.parametrize("element", [None, "system"])
def test_создание_под_листом_с_площадками_отдаёт_их_ребёнку(client, db, element):
    """Лист-единица, получивший первого ребёнка, — система: его площадки получает ребёнок,
    у самого листа экземпляров больше нет (спящих остатков нет)."""
    s = Scene(db, client, [("orders", None, {"element": element}, ["prod-eu", "prod-ru"])])
    g0, m0 = s.revs()
    r = s.create("api", "orders")
    assert [x["name"] for x in r.json()["sites"]] == ["prod-eu", "prod-ru"]
    assert s.own() == {"api": ["prod-eu", "prod-ru"]}
    assert s.revs() == (g0 + 1, m0 + 1)
    # Второй ребёнок — уже не первый: у системы площадок нет, переносить нечего.
    s.create("scheduler", "orders")
    assert s.own() == {"api": ["prod-eu", "prod-ru"]}


@pytest.mark.parametrize(
    ("fields", "child"),
    [
        ({"element": "container"}, {}),  # лист-контейнер: ребёнок — его компонент
        ({}, {"shape": "person"}),  # «Пользователь» площадок не принимает
    ],
)
def test_создание_ничего_не_переносит(client, db, fields, child):
    s = Scene(db, client, [("orders", None, fields, ["prod-eu"])])
    g0, m0 = s.revs()
    s.create("api", "orders", **child)
    assert s.own() == {"orders": ["prod-eu"]}
    assert s.revs() == (g0 + 1, m0)


def test_перенос_поддерева_в_лист_с_площадками(client, db):
    """Переносимая система с единицами: каждая единица добавляет к своим площадкам
    площадки листа, лист становится системой без экземпляров; превью = итог."""
    s = Scene(db, client, [
        ("shop", None, {}, []),
        ("orders", "shop", {}, ["prod-eu"]),
        ("billing", "shop", {}, []),
        ("gateway", "billing", {"openapi_spec": "openapi: 3.0.0"}, ["prod-ru"]),
        ("ledger", "billing", {}, []),
    ])
    p = s.preview_move("billing", "orders")
    assert p["kind"] == "first_child"
    assert p["container_name"] == "orders"
    assert _rows(p, "before") == [("orders", ["prod-eu"]), ("gateway", ["prod-ru"])]
    assert _rows(p, "after") == [("gateway", ["prod-eu", "prod-ru"]), ("ledger", ["prod-eu"])]
    assert p["docs_names"] == []

    g0, m0 = s.revs()
    assert s.patch("billing", {"parent_id": str(s.ids["orders"])}).status_code == 200
    assert s.own() == {"gateway": ["prod-eu", "prod-ru"], "ledger": ["prod-eu"]}
    s.shown(p["after"])
    assert s.revs() == (g0 + 1, m0 + 1)


def test_выход_из_контейнера_в_лист_с_площадками(client, db):
    """Компонент, вынесенный из контейнера в лист-систему: площадки прежнего контейнера
    (правило 4) и площадки листа (правило 5) — объединением."""
    s = Scene(db, client, [
        ("orders", None, {"element": "container"}, ["prod-eu"]),
        ("api", "orders", {}, []),
        ("worker", "orders", {}, []),
        ("billing", None, {"element": "system"}, ["prod-ru"]),
    ])
    p = s.preview_move("worker", "billing")
    assert (p["kind"], p["container_name"]) == ("first_child", "billing")
    assert _rows(p, "before") == [("orders", ["prod-eu"]), ("billing", ["prod-ru"])]
    assert _rows(p, "after") == [("orders", ["prod-eu"]), ("worker", ["prod-eu", "prod-ru"])]

    assert s.patch("worker", {"parent_id": str(s.ids["billing"])}).status_code == 200
    assert s.own() == {"orders": ["prod-eu"], "worker": ["prod-eu", "prod-ru"]}
    s.shown(p["after"])


@pytest.mark.parametrize(
    ("target", "kind"),
    [
        ("orders", "none"),  # лист без площадок
        ("payments", "join_container"),  # лист-контейнер: переносимое — его компонент
    ],
)
def test_перенос_в_лист_без_пятого_правила(client, db, target, kind):
    s = Scene(db, client, [
        ("orders", None, {}, []),
        ("payments", None, {"element": "container"}, ["prod-eu"]),
        ("billing", None, {}, []),
    ])
    p = s.preview_move("billing", target)
    assert p["kind"] == kind
    before = s.own()
    assert s.patch("billing", {"parent_id": str(s.ids[target])}).status_code == 200
    assert s.own() == before
