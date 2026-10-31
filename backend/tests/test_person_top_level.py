"""«Пользователь» живёт только на верхнем уровне (решение владельца 2026-10-31).

По C4 человек пользуется системой, а не входит в неё: Structurizr DSL разрешает person
только внутри model, у системы детьми бывают только контейнеры, у контейнера — только
компоненты. До 2026-10-31 сервер запрещал лишь перенос человека внутрь объекта, а создать
его внутри или сделать пользователем вложенный объект было можно — их ловил AL25.

Здесь — API: создание внутри объекта (422), перенос внутрь (400, прежний текст) и смена
формы у вложенного объекта (400, как прочие отказы смены формы). Родитель и форма
проверяются ПОСЛЕ правки: «вынести в корень и стать пользователем» одним PATCH проходит.
Вложенный человек из старых данных правкам не мешает — его отмечает AL25.

Второе правило того же решения (N4): вложенных объектов у «Пользователя» не бывает —
как у базы и брокера. Его держат все пути записи: создание внутри (422) и перенос
внутрь (400) отвечают общим отказом формы без детей, смена формы узла с вложенными на
«Пользователя» — отказом смены формы, ввоз файла и архива поднимает детей человека к
его родителю (у корневого — на верхний уровень) с замечанием. Синк — в
test_sync_apply (раздел N4): вложенные прогона создаются там, где сам человек.
"""

import io
import uuid
import zipfile
from typing import Any

import pytest
import yaml
from conftest import ensure_architect, make_project
from fastapi.testclient import TestClient

from app.auth import create_access_token
from app.database import get_db
from app.import_yaml import parse_import
from app.main import app
from app.models.node import Node
from app.models.project import Project
from app.reparent import NO_CHILDREN, PERSON_CREATE, PERSON_MOVE, PERSON_SHAPE
from app.unified_apply import apply_unified_plan
from app.unified_import import build_unified_plan

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


# ── N4: вложенных объектов у «Пользователя» не бывает ─────────────────────────

ЛЮДИ: list[tuple[str, str | None, dict[str, Any]]] = [
    ("Покупатель", None, {"shape": "person"}),
    ("Ярмарка", None, {}),
    ("orders", "Ярмарка", {}),
]


def test_внутри_пользователя_не_создаётся_ничего(client, db):
    """Создание внутри «Пользователя» — тот же отказ, что внутри базы и брокера: форма без
    детей проверяется раньше правила первого вложенного объекта."""
    s = Scene(db, client, ЛЮДИ)
    g0, m0 = s.revs()
    for shape in ("service", "database", "person"):
        r = s.post("кабинет", "Покупатель", shape=shape)
        assert (r.status_code, r.json()["detail"]) == (422, NO_CHILDREN)
    db.rollback()
    assert s.revs() == (g0, m0)
    assert db.query(Node).filter(Node.parent_id == s.ids["Покупатель"]).count() == 0


def test_внутрь_пользователя_не_переносится(client, db):
    s = Scene(db, client, ЛЮДИ)
    r = s.patch("orders", parent="Покупатель")
    assert (r.status_code, r.json()["detail"]) == (400, NO_CHILDREN)
    preview = s.client.get(
        f"{URL}/{s.ids['orders']}/move-preview", headers=s.h,
        params={"parent_id": str(s.ids["Покупатель"])},
    )
    assert (preview.status_code, preview.json()["detail"]) == (400, NO_CHILDREN)
    assert s.node("orders")["parent_id"] == str(s.ids["Ярмарка"])


def test_объект_с_вложенными_не_становится_пользователем(client, db):
    """Корневой объект пользователем стать может (выше), но не с вложенными: отказ смены
    формы называет все три формы без детей."""
    s = Scene(db, client, ЛЮДИ)
    r = s.patch("Ярмарка", shape="person")
    assert r.status_code == 400
    assert r.json()["detail"] == (
        "У объекта есть вложенные объекты — базой данных, брокером или «Пользователем» ему не "
        "стать"
    )
    assert s.node("Ярмарка")["shape"] == "service"


def test_ввоз_файла_поднимает_детей_корневого_пользователя_на_верхний_уровень():
    """Правило 0 ввоза (app/import_element): дети «Пользователя» — к его родителю, у
    корневого — на верхний уровень, с поддеревом и одним замечанием на ребёнка. Вложенный
    человек — test_import (его дети остаются у его родителя, сам он уходит в корень)."""
    parsed, errors = parse_import(
        "nodes:\n  - name: Покупатель\n    shape: person\n    children:\n"
        "      - name: кабинет\n        children:\n          - name: профиль\n"
    )
    assert errors == [] and parsed is not None
    родители = {
        n.name: (parsed.nodes[n.parent_idx].name if n.parent_idx is not None else None)
        for n in parsed.nodes
    }
    assert родители == {"Покупатель": None, "кабинет": None, "профиль": "кабинет"}
    assert parsed.warnings == [
        "Покупатель: у пользователя «Покупатель» вложенных объектов не бывает — «кабинет» "
        "поднят на верхний уровень",
    ]


def test_ввоз_архива_не_кладёт_детей_в_пользователя(db):
    """Архив знания проходит тот же разбор C4 (unified_import → parse_import): после
    применения у «Пользователя» нет вложенных, его бывший ребёнок — на верхнем уровне."""
    c4 = (
        "nodes:\n  - name: Покупатель\n    shape: person\n    children:\n"
        "      - name: кабинет\n  - name: Ярмарка\n"
    )
    manifest = {"archmap-archive": 1, "project": {"name": "Архив"}, "contents": {"c4": "c4.yaml"}}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("manifest.yaml", yaml.safe_dump(manifest, allow_unicode=True))
        zf.writestr("c4.yaml", c4)
    план = build_unified_plan([("project.zip", buf.getvalue())])
    assert план.ok and план.merged is not None
    проект, _отчёт = apply_unified_plan(db, план, {}, "Архив", None, ensure_architect(db).id)
    db.commit()

    узлы = {n.name: n for n in db.query(Node).filter(Node.project_id == проект.id)}
    assert узлы["Покупатель"].shape == "person"
    assert узлы["кабинет"].parent_id is None
    assert db.query(Node).filter(Node.parent_id == узлы["Покупатель"].id).count() == 0
