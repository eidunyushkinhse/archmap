"""Доступ к проектам по участникам (docs/tasks/project-access.md).

Всё через настоящие зависимости: токен → get_current_user → действующая роль в
проекте (app/access.py). Подменена только сессия БД. Тестовые пользователи НЕ
администраторы по умолчанию: админ «видит всё» и спрятал бы любой баг прав.

Сцена: проект «Ярмарка» с владельцем owner, редактором editor (глобально viewer —
viewer может быть редактором чужого проекта) и читателем reader (глобально
architect — architect без роли редактора проект не правит). stranger — architect
без участия, admin — администратор (глобально viewer) без участия, blocked —
заблокированный.
"""

import uuid

import pytest
from conftest import make_project
from fastapi.testclient import TestClient

from app.access import effective_role, effective_roles
from app.auth import create_access_token
from app.database import get_db
from app.deps import ProjectAccess, require_project_editor, require_project_owner
from app.main import app
from app.models.node import Node
from app.models.project import Project
from app.models.project_member import ProjectMember
from app.models.user import User
from app.unified_apply import apply_unified_plan
from app.unified_import import build_unified_plan

PROJECTS = "/api/v1/projects"
NODES = "/api/v1/nodes"


@pytest.fixture()
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _user(db, username: str, role: str = "architect", **fields) -> User:
    u = User(id=uuid.uuid4(), username=username, hashed_password="x", role=role, **fields)
    db.add(u)
    db.flush()
    return u


def _h(user: User, project: Project | None = None) -> dict[str, str]:
    """Заголовки запроса от имени пользователя (и в контексте проекта)."""
    token = create_access_token({"sub": user.username, "role": user.role})
    h = {"Authorization": f"Bearer {token}"}
    if project is not None:
        h["X-Project-Id"] = str(project.id)
    return h


def _member(db, project: Project, user: User, role: str) -> None:
    db.add(ProjectMember(project_id=project.id, user_id=user.id, role=role))
    db.flush()


@pytest.fixture()
def scene(db) -> dict:
    owner = _user(db, "owner")
    editor = _user(db, "editor", role="viewer")
    reader = _user(db, "reader")
    stranger = _user(db, "stranger")
    admin = _user(db, "admin", role="viewer", is_admin=True)
    blocked = _user(db, "blocked", is_active=False)
    p = make_project(db, "Ярмарка", owner=owner)
    _member(db, p, editor, "editor")
    _member(db, p, reader, "reader")
    db.add(Node(id=uuid.uuid4(), project_id=p.id, name="orders"))
    db.commit()
    return {
        "p": p,
        "owner": owner,
        "editor": editor,
        "reader": reader,
        "stranger": stranger,
        "admin": admin,
        "blocked": blocked,
    }


def _roles(db, project_id: uuid.UUID) -> dict[str, str]:
    rows = (
        db.query(User.username, ProjectMember.role)
        .join(ProjectMember, ProjectMember.user_id == User.id)
        .filter(ProjectMember.project_id == project_id)
        .all()
    )
    return dict(rows)


# ── Действующая роль: порядок проверок ───────────────────────────────────────


def test_effective_role_порядок_проверок(db, scene):
    p = scene["p"]
    assert effective_role(db, scene["admin"], p) == "owner"  # админ без участия
    assert effective_role(db, scene["owner"], p) == "owner"
    assert effective_role(db, scene["editor"], p) == "editor"
    assert effective_role(db, scene["reader"], p) == "reader"
    assert effective_role(db, scene["stranger"], p) is None
    p.visible_to_all = True
    assert effective_role(db, scene["stranger"], p) == "reader"
    # Участник остаётся при своей роли и в видимом всем проекте.
    assert effective_role(db, scene["editor"], p) == "editor"
    # Батч-версия списка считает то же самое.
    for name in ("admin", "owner", "editor", "reader", "stranger"):
        assert effective_roles(db, scene[name], [p])[p.id] == effective_role(db, scene[name], p)


