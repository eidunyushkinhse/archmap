"""Пустая система (Р39 раздела 13 docs/plan-c4-elements.md): лист-сервис с хранимым
«система» читается системой, а не контейнером.

С явными типами пользователь создаёт «Систему» заранее, и до первого вложенного объекта
она не должна показываться контейнером. Сторожим следствия: статус не согласован и
руками не ставится, размещать нечего (экземпляры спят и отдаются первому вложенному
объекту-единице по правилу 5 D34), свои факты ловит AL24, а не AL36, контейнера и
параметров для пометок у неё нет. Круг экспорта, архива, копии и версий — в тестах
форматов рядом (test_import, test_archive_import, test_element_snapshots).
"""

import uuid
from typing import Any

import pytest
from conftest import ensure_architect, make_project
from fastapi.testclient import TestClient

from app.alerts import compute_alerts
from app.approval import SYSTEM_DETAIL
from app.auth import create_access_token
from app.data_refs import catalog_for_project
from app.database import get_db
from app.deployment import EMPTY_CONTAINER
from app.element_marks import elements_for_project
from app.main import app
from app.models.config_param import ConfigParam
from app.models.deployment_instance import DeploymentInstance
from app.models.deployment_site import DeploymentSite
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.project import Project

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

    def call(self, method: str, path: str, **kw: Any):
        self.db.expunge_all()
        return self.client.request(method, path, headers=self.h, **kw)

    def node(self, name: str) -> dict[str, Any]:
        r = self.call("GET", f"{URL}/{self.ids[name]}")
        assert r.status_code == 200, r.text
        return r.json()

    def patch(self, name: str, body: dict[str, Any]):
        return self.call("PATCH", f"{URL}/{self.ids[name]}", json=body)

    def create(self, name: str, parent: str, **fields: Any) -> dict[str, Any]:
        r = self.call("POST", URL, json={"name": name, "parent_id": str(self.ids[parent]), **fields})
        assert r.status_code == 201, r.text
        self.ids[name] = uuid.UUID(r.json()["id"])
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


def test_пустая_система_в_выдаче_узла(client, db):
    s = Scene(db, client, [("Ярмарка", None, {"element": "system"}, [])])
    out = s.node("Ярмарка")
    assert (out["element"], out["element_effective"], out["has_children"]) == ("system", "system", False)
    assert out["container_name"] is None


# ── Статус страницы ──────────────────────────────────────────────────────────


def test_статус_пустой_системы_не_согласован(client, db):
    """Хранимое «согласовано» у пустой системы не показывается: единиц нет, и «все
    единицы согласованы» по пустому списку согласием не считается."""
    s = Scene(db, client, [("Ярмарка", None, {"element": "system", "approval": "approved"}, [])])
    assert s.node("Ярмарка")["approval_effective"] == "in_progress"


def test_ручной_статус_пустой_системы_отказ(client, db):
    s = Scene(db, client, [("Ярмарка", None, {"element": "system"}, [])])
    r = s.patch("Ярмарка", {"approval": "approved"})
    assert r.status_code == 422
    assert r.json()["detail"] == SYSTEM_DETAIL


# ── Размещение ───────────────────────────────────────────────────────────────


def test_пустая_система_не_единица_размещения(client, db):
    s = Scene(db, client, [("Ярмарка", None, {"element": "system"}, [])])
    elements = elements_for_project(db, s.project_id)
    assert elements.units_under(s.ids["Ярмарка"]) == []
    assert elements.container_of(s.ids["Ярмарка"]) is None

    r = s.patch("Ярмарка", {"site_ids": [str(s.sites["prod-eu"])]})
    assert r.status_code == 422
    assert r.json()["detail"] == EMPTY_CONTAINER.format(name="Ярмарка")
    assert s.own() == {}


def test_лист_ставший_пустой_системой_площадок_не_теряет(client, db):
    """PATCH «система» у листа с площадками: экземпляры не удаляются и никуда не
    переезжают — спят; превью — вид empty_system со строкой листа «до» и пустым «после»,
    документация самого листа будет отмечена рекомендацией (AL24)."""
    s = Scene(db, client, [
        ("orders", None, {"openapi_spec": "openapi: 3.0.0"}, ["prod-eu", "prod-ru"]),
    ])
    r = s.call("GET", f"{URL}/{s.ids['orders']}/element-preview", params={"element": "system"})
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["kind"] == "empty_system"
    assert [(row["name"], row["sites"]) for row in p["before"]] == [("orders", ["prod-eu", "prod-ru"])]
    assert p["after"] == []
    assert p["docs_names"] == ["orders"]
    assert p["container_name"] is None

    g0, m0 = s.revs()
    r = s.patch("orders", {"element": "system"})
    assert r.status_code == 200, r.text
    assert (r.json()["element_effective"], r.json()["sites"]) == ("system", [])
    assert s.own() == {"orders": ["prod-eu", "prod-ru"]}
    # Схема — структурным полем; мета не двигается: экземпляры не изменились.
    assert s.revs() == (g0 + 1, m0)


