"""Поиск объекта по имени (GET /api/v1/nodes/search): порядок находок.

Находка 10 (2026-11-24): первые 20 совпадений отдавались без сортировки, и одинаково
подходящие объекты менялись местами между загрузками. Теперь сначала имена, которые
начинаются с запроса, затем остальные; внутри группы по имени без учёта регистра, при
равенстве по id; срез в 20 — после сортировки. Имена в тестах латиницей: lower() на
SQLite кириллицу не сворачивает, а порядок от этого зависеть не должен.
"""

import uuid

import pytest
from conftest import ensure_architect, make_project, typed
from fastapi.testclient import TestClient

from app.auth import create_access_token
from app.database import get_db
from app.main import app
from app.models.node import Node
from app.models.project import Project
from app.models.user import User

URL = "/api/v1/nodes/search"


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


def _node(db, project: Project, name: str, parent: Node | None = None) -> Node:
    n = Node(id=uuid.uuid4(), project_id=project.id, name=name,
             parent_id=parent.id if parent else None)
    db.add(n)
    db.flush()
    return n


def _names(client: TestClient, headers: dict[str, str], q: str) -> list[tuple[str, str]]:
    r = client.get(URL, params={"q": q}, headers=headers)
    assert r.status_code == 200, r.text
    return [(n["name"], n["id"]) for n in r.json()]


def test_сначала_начинающиеся_с_запроса_затем_по_имени_и_id(db, client):
    user = ensure_architect(db)
    p = make_project(db, "Магазин")
    shop = _node(db, p, "shop")
    billing = _node(db, p, "billing")
    # Вставка вразнобой: без сортировки база отдала бы их в порядке вставки.
    _node(db, p, "gateway-pay", shop)
    _node(db, p, "Payroll", shop)
    twin_a = _node(db, p, "pay-worker", shop)
    _node(db, p, "api-PAY", shop)
    twin_b = _node(db, p, "pay-worker", billing)  # то же имя у другого родителя: равный ранг
    _node(db, p, "Payments", shop)
    _node(db, p, "orders", shop)  # не подходит
    typed(db, p.id)
    db.commit()
    h = _h(user, p)

    first = _names(client, h, "pay")
    # «pay-worker» раньше «payments»: дефис меньше буквы. Двойники — по id.
    twins = sorted([str(twin_a.id), str(twin_b.id)])
    assert [name for name, _ in first] == [
        "pay-worker", "pay-worker", "Payments", "Payroll", "api-PAY", "gateway-pay",
    ]
    assert [first[0][1], first[1][1]] == twins
    # Запросы подряд — один и тот же порядок.
    for _ in range(3):
        assert _names(client, h, "pay") == first
    # Регистр запроса порядок не меняет.
    assert _names(client, h, "PAY") == first


def test_срез_в_двадцать_после_сортировки(db, client):
    user = ensure_architect(db)
    p = make_project(db, "Магазин")
    root = _node(db, p, "root")
    # 25 совпадений внутри имени вставлены раньше и по имени идут раньше единственного
    # имени, которое начинается с запроса: без сортировки оно в срез не попало бы.
    for i in range(25):
        _node(db, p, f"a-pay-{i:02d}", root)
    _node(db, p, "pay-z", root)
    typed(db, p.id)
    db.commit()

    got = [name for name, _ in _names(client, _h(user, p), "pay")]
    assert len(got) == 20
    assert got[0] == "pay-z"
    assert got[1:] == [f"a-pay-{i:02d}" for i in range(19)]