def test_зависимости_записи_и_управления(db, scene):
    p = scene["p"]
    owner_access = ProjectAccess(project=p, user=scene["owner"], role="owner")
    editor_access = ProjectAccess(project=p, user=scene["editor"], role="editor")
    reader_access = ProjectAccess(project=p, user=scene["reader"], role="reader")
    assert require_project_editor(owner_access) is scene["owner"]
    assert require_project_editor(editor_access) is scene["editor"]
    assert require_project_owner(owner_access) is scene["owner"]
    from fastapi import HTTPException

    for access, dep in (
        (reader_access, require_project_editor),
        (editor_access, require_project_owner),
        (reader_access, require_project_owner),
    ):
        with pytest.raises(HTTPException) as ei:
            dep(access)
        assert ei.value.status_code == 403


# ── Матрица «роль × действие» ────────────────────────────────────────────────

# Ожидаемые коды: чтение схемы, запись в схему, PATCH проекта, участники, архив.
MATRIX = {
    "owner": (200, 201, 200, 200, 200),
    "editor": (200, 201, 403, 403, 403),
    "reader": (200, 403, 403, 403, 403),
    "stranger": (404, 404, 404, 404, 404),
    "admin": (200, 201, 200, 200, 200),
}


@pytest.mark.parametrize("who", list(MATRIX))
def test_матрица_роль_на_действие(client, db, scene, who):
    p, user = scene["p"], scene[who]
    read, write, patch, members, archive = MATRIX[who]

    assert client.get(NODES, headers=_h(user, p)).status_code == read
    r = client.post(NODES, headers=_h(user, p), json={"name": f"от {who}"})
    assert r.status_code == write, r.text
    r = client.patch(f"{PROJECTS}/{p.id}", headers=_h(user), json={"description": who})
    assert r.status_code == patch, r.text
    r = client.put(
        f"{PROJECTS}/{p.id}/members/{scene['stranger'].id}",
        headers=_h(user),
        json={"role": "reader"},
    )
    assert r.status_code == members, r.text
    assert client.post(f"{PROJECTS}/{p.id}/archive", headers=_h(user)).status_code == archive


@pytest.mark.parametrize(
    ("who", "code"),
    [("editor", 403), ("reader", 403), ("stranger", 404), ("owner", 204)],
)
def test_удаление_только_владельцу(client, db, scene, who, code):
    p = scene["p"]
    assert client.post(f"{PROJECTS}/{p.id}/archive", headers=_h(scene["owner"])).status_code == 200
    r = client.delete(f"{PROJECTS}/{p.id}", headers=_h(scene[who]), params={"confirm": "Ярмарка"})
    assert r.status_code == code, r.text
    assert (db.get(Project, p.id) is None) == (code == 204)


def test_администратор_удаляет_чужой_проект(client, db, scene):
    p = scene["p"]
    assert client.post(f"{PROJECTS}/{p.id}/archive", headers=_h(scene["admin"])).status_code == 200
    r = client.delete(f"{PROJECTS}/{p.id}", headers=_h(scene["admin"]), params={"confirm": "Ярмарка"})
    assert r.status_code == 204
    assert db.get(Project, p.id) is None


def test_синк_и_догрузка_редактору_но_не_читателю(client, db, scene):
    p = scene["p"]
    body = {"contents": ["nodes:\n  - name: orders\n"]}
    assert client.post(f"{PROJECTS}/{p.id}/sync/preview", headers=_h(scene["editor"]), json=body).status_code == 200
    assert client.post(f"{PROJECTS}/{p.id}/sync/preview", headers=_h(scene["reader"]), json=body).status_code == 403
    assert client.post(f"{PROJECTS}/{p.id}/sync/preview", headers=_h(scene["stranger"]), json=body).status_code == 404
    r = client.post(f"{PROJECTS}/{p.id}/import-archive/preview", headers=_h(scene["reader"]))
    assert r.status_code == 403


def test_читатель_экспортирует(client, db, scene):
    p = scene["p"]
    assert client.get("/api/v1/export", headers=_h(scene["reader"], p)).status_code == 200
    assert client.get("/api/v1/export", headers=_h(scene["stranger"], p)).status_code == 404


# ── Видимость ────────────────────────────────────────────────────────────────


