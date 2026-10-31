"""«Пользователь» живёт только на верхнем уровне (решение владельца 2026-10-31).

По C4 человек пользуется системой, а не входит в неё: Structurizr DSL разрешает person
только внутри model, у системы детьми бывают только контейнеры, у контейнера — только
компоненты. До 2026-10-31 сервер запрещал лишь перенос человека внутрь объекта, а создать
его внутри или сделать пользователем вложенный объект было можно — их ловил AL25.

Здесь — API: создание внутри объекта (422), перенос внутрь (400, прежний текст) и смена
формы у вложенного объекта (400, как прочие отказы смены формы). Родитель и форма
проверяются ПОСЛЕ правки: «вынести в корень и стать пользователем» одним PATCH проходит.
Вложенный человек из старых данных правкам не мешает — его отмечает AL25.
"""

import uuid
from typing import Any

import pytest
from conftest import ensure_architect, make_project
from fastapi.testclient import TestClient

from app.auth import create_access_token
from app.database import get_db
from app.main import app
from app.models.node import Node
from app.models.project import Project
from app.reparent import PERSON_CREATE, PERSON_MOVE, PERSON_SHAPE

URL = "/api/v1/nodes"


@pytest.fixture()
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


class Scene:
    """Проект с деревом (имя, имя родителя, поля) и заголовками владельца."""

    def __init__(self, db, client: TestClient, spec: list[tuple[str, str | None, dict[str, Any]]]):
        self.db = db
        self.client = client
        self.project = make_project(db, "Ярмарка")
        self.project_id = self.project.id
        user = ensure_architect(db)
        token = create_access_token({"sub": user.username, "role": user.role})
        self.h = {"Authorization": f"Bearer {token}", "X-Project-Id": str(self.project.id)}
        self.ids: dict[str, uuid.UUID] = {}
        for name, parent, fields in spec:
            node_id = uuid.uuid4()
            db.add(Node(id=node_id, project_id=self.project.id, name=name,
                        parent_id=self.ids[parent] if parent else None, **fields))
            db.flush()
            self.ids[name] = node_id
        db.commit()

    def post(self, name: str, parent: str | None, **fields: Any):
        self.db.expunge_all()
        body = {"name": name, "parent_id": str(self.ids[parent]) if parent else None, **fields}
        return self.client.post(URL, headers=self.h, json=body)

    def patch(self, who: str, **fields: Any):
        self.db.expunge_all()
        if "parent" in fields:
            parent = fields.pop("parent")
            fields["parent_id"] = str(self.ids[parent]) if parent else None
        return self.client.patch(f"{URL}/{self.ids[who]}", headers=self.h, json=fields)

    def node(self, name: str) -> dict[str, Any]:
        self.db.expunge_all()
        r = self.client.get(f"{URL}/{self.ids[name]}", headers=self.h)
        assert r.status_code == 200, r.text
        return r.json()

    def revs(self) -> tuple[int, int]:
        self.db.expunge_all()
        p = self.db.get(Project, self.project_id)
        return p.graph_rev, p.meta_rev


# Система с контейнером и компонентом, рядом лист без элемента и база.
ДЕРЕВО: list[tuple[str, str | None, dict[str, Any]]] = [
    ("Ярмарка", None, {}),
    ("orders", "Ярмарка", {"element": "container"}),
    ("api", "orders", {}),
    ("billing", "Ярмарка", {}),
    ("Каталог", None, {"element": "system"}),
]


# ── Создание ──────────────────────────────────────────────────────────────────


def test_на_верхнем_уровне_создаётся(client, db):
    s = Scene(db, client, ДЕРЕВО)
    r = s.post("Покупатель", None, shape="person")
    assert r.status_code == 201, r.text
    assert (r.json()["parent_id"], r.json()["element_effective"]) == (None, None)


@pytest.mark.parametrize("parent", ["Ярмарка", "orders", "api", "billing", "Каталог"])
def test_внутри_объекта_не_создаётся(client, db, parent):
    """Система с вложенными, контейнер, компонент, лист без элемента и пустая система —
    везде одинаковый отказ 422 и ничего не записано."""
    s = Scene(db, client, ДЕРЕВО)
    g0, m0 = s.revs()
    r = s.post("Покупатель", parent, shape="person")
    assert r.status_code == 422
    assert r.json()["detail"] == PERSON_CREATE
    assert r.json()["detail"] == (
        "Пользователь живёт вне границ системы, создайте его на верхнем уровне"
    )
    db.rollback()
    assert s.revs() == (g0, m0)
    assert db.query(Node).filter(Node.name == "Покупатель").count() == 0