def test_обратная_смена_будит_спящие_площадки(client, db):
    s = Scene(db, client, [("orders", None, {"element": "system"}, ["prod-eu"])])
    r = s.call("GET", f"{URL}/{s.ids['orders']}/element-preview", params={"element": "container"})
    assert (r.json()["kind"], r.json()["before"], r.json()["after"]) == ("none", [], [])
    r = s.patch("orders", {"element": "container"})
    assert r.status_code == 200, r.text
    assert [x["name"] for x in r.json()["sites"]] == ["prod-eu"]
    assert s.own() == {"orders": ["prod-eu"]}


def test_спящие_площадки_получает_первый_вложенный_контейнер(client, db):
    """Путь свойств: лист стал пустой системой, затем получил первого ребёнка — правило 5
    D34 отдаёт спящие экземпляры ребёнку-единице, у системы их больше нет."""
    s = Scene(db, client, [("orders", None, {}, ["prod-eu", "prod-ru"])])
    assert s.patch("orders", {"element": "system"}).status_code == 200
    g0, m0 = s.revs()
    kid = s.create("api", "orders")
    assert [x["name"] for x in kid["sites"]] == ["prod-eu", "prod-ru"]
    assert s.own() == {"api": ["prod-eu", "prod-ru"]}
    assert s.revs() == (g0 + 1, m0 + 1)


def test_спящие_площадки_получает_первый_перенесённый_контейнер(client, db):
    s = Scene(db, client, [
        ("orders", None, {"element": "system"}, ["prod-eu"]),
        ("billing", None, {}, ["prod-ru"]),
    ])
    r = s.call("GET", f"{URL}/{s.ids['billing']}/move-preview", params={"parent_id": str(s.ids["orders"])})
    assert (r.json()["kind"], r.json()["container_name"]) == ("first_child", "orders")
    assert s.patch("billing", {"parent_id": str(s.ids["orders"])}).status_code == 200
    assert s.own() == {"billing": ["prod-eu", "prod-ru"]}


def test_пользователь_в_пустой_системе_не_создаётся_и_площадки_не_будит(client, db):
    # «Пользователь» живёт только на верхнем уровне (2026-10-31): в пустую систему он не
    # создаётся, спящие площадки остаются ждать первого объекта-единицы.
    s = Scene(db, client, [("orders", None, {"element": "system"}, ["prod-eu"])])
    r = s.call("POST", URL, json={
        "name": "Покупатель", "parent_id": str(s.ids["orders"]), "shape": "person",
    })
    assert r.status_code == 422
    db.rollback()
    assert s.own() == {"orders": ["prod-eu"]}


# ── Рекомендации, конфигурация ───────────────────────────────────────────────


def test_факты_пустой_системы_ловит_al24_а_не_al36(client, db):
    s = Scene(db, client, [("orders", None, {"element": "system", "openapi_spec": "openapi: 3.0.0"}, [])])
    db.add(ConfigParam(id=uuid.uuid4(), node_id=s.ids["orders"], name="LOG_LEVEL",
                       value_type="string", required=False, default_value="info"))
    db.add(NodeDoc(id=uuid.uuid4(), node_id=s.ids["orders"], name="Схема", kind="operation",
                   content="graph TD\nA-->B"))
    db.commit()

    rep = compute_alerts(db, s.project_id)
    [a] = rep.container_own_docs
    assert (a.node_id, a.element_effective, a.has_docs, a.has_spec, a.has_config) == (
        s.ids["orders"], "system", True, True, True,
    )
    assert rep.component_facts == []


def test_лист_контейнер_со_своими_фактами_не_замечание(client, db):
    """Лист с хранимым «контейнер» (или без элемента) — контейнер: его факты на месте."""
    s = Scene(db, client, [("orders", None, {"element": "container", "openapi_spec": "openapi: 3.0.0"}, [])])
    assert compute_alerts(db, s.project_id).container_own_docs == []


def test_у_пустой_системы_нет_параметров_для_пометок(client, db):
    s = Scene(db, client, [("orders", None, {"element": "system"}, [])])
    db.add(ConfigParam(id=uuid.uuid4(), node_id=s.ids["orders"], name="LOG_LEVEL",
                       value_type="string", required=False, default_value="info"))
    db.commit()
    catalog = catalog_for_project(db, s.project_id)
    assert catalog.elements.container_of(s.ids["orders"]) is None
    assert catalog.params_for(s.ids["orders"]) == {}