def test_не_участник_и_visible_to_all(client, db, scene):
    p, stranger = scene["p"], scene["stranger"]
    # Скрытый проект для не-участника не существует ни в одной ручке.
    assert client.get(f"{PROJECTS}/{p.id}", headers=_h(stranger)).status_code == 404
    assert client.get(f"{PROJECTS}/{p.id}/members", headers=_h(stranger)).status_code == 404
    assert client.get(NODES, headers=_h(stranger, p)).json() == {"detail": "Проект не найден"}

    # Владелец открывает проект всем: не-участник получает чтение, но не правку.
    r = client.patch(f"{PROJECTS}/{p.id}", headers=_h(scene["owner"]), json={"visible_to_all": True})
    assert r.status_code == 200 and r.json()["visible_to_all"] is True
    card = client.get(f"{PROJECTS}/{p.id}", headers=_h(stranger)).json()
    assert card["my_role"] == "reader" and card["owner_username"] == "owner"
    assert client.get(NODES, headers=_h(stranger, p)).status_code == 200
    assert client.get(f"{PROJECTS}/{p.id}/members", headers=_h(stranger)).status_code == 200
    r = client.post(NODES, headers=_h(stranger, p), json={"name": "чужой"})
    assert r.status_code == 403 and r.json() == {"detail": "Нет прав на правку этого проекта"}

    # Видимость меняет только владелец; null значит «не менять», а не 500.
    r = client.patch(f"{PROJECTS}/{p.id}", headers=_h(scene["editor"]), json={"visible_to_all": False})
    assert r.status_code == 403 and r.json() == {"detail": "Это может только владелец проекта"}
    r = client.patch(f"{PROJECTS}/{p.id}", headers=_h(scene["owner"]), json={"visible_to_all": None})
    assert r.status_code == 200 and r.json()["visible_to_all"] is True


def test_чужой_архивный_404_а_не_409(client, db, scene):
    p = scene["p"]
    assert client.post(f"{PROJECTS}/{p.id}/archive", headers=_h(scene["owner"])).status_code == 200
    # Участник видит, что проект в архиве; чужой — что проекта нет.
    assert client.get(NODES, headers=_h(scene["reader"], p)).status_code == 409
    r = client.get(NODES, headers=_h(scene["stranger"], p))
    assert r.status_code == 404 and r.json() == {"detail": "Проект не найден"}
    assert client.post(f"{PROJECTS}/{p.id}/restore", headers=_h(scene["stranger"])).status_code == 404


def test_фильтр_списка_проектов(client, db, scene):
    hidden_archived = make_project(db, "Плёнка", owner=scene["stranger"])
    make_project(db, "Открытый", owner=scene["stranger"], visible_to_all=True)
    db.commit()
    client.post(f"{PROJECTS}/{hidden_archived.id}/archive", headers=_h(scene["stranger"]))

    def names(user: User, archived: bool = False) -> set[str]:
        r = client.get(PROJECTS, headers=_h(user), params={"archived": archived})
        assert r.status_code == 200
        return {x["name"] for x in r.json()}

    assert names(scene["owner"]) == {"Ярмарка", "Открытый"}
    assert names(scene["reader"]) == {"Ярмарка", "Открытый"}
    assert names(scene["stranger"]) == {"Открытый"}
    assert names(scene["stranger"], archived=True) == {"Плёнка"}
    assert names(scene["owner"], archived=True) == set()
    # Администратор видит всё в обеих вкладках.
    assert names(scene["admin"]) == {"Ярмарка", "Открытый"}
    assert names(scene["admin"], archived=True) == {"Плёнка"}

    # Карточки несут роль, владельца и видимость.
    cards = {x["name"]: x for x in client.get(PROJECTS, headers=_h(scene["reader"])).json()}
    assert cards["Ярмарка"]["my_role"] == "reader"
    assert cards["Открытый"]["my_role"] == "reader"
    assert cards["Открытый"]["owner_username"] == "stranger"
    assert cards["Открытый"]["visible_to_all"] is True
    assert cards["Ярмарка"]["visible_to_all"] is False
    admin_cards = {x["name"]: x for x in client.get(PROJECTS, headers=_h(scene["admin"])).json()}
    assert {c["my_role"] for c in admin_cards.values()} == {"owner"}


# ── Создание и копия ─────────────────────────────────────────────────────────