def test_внутри_базы_прежний_отказ_формы(client, db):
    # Внутрь формы без детей не создаётся ничего — эта проверка идёт раньше.
    s = Scene(db, client, [("orders-db", None, {"shape": "database"})])
    r = s.post("Покупатель", "orders-db", shape="person")
    assert r.status_code == 422
    assert r.json()["detail"] == "Внутрь этого объекта нельзя вкладывать другие — детей не бывает"


# ── Смена формы ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize("name", ["billing", "api"])
def test_вложенный_объект_не_становится_пользователем(client, db, name):
    s = Scene(db, client, ДЕРЕВО)
    g0, m0 = s.revs()
    r = s.patch(name, shape="person")
    assert r.status_code == 400
    assert r.json()["detail"] == PERSON_SHAPE.format(name=name)
    assert r.json()["detail"] == (
        f"Пользователь живёт вне границ системы, сначала перенесите «{name}» на верхний уровень"
    )
    assert s.node(name)["shape"] == "service"
    assert s.revs() == (g0, m0)


def test_корневой_объект_становится_пользователем(client, db):
    s = Scene(db, client, [("Покупатель", None, {})])
    r = s.patch("Покупатель", shape="person")
    assert r.status_code == 200, r.text
    assert r.json()["shape"] == "person"


def test_вынести_в_корень_и_стать_пользователем_одним_запросом(client, db):
    """Родитель проверяется ПОСЛЕ правки: перенос в корень в том же запросе снимает
    отказ смены формы."""
    s = Scene(db, client, ДЕРЕВО)
    r = s.patch("billing", parent=None, shape="person")
    assert r.status_code == 200, r.text
    assert (r.json()["parent_id"], r.json()["shape"]) == (None, "person")


def test_вложить_и_стать_пользователем_одним_запросом_отказ_переноса(client, db):
    s = Scene(db, client, [("Ярмарка", None, {}), ("orders", "Ярмарка", {}), ("Гость", None, {})])
    r = s.patch("Гость", parent="Ярмарка", shape="person")
    assert r.status_code == 400
    assert r.json()["detail"] == PERSON_MOVE
    assert s.node("Гость")["parent_id"] is None


def test_пользователь_становится_сервисом_и_вкладывается_одним_запросом(client, db):
    """Форма проверяется тоже после правки: человек, который в том же запросе становится
    сервисом, внутрь объекта переносится."""
    s = Scene(db, client, [("Ярмарка", None, {}), ("orders", "Ярмарка", {}),
                           ("Покупатель", None, {"shape": "person"})])
    r = s.patch("Покупатель", parent="Ярмарка", shape="service")
    assert r.status_code == 200, r.text
    assert (r.json()["parent_id"], r.json()["shape"]) == (str(s.ids["Ярмарка"]), "service")


# ── Перенос ───────────────────────────────────────────────────────────────────


def test_перенос_внутрь_прежним_текстом(client, db):
    s = Scene(db, client, [("Ярмарка", None, {}), ("orders", "Ярмарка", {}),
                           ("Покупатель", None, {"shape": "person"})])
    r = s.patch("Покупатель", parent="Ярмарка")
    assert r.status_code == 400
    assert r.json()["detail"] == "Пользователь живёт вне границ системы — его нельзя вложить в объект"
    preview = s.client.get(
        f"{URL}/{s.ids['Покупатель']}/move-preview", headers=s.h,
        params={"parent_id": str(s.ids["Ярмарка"])},
    )
    assert (preview.status_code, preview.json()["detail"]) == (400, PERSON_MOVE)


# ── Старые данные: вложенный «Пользователь» правкам не мешает ─────────────────


def test_вложенный_пользователь_из_старых_данных_правится_и_выносится(client, db):
    """До 2026-10-31 человека можно было создать внутри объекта. Такие записи остаются:
    полный набор полей (форма прежняя) не падает, вынос в корень проходит."""
    s = Scene(db, client, [("Ярмарка", None, {}), ("orders", "Ярмарка", {}),
                           ("Оператор", "Ярмарка", {"shape": "person"})])
    r = s.patch("Оператор", name="Оператор поддержки", shape="person", role="человек")
    assert r.status_code == 200, r.text
    r = s.patch("Оператор", parent=None)
    assert r.status_code == 200, r.text
    assert r.json()["parent_id"] is None
