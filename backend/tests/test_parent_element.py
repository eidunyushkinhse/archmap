"""Первый вложенный объект задаёт элемент родителя одним запросом (Р38 раздела 13
docs/plan-c4-elements.md): POST /nodes с parent_element.

Окно «Новый объект» выбирает тип ребёнка, и у листа-сервиса без элемента этот выбор
решает и родителя: «Компонент» делает его контейнером, любой другой тип — системой.
Родитель и ребёнок пишутся одной транзакцией, правило 5 D34 (площадки листа, ставшего
системой, — единицам нового поддерева) срабатывает так же, как при заранее записанном
элементе. Правило — в домене (app/element_rules.first_child_refusal), отказы — словами
продукта.
"""

import uuid
from typing import Any

import pytest
from conftest import ensure_architect, make_project
from fastapi.testclient import TestClient

from app.auth import create_access_token
from app.database import get_db
from app.element_marks import project_element_rows
from app.element_rules import (
    CONTAINER_INSIDE,
    INSIDE_CONTAINER,
    ONLY_SERVICE,
    PARENT_ELEMENT_ROOT,
    PARENT_ELEMENT_SET,
    PARENT_HAS_CHILDREN,
    STORE_CREATE,
    first_child_refusal,
)
from app.main import app
from app.models.deployment_instance import DeploymentInstance
from app.models.deployment_site import DeploymentSite
from app.models.node import Node
from app.models.project import Project
from app.reparent import NO_CHILDREN, PERSON_CREATE

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


# ── Успех ─────────────────────────────────────────────────────────────────────


def test_компонент_делает_лист_контейнером(client, db):
    s = Scene(db, client, [("orders", None, {}, [])])
    v0 = s.node("orders")["version"]
    g0, _ = s.revs()
    r = s.post("api", "orders", parent_element="container")
    assert r.status_code == 201, r.text
    assert (r.json()["element_effective"], r.json()["container_name"]) == ("component", "orders")
    parent = s.node("orders")
    assert (parent["element"], parent["element_effective"]) == ("container", "container")
    # Элемент родителя — колонка узла: его CAS-версия растёт, схема двигается созданием.
    assert parent["version"] == v0 + 1
    assert s.revs()[0] == g0 + 1


def test_другой_тип_делает_лист_системой(client, db):
    s = Scene(db, client, [("Ярмарка", None, {}, [])])
    r = s.post("orders", "Ярмарка", parent_element="system", element="container")
    assert r.status_code == 201, r.text
    assert r.json()["element_effective"] == "container"
    parent = s.node("Ярмарка")
    assert (parent["element"], parent["element_effective"]) == ("system", "system")


@pytest.mark.parametrize("shape", ["database", "broker"])
def test_база_и_брокер_делают_лист_системой(client, db, shape):
    s = Scene(db, client, [("orders", None, {}, [])])
    r = s.post("child", "orders", shape=shape, parent_element="system")
    assert r.status_code == 201, r.text
    assert s.node("orders")["element"] == "system"


@pytest.mark.parametrize("value", ["system", "container"])
def test_пользователь_не_создаётся_внутри_листа_и_не_задаёт_родителя(client, db, value):
    """«Пользователь» живёт только на верхнем уровне (решение владельца 2026-10-31): отказ
    создания раньше правила первого вложенного объекта, элемент родителя не записан."""
    s = Scene(db, client, [("orders", None, {}, [])])
    g0, m0 = s.revs()
    r = s.post("Покупатель", "orders", shape="person", parent_element=value)
    assert r.status_code == 422
    assert r.json()["detail"] == PERSON_CREATE
    assert r.json()["detail"] == "Пользователь живёт вне границ системы, создайте его на верхнем уровне"
    db.rollback()
    assert s.node("orders")["element"] is None
    assert s.revs() == (g0, m0)


# ── Площадки: правило 5 D34 в той же транзакции ───────────────────────────────


def test_система_отдаёт_площадки_листа_ребёнку_контейнеру(client, db):
    s = Scene(db, client, [("orders", None, {}, ["prod-eu", "prod-ru"])])
    g0, m0 = s.revs()
    r = s.post("api", "orders", parent_element="system", element="container")
    assert r.status_code == 201, r.text
    assert [x["name"] for x in r.json()["sites"]] == ["prod-eu", "prod-ru"]
    assert s.own() == {"api": ["prod-eu", "prod-ru"]}
    assert s.revs() == (g0 + 1, m0 + 1)


