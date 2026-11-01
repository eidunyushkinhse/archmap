"""Первый вложенный объект элемент родителя не меняет (решение владельца 2026-11-01, тип
выбран всегда; Р38 раздела 13 docs/plan-c4-elements.md отменён).

У листа-сервиса тип есть всегда: лист-контейнер принимает сервис компонентом и не
принимает базу и брокер (Р6), пустая система (Р39) принимает любой объект и отдаёт ему
свои площадки (правило 5 D34). Поля NodeCreate.parent_element больше нет: прежний
клиент, приславший его, родителя не меняет.
"""

import uuid
from typing import Any

import pytest
from conftest import ensure_architect, make_project
from fastapi.testclient import TestClient

from app.auth import create_access_token
from app.database import get_db
from app.element_rules import INSIDE_CONTAINER, STORE_CREATE
from app.main import app
from app.models.deployment_instance import DeploymentInstance
from app.models.deployment_site import DeploymentSite
from app.models.node import Node
from app.models.project import Project
from app.reparent import PERSON_CREATE

URL = "/api/v1/nodes"


@pytest.fixture()
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


class Scene:
    """Проект с площадками prod-eu и prod-ru и деревом (имя, родитель, поля, площадки)."""

    def __init__(self, db, client: TestClient, spec: list[tuple[str, str | None, dict[str, Any], list[str]]]):
        self.db = db
        self.client = client
        self.project = make_project(db, "Ярмарка")
        self.project_id = self.project.id
        user = ensure_architect(db)
        token = create_access_token({"sub": user.username, "role": user.role})
        self.h = {"Authorization": f"Bearer {token}", "X-Project-Id": str(self.project.id)}
        self.sites: dict[str, uuid.UUID] = {}
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

    def post(self, name: str, parent: str | None, **fields: Any):
        self.db.expunge_all()
        body = {"name": name, "parent_id": str(self.ids[parent]) if parent else None, **fields}
        r = self.client.post(URL, headers=self.h, json=body)
        if r.status_code == 201:
            self.ids[name] = uuid.UUID(r.json()["id"])
        return r

    def node(self, name: str) -> dict[str, Any]:
        self.db.expunge_all()
        r = self.client.get(f"{URL}/{self.ids[name]}", headers=self.h)
        assert r.status_code == 200, r.text
        return r.json()

    def own(self) -> dict[str, list[str]]:
        """Собственные экземпляры узлов по имени — все, в том числе спящие."""
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


# ── Лист-контейнер ────────────────────────────────────────────────────────────


def test_сервис_в_листе_контейнере_компонент_родитель_прежний(client, db):
    s = Scene(db, client, [("orders", None, {"element": "container"}, ["prod-eu"])])
    v0 = s.node("orders")["version"]
    g0, m0 = s.revs()
    r = s.post("api", "orders")
    assert r.status_code == 201, r.text
    assert (r.json()["element"], r.json()["element_effective"]) == (None, "component")
    assert r.json()["container_name"] == "orders"
    parent = s.node("orders")
    assert (parent["element"], parent["element_effective"]) == ("container", "container")
    # Родитель не правился: его CAS-версия прежняя, площадки остались у него.
    assert parent["version"] == v0
    assert [x["name"] for x in parent["sites"]] == ["prod-eu"]
    assert s.own() == {"orders": ["prod-eu"]}
    assert s.revs() == (g0 + 1, m0)


def test_прежний_клиент_с_элементом_родителя_родителя_не_меняет(client, db):
    """Поля parent_element больше нет: прежний клиент, приславший «система», получает
    компонент в листе-контейнере, родитель остаётся контейнером."""
    s = Scene(db, client, [("orders", None, {"element": "container"}, [])])
    r = s.post("api", "orders", parent_element="system")
    assert r.status_code == 201, r.text
    assert r.json()["element_effective"] == "component"
    assert s.node("orders")["element"] == "container"


@pytest.mark.parametrize("shape", ["database", "broker"])
def test_база_и_брокер_в_лист_контейнер_отказ(client, db, shape):
    s = Scene(db, client, [("orders", None, {"element": "container"}, [])])
    g0, m0 = s.revs()
    r = s.post("child", "orders", shape=shape)
    assert r.status_code == 422
    assert r.json()["detail"] == STORE_CREATE[shape].format(name="child", container="orders")
    db.rollback()
    assert s.node("orders")["element"] == "container"
    assert s.revs() == (g0, m0)


def test_контейнер_в_лист_контейнер_отказ(client, db):
    # Объект внутри листа-контейнера — его компонент: свой элемент ему не задают.
    s = Scene(db, client, [("orders", None, {"element": "container"}, [])])
    r = s.post("api", "orders", element="container")
    assert r.status_code == 422
    assert r.json()["detail"] == INSIDE_CONTAINER.format(name="api", container="orders")


def test_пользователь_не_создаётся_внутри_листа(client, db):
    """«Пользователь» живёт только на верхнем уровне (решение владельца 2026-10-31)."""
    s = Scene(db, client, [("orders", None, {"element": "container"}, [])])
    g0, m0 = s.revs()
    r = s.post("Покупатель", "orders", shape="person")
    assert r.status_code == 422
    assert r.json()["detail"] == PERSON_CREATE
    assert r.json()["detail"] == "Пользователь живёт вне границ системы, создайте его на верхнем уровне"
    db.rollback()
    assert s.node("orders")["element"] == "container"
    assert s.revs() == (g0, m0)


# ── Пустая система: правило 5 D34 в той же транзакции ─────────────────────────


def test_пустая_система_отдаёт_площадки_ребёнку_контейнеру(client, db):
    s = Scene(db, client, [("orders", None, {"element": "system"}, ["prod-eu", "prod-ru"])])
    g0, m0 = s.revs()
    r = s.post("api", "orders", element="container")
    assert r.status_code == 201, r.text
    assert [x["name"] for x in r.json()["sites"]] == ["prod-eu", "prod-ru"]
    assert s.own() == {"api": ["prod-eu", "prod-ru"]}
    assert s.revs() == (g0 + 1, m0 + 1)
    parent = s.node("orders")
    assert (parent["element"], parent["element_effective"]) == ("system", "system")


@pytest.mark.parametrize("shape", ["database", "broker"])
def test_база_и_брокер_в_пустую_систему(client, db, shape):
    s = Scene(db, client, [("orders", None, {"element": "system"}, [])])
    r = s.post("child", "orders", shape=shape)
    assert r.status_code == 201, r.text
    assert s.node("orders")["element"] == "system"


def test_сервис_в_пустой_системе_контейнер(client, db):
    s = Scene(db, client, [("Ярмарка", None, {"element": "system"}, [])])
    r = s.post("orders", "Ярмарка")
    assert r.status_code == 201, r.text
    assert (r.json()["element"], r.json()["element_effective"]) == ("container", "container")


def test_внешний_лист_система_отдаёт_площадки_ребёнку(client, db):
    """Р42 — правило записи: внешний лист хранит «система», его спящие площадки правило 5
    D34 отдаёт ребёнку-единице."""
    s = Scene(db, client, [("Банк", None, {"is_external": True, "element": "system"}, ["prod-eu"])])
    assert s.node("Банк")["element_effective"] == "system"
    assert s.node("Банк")["sites"] == []

    r = s.post("Банк-API", "Банк", element="container")
    assert r.status_code == 201, r.text
    assert [x["name"] for x in r.json()["sites"]] == ["prod-eu"]
    assert (s.node("Банк")["element"], s.node("Банк")["element_effective"]) == ("system", "system")
    assert s.own() == {"Банк-API": ["prod-eu"]}