def test_создатель_становится_владельцем(client, db, scene):
    r = client.post(PROJECTS, headers=_h(scene["stranger"]), json={"name": "Новый"})
    assert r.status_code == 201
    card = r.json()
    assert card["my_role"] == "owner" and card["owner_username"] == "stranger"
    assert card["visible_to_all"] is False
    assert _roles(db, uuid.UUID(card["id"])) == {"stranger": "owner"}
    # Создавать проекты может только глобальный architect.
    assert client.post(PROJECTS, headers=_h(scene["editor"]), json={"name": "Нельзя"}).status_code == 403


def test_единый_импорт_делает_создателя_владельцем(db, scene):
    plan = build_unified_plan([("a.yaml", "nodes:\n  - name: Ярмарка\n".encode())])
    project, _ = apply_unified_plan(db, plan, {}, "Из файла", None, scene["stranger"].id)
    db.commit()
    assert _roles(db, project.id) == {"stranger": "owner"}


def test_копия_из_недоступного_источника(client, db, scene):
    p = scene["p"]
    r = client.post(PROJECTS, headers=_h(scene["stranger"]), json={"name": "К", "start": f"copy:{p.id}"})
    assert r.status_code == 404 and r.json() == {"detail": "Исходный проект не найден"}
    assert db.query(Project).filter(Project.name == "К").count() == 0

    # Читатель источника копировать может; копия его, участники источника не едут.
    r = client.post(PROJECTS, headers=_h(scene["reader"]), json={"name": "К", "start": f"copy:{p.id}"})
    assert r.status_code == 201, r.text
    copy = r.json()
    assert copy["object_count"] == 1 and copy["my_role"] == "owner"
    assert _roles(db, uuid.UUID(copy["id"])) == {"reader": "owner"}


# ── Участники ────────────────────────────────────────────────────────────────


def test_участники_список_и_правка(client, db, scene):
    p = scene["p"]
    url = f"{PROJECTS}/{p.id}/members"
    listed = client.get(url, headers=_h(scene["reader"])).json()
    assert [(m["username"], m["role"]) for m in listed] == [
        ("owner", "owner"),
        ("editor", "editor"),
        ("reader", "reader"),
    ]

    # Добавить, сменить роль, убрать.
    stranger = scene["stranger"]
    r = client.put(f"{url}/{stranger.id}", headers=_h(scene["owner"]), json={"role": "editor"})
    assert r.status_code == 200 and r.json() == {
        "user_id": str(stranger.id),
        "username": "stranger",
        "role": "editor",
    }
    assert client.post(NODES, headers=_h(stranger, p), json={"name": "x"}).status_code == 201
    r = client.put(f"{url}/{stranger.id}", headers=_h(scene["owner"]), json={"role": "reader"})
    assert r.json()["role"] == "reader"
    assert client.post(NODES, headers=_h(stranger, p), json={"name": "y"}).status_code == 403
    assert client.delete(f"{url}/{stranger.id}", headers=_h(scene["owner"])).status_code == 204
    assert client.get(NODES, headers=_h(stranger, p)).status_code == 404
    assert client.delete(f"{url}/{stranger.id}", headers=_h(scene["owner"])).status_code == 404

    # Роль owner так не выдаётся; несуществующего и заблокированного не добавить.
    assert client.put(f"{url}/{stranger.id}", headers=_h(scene["owner"]), json={"role": "owner"}).status_code == 422
    assert client.put(f"{url}/{uuid.uuid4()}", headers=_h(scene["owner"]), json={"role": "reader"}).status_code == 404
    r = client.put(f"{url}/{scene['blocked'].id}", headers=_h(scene["owner"]), json={"role": "reader"})
    assert r.status_code == 409 and r.json() == {"detail": "Пользователь заблокирован, добавить его нельзя"}


def test_владельца_нельзя_удалить_или_понизить(client, db, scene):
    p, owner = scene["p"], scene["owner"]
    url = f"{PROJECTS}/{p.id}/members/{owner.id}"
    for who in ("owner", "admin"):
        r = client.put(url, headers=_h(scene[who]), json={"role": "editor"})
        assert r.status_code == 409
        assert r.json() == {
            "detail": "Роль владельца не меняется. Чтобы сменить владельца, передайте владение"
        }
        r = client.delete(url, headers=_h(scene[who]))
        assert r.status_code == 409
        assert r.json() == {"detail": "Владельца нельзя убрать из проекта. Сначала передайте владение"}
    assert _roles(db, p.id)["owner"] == "owner"


# ── Передача владения ────────────────────────────────────────────────────────