def test_контейнер_оставляет_площадки_у_себя(client, db):
    s = Scene(db, client, [("orders", None, {}, ["prod-eu"])])
    g0, m0 = s.revs()
    r = s.post("api", "orders", parent_element="container")
    assert r.status_code == 201, r.text
    assert r.json()["sites"] == []
    assert s.own() == {"orders": ["prod-eu"]}
    assert [x["name"] for x in s.node("orders")["sites"]] == ["prod-eu"]
    assert s.revs() == (g0 + 1, m0)


# ── Отказы ────────────────────────────────────────────────────────────────────


def test_у_родителя_с_вложенными_отказ(client, db):
    s = Scene(db, client, [("Ярмарка", None, {}, []), ("orders", "Ярмарка", {}, [])])
    r = s.post("billing", "Ярмарка", parent_element="system")
    assert r.status_code == 422
    assert r.json()["detail"] == PARENT_HAS_CHILDREN.format(name="Ярмарка")
    assert r.json()["detail"] == "У «Ярмарка» уже есть вложенные объекты, его тип меняют в свойствах."


@pytest.mark.parametrize("stored", ["system", "container"])
def test_у_родителя_с_выбранным_типом_отказ(client, db, stored):
    s = Scene(db, client, [("orders", None, {"element": stored}, [])])
    r = s.post("api", "orders", parent_element="container")
    assert r.status_code == 422
    assert r.json()["detail"] == PARENT_ELEMENT_SET.format(name="orders")


def test_внутри_контейнера_отказ(client, db):
    s = Scene(db, client, [("orders", None, {"element": "container"}, []), ("api", "orders", {}, [])])
    r = s.post("handler", "api", parent_element="system")
    assert r.status_code == 422
    assert r.json()["detail"] == INSIDE_CONTAINER.format(name="api", container="orders")


def test_не_сервис_отказ(client, db):
    # Через API внутрь базы не создаётся ничего — прежний отказ раньше правила Р38.
    s = Scene(db, client, [("orders-db", None, {"shape": "database"}, [])])
    r = s.post("child", "orders-db", parent_element="system")
    assert r.status_code == 422
    assert r.json()["detail"] == NO_CHILDREN


def test_правило_домена_не_сервис(db):
    # Само правило называет форму: элемент задаётся только у сервиса.
    s_id = uuid.uuid4()
    p = make_project(db, "Ярмарка")
    db.add(Node(id=s_id, project_id=p.id, name="orders-db", shape="database"))
    db.commit()
    reason = first_child_refusal(
        project_element_rows(db, p.id), parent_id=s_id, value="system",
        child_name="x", child_shape="service", child_element=None,
    )
    assert reason == ONLY_SERVICE


def test_на_верхнем_уровне_отказ(client, db):
    s = Scene(db, client, [])
    r = s.post("orders", None, parent_element="system")
    assert r.status_code == 422
    assert r.json()["detail"] == PARENT_ELEMENT_ROOT


@pytest.mark.parametrize(("shape", "template"), [
    ("database", STORE_CREATE["database"]),
    ("broker", STORE_CREATE["broker"]),
])
def test_контейнер_только_с_компонентом(client, db, shape, template):
    s = Scene(db, client, [("orders", None, {}, [])])
    r = s.post("child", "orders", shape=shape, parent_element="container")
    assert r.status_code == 422
    assert r.json()["detail"] == template.format(name="child", container="orders")
    assert s.node("orders")["element"] is None


def test_контейнер_под_родителем_контейнером_отказ(client, db):
    s = Scene(db, client, [("orders", None, {}, [])])
    r = s.post("api", "orders", parent_element="container", element="container")
    assert r.status_code == 422
    assert r.json()["detail"] == CONTAINER_INSIDE.format(name="orders", inner="api")


def test_отказ_ребёнка_не_оставляет_элемент_у_родителя(client, db):
    """Атомарность: имя ребёнка длиннее колонки — 422 при flush, и элемент родителя,
    присвоенный в той же транзакции, не записан."""
    s = Scene(db, client, [("orders", None, {}, ["prod-eu"])])
    g0, m0 = s.revs()
    r = s.post("x" * 300, "orders", parent_element="system")
    assert r.status_code == 422, r.text
    db.rollback()
    parent = s.node("orders")
    assert (parent["element"], parent["element_effective"]) == (None, "container")
    assert s.own() == {"orders": ["prod-eu"]}
    assert s.revs() == (g0, m0)
