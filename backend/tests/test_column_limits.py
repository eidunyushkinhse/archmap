"""Длина строки против колонки — 422 до записи, а не 500 на Postgres (app/column_limits.py).

SQLite длину VARCHAR не проверяет, поэтому без проверки перед записью тесты зелёные,
а на Postgres тот же запрос — DataError и 500 (аудит 2026-10: M2, S4, S5, S8). Здесь
проверка исполняется и на SQLite, так что тесты видят то же, что прод.
"""

import uuid

import pytest
from conftest import make_project
from fastapi.testclient import TestClient
from sqlalchemy import String

from app.auth import create_access_token
from app.column_limits import ValueTooLong, _limits_of, check_lengths
from app.database import Base, get_db
from app.main import app
from app.models.edge import Edge
from app.models.node import Node
from app.models.user import User

API = "/api/v1"


def test_проверка_видит_каждую_ограниченную_колонку_каждой_модели() -> None:
    # Сторож класса ошибок: новая колонка String(n) в любой модели попадает в проверку
    # сама, без списка «что не забыть».
    for mapper in Base.registry.mappers:
        table = mapper.local_table
        columns = {c.name: c.type.length for c in table.columns if isinstance(c.type, String) and c.type.length}
        covered = {mapper.get_property_by_column(table.c[name]).key: n for name, n in columns.items()}
        assert dict(_limits_of(mapper.class_)) == covered, table.name


def test_значение_ровно_на_пределе_проходит_длиннее_нет() -> None:
    check_lengths([Node(name="я" * 256)])
    with pytest.raises(ValueTooLong) as exc:
        check_lengths([Node(name="я" * 257)])
    assert exc.value.detail == "Поле «name» длиннее 256 символов"


@pytest.fixture()
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


@pytest.fixture()
def scene(db) -> dict:
    owner = User(id=uuid.uuid4(), username="owner", hashed_password="x", role="architect")
    db.add(owner)
    db.flush()
    p = make_project(db, "Ярмарка", owner=owner)
    a = Node(id=uuid.uuid4(), project_id=p.id, name="orders")
    b = Node(id=uuid.uuid4(), project_id=p.id, name="billing")
    db.add_all([a, b])
    db.commit()
    token = create_access_token({"sub": owner.username})
    return {
        "p": p,
        "a": a,
        "b": b,
        "h": {"Authorization": f"Bearer {token}", "X-Project-Id": str(p.id)},
    }


def test_слишком_длинное_имя_объекта_422_текстом(client, db, scene) -> None:
    r = client.post(f"{API}/nodes", json={"name": "x" * 257}, headers=scene["h"])

    assert r.status_code == 422
    assert r.json() == {"detail": "Поле «name» длиннее 256 символов"}
    assert db.query(Node).count() == 2


def test_длинная_технология_в_правке_объекта_422(client, db, scene) -> None:
    r = client.patch(
        f"{API}/nodes/{scene['a'].id}", json={"technology": "t" * 129}, headers=scene["h"]
    )

    assert r.status_code == 422
    assert r.json() == {"detail": "Поле «technology» длиннее 128 символов"}
    db.expire_all()
    assert db.get(Node, scene["a"].id).technology is None


def test_длинная_подпись_связи_422(client, db, scene) -> None:
    body = {"source_id": str(scene["a"].id), "target_id": str(scene["b"].id), "label": "l" * 257}

    r = client.post(f"{API}/edges", json=body, headers=scene["h"])

    assert r.status_code == 422
    assert r.json() == {"detail": "Поле «label» длиннее 256 символов"}
    assert db.query(Edge).count() == 0


def test_длинный_логин_новой_учётки_400_текстом(client, db) -> None:
    boss = User(username="boss", hashed_password="x", role="architect", is_admin=True)
    db.add(boss)
    db.commit()
    h = {"Authorization": f"Bearer {create_access_token({'sub': 'boss'})}"}

    r = client.post(
        f"{API}/admin/users", json={"username": "u" * 65, "password": "long-enough-1"}, headers=h
    )

    # Свой текст у ручки администратора срабатывает раньше общего сторожа: главное, не 500.
    assert r.status_code == 400
    assert r.json() == {"detail": "Логин должен быть не длиннее 64 символов"}
    assert db.query(User).count() == 1


def test_снимок_отката_мимо_схем_тоже_проверяется(client, db, scene) -> None:
    # Снимок восстановления пишет строки напрямую из тела — схема длину не держит.
    h, bus = scene["h"], scene["b"].id
    snap = client.get(f"{API}/nodes/{bus}/deletion-snapshot", headers=h).json()
    assert client.delete(f"{API}/nodes/{bus}", headers=h).status_code == 204
    snap["nodes"][0]["name"] = "n" * 300

    r = client.post(f"{API}/nodes/restore", json=snap, headers=h)

    assert r.status_code == 422
    assert r.json() == {"detail": "Поле «name» длиннее 256 символов"}
    assert db.get(Node, bus) is None