def test_передача_владения(client, db, scene):
    p = scene["p"]
    url = f"{PROJECTS}/{p.id}/transfer"
    # Не владелец передать не может.
    assert client.post(url, headers=_h(scene["editor"]), json={"user_id": str(scene["editor"].id)}).status_code == 403

    # Владелец передаёт не-участнику: тот добавлен владельцем, прежний — редактор.
    r = client.post(url, headers=_h(scene["owner"]), json={"user_id": str(scene["stranger"].id)})
    assert r.status_code == 200, r.text
    assert r.json()["my_role"] == "editor" and r.json()["owner_username"] == "stranger"
    roles = _roles(db, p.id)
    assert roles == {"owner": "editor", "editor": "editor", "reader": "reader", "stranger": "owner"}
    assert list(roles.values()).count("owner") == 1

    # Прежний владелец больше не управляет проектом, но правит его.
    assert client.post(url, headers=_h(scene["owner"]), json={"user_id": str(scene["owner"].id)}).status_code == 403
    assert client.post(NODES, headers=_h(scene["owner"], p), json={"name": "z"}).status_code == 201

    # Передача участнику: читатель становится владельцем, владелец по-прежнему один.
    r = client.post(url, headers=_h(scene["stranger"]), json={"user_id": str(scene["reader"].id)})
    assert r.status_code == 200
    roles = _roles(db, p.id)
    assert roles["reader"] == "owner" and roles["stranger"] == "editor"
    assert list(roles.values()).count("owner") == 1


def test_передача_владения_отказы(client, db, scene):
    p = scene["p"]
    url = f"{PROJECTS}/{p.id}/transfer"
    r = client.post(url, headers=_h(scene["owner"]), json={"user_id": str(scene["blocked"].id)})
    assert r.status_code == 409
    assert r.json() == {"detail": "Пользователь заблокирован, передать ему проект нельзя"}
    r = client.post(url, headers=_h(scene["owner"]), json={"user_id": str(uuid.uuid4())})
    assert r.status_code == 404
    r = client.post(url, headers=_h(scene["owner"]), json={"user_id": str(scene["owner"].id)})
    assert r.status_code == 409
    assert _roles(db, p.id)["owner"] == "owner"


def test_администратор_передаёт_владение(client, db, scene):
    """У админа в любом проекте действующая роль owner — и передача ему доступна.
    Прежним владельцем при этом считается тот, кто им записан."""
    p = scene["p"]
    r = client.post(
        f"{PROJECTS}/{p.id}/transfer", headers=_h(scene["admin"]), json={"user_id": str(scene["editor"].id)}
    )
    assert r.status_code == 200
    assert r.json()["my_role"] == "owner"  # админ остаётся owner по признаку
    roles = _roles(db, p.id)
    assert roles["editor"] == "owner" and roles["owner"] == "editor"
    assert "admin" not in roles


# ── Глобальные роли внутри проекта не решают ─────────────────────────────────


def test_viewer_редактор_правит(client, db, scene):
    p, editor = scene["p"], scene["editor"]
    assert editor.role == "viewer"
    r = client.post(NODES, headers=_h(editor, p), json={"name": "от viewer"})
    assert r.status_code == 201, r.text
    node_id = r.json()["id"]
    r = client.patch(f"{NODES}/{node_id}", headers=_h(editor, p), json={"description": "правка"})
    assert r.status_code == 200, r.text


def test_architect_не_участник_не_правит(client, db, scene):
    p = scene["p"]
    for who in ("stranger", "reader"):  # оба глобально architect
        assert scene[who].role == "architect"
    assert client.post(NODES, headers=_h(scene["reader"], p), json={"name": "x"}).status_code == 403
    assert client.post(NODES, headers=_h(scene["stranger"], p), json={"name": "x"}).status_code == 404


# ── Список пользователей для выбора участника ────────────────────────────────


def test_users_только_активные_и_только_логин(client, db, scene):
    r = client.get("/api/v1/users", headers=_h(scene["reader"]))
    assert r.status_code == 200
    body = r.json()
    assert [u["username"] for u in body] == ["admin", "editor", "owner", "reader", "stranger"]
    assert set(body[0]) == {"id", "username"}
    assert client.get("/api/v1/users").status_code == 401
