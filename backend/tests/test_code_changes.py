"""Сигнал CI о слиянии в репозитории (app/code_changes.py, замечание владельца 2026-11-21,
пункт 3): приём от токена «только сигнал CI», поиск проектов по источникам объектов, отказ
этому токену везде ещё, напоминание в рекомендациях (AL37) и его снятие обновлением из кода
и кнопкой «Документация актуальна»."""

import types
import uuid

import pytest
from conftest import make_project
from fastapi.testclient import TestClient

from app import code_changes, personal_tokens
from app.alerts import compute_alerts
from app.config import settings
from app.database import get_db
from app.main import app
from app.models.code_change import CodeChange
from app.models.node import Node
from app.models.user import User
from app.routers.projects import sync_apply
from app.schemas.project import SyncApplyIn

SIGNAL = "/api/v1/code-changes"
SHOP = "https://gitlab.example.org/market/shop.git"


@pytest.fixture()
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _node(db, project, name, ref=None, parent=None) -> Node:
    n = Node(id=uuid.uuid4(), project_id=project.id, name=name, source_ref=ref,
             parent_id=parent.id if parent else None)
    db.add(n)
    db.flush()
    return n


@pytest.fixture()
def s(db) -> types.SimpleNamespace:
    """«Ярмарка» (владелец архитектор): система, контейнер «Заказы» из репозитория shop и
    его компонент, «Оплаты» из другого репозитория. «Плёнка» видна всем и тоже берёт код из
    shop, но через ssh с портом. «Чужой» проект с тем же репозиторием архитектору не виден,
    архивный — пропускается."""
    s = types.SimpleNamespace()
    s.arch = User(id=uuid.uuid4(), username="arch", hashed_password="x", role="architect")
    s.other = User(id=uuid.uuid4(), username="other", hashed_password="x", role="architect")
    db.add_all([s.arch, s.other])
    db.flush()
    s.p = make_project(db, "Ярмарка", owner=s.arch)
    sys_ = _node(db, s.p, "Ярмарка")
    s.orders = _node(db, s.p, "Заказы", "git:gitlab.example.org/market/shop#orders", sys_)
    s.cart = _node(db, s.p, "Корзина", "git:gitlab.example.org/market/shop#orders/cart", s.orders)
    _node(db, s.p, "Оплаты", "git:gitlab.example.org/market/pay", sys_)
    s.film = make_project(db, "Плёнка", owner=s.other, visible_to_all=True)
    _node(db, s.film, "Лента", "git:gitlab.example.org:2222/market/shop")
    s.alien = make_project(db, "Чужой", owner=s.other)
    _node(db, s.alien, "Заказы", "git:gitlab.example.org/market/shop#orders")
    s.archived = make_project(db, "Архив", owner=s.arch)
    _node(db, s.archived, "Заказы", "git:gitlab.example.org/market/shop")
    s.archived.archived_at = s.archived.created_at
    db.commit()
    s.ci = personal_tokens.issue(db, s.arch, "CI", False, 90, ci_only=True).secret
    s.agent = personal_tokens.issue(db, s.arch, "Агент", False, 90).secret
    db.commit()
    return s


def _bearer(secret: str, project=None) -> dict[str, str]:
    h = {"Authorization": f"Bearer {secret}"}
    if project is not None:
        h["X-Project-Id"] = str(project.id)
    return h


def test_сигнал_находит_видимые_проекты_по_источнику(client, db, s):
    r = client.post(SIGNAL, headers=_bearer(s.ci), json={
        # учётные данные в адресе, как у CI_REPOSITORY_URL GitLab, не хранятся
        "repo": "https://gitlab-ci-token:secret@gitlab.example.org/market/shop.git",
        "commit": "ABCDEF1234567890", "branch": "main",
    })
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["repo"] == "gitlab.example.org/market/shop"
    # «Чужой» не виден владельцу токена, архивный пропущен, порт SSH у «Плёнки» не мешает
    assert [(p["name"], p["objects"]) for p in out["projects"]] == [("Плёнка", 1), ("Ярмарка", 2)]

    row = db.query(CodeChange).filter_by(project_id=s.p.id).one()
    assert (row.repo, row.merges, row.first_commit, row.branch) == (
        "gitlab.example.org/market/shop", 1, "abcdef1234567890", "main")
    assert "secret" not in row.repo


def test_слияния_копятся_в_одной_строке(client, db, s):
    for commit in ("aaaaaaa", "bbbbbbb", None):
        body = {"repo": SHOP} | ({"commit": commit} if commit else {})
        assert client.post(SIGNAL, headers=_bearer(s.ci), json=body).status_code == 200
    db.expire_all()
    row = db.query(CodeChange).filter_by(project_id=s.p.id).one()
    assert (row.merges, row.first_commit, row.last_commit) == (3, "aaaaaaa", None)


def test_репозиторий_без_объектов_не_роняет_ci(client, db, s):
    r = client.post(SIGNAL, headers=_bearer(s.ci), json={"repo": "git@github.com:org/none.git"})
    assert r.status_code == 200 and r.json() == {"repo": "github.com/org/none", "projects": []}
    assert db.query(CodeChange).count() == 0


def test_неверный_вход_сигнала(client, s):
    assert client.post(SIGNAL, headers=_bearer(s.ci), json={"repo": " "}).status_code == 422
    bad = client.post(SIGNAL, headers=_bearer(s.ci), json={"repo": SHOP, "commit": "main"})
    assert bad.status_code == 422


def test_токен_ci_больше_ничего_не_умеет(client, s):
    for method, path in (
        ("GET", "/api/v1/nodes"), ("GET", "/api/v1/projects"), ("GET", "/api/v1/tokens/current"),
        ("POST", "/api/v1/deletions"), ("DELETE", f"{SIGNAL}/{uuid.uuid4()}"),
    ):
        r = client.request(method, path, headers=_bearer(s.ci, s.p), json={})
        assert r.status_code == 403, (method, path, r.text)
        assert r.json()["detail"] == personal_tokens.CI_ONLY_DETAIL
    # обычный токен и сигнал умеет: он сильнее
    assert client.post(SIGNAL, headers=_bearer(s.agent), json={"repo": SHOP}).status_code == 200


def test_выпуск_токена_ci(client, db, s):
    from app.auth import create_access_token

    jwt = {"Authorization": f"Bearer {create_access_token({"sub": s.arch.username, "role": s.arch.role})}"}
    r = client.post("/api/v1/tokens", headers=jwt,
                    json={"name": "CI shop", "ci_only": True, "read_only": True})
    assert r.status_code == 201, r.text
    token = r.json()["token"]
    # «только чтение» у токена CI смысла не имеет и не ставится
    assert (token["ci_only"], token["read_only"]) == (True, False)
    viewer = User(id=uuid.uuid4(), username="viewer", hashed_password="x", role="viewer")
    db.add(viewer)
    db.commit()
    with pytest.raises(personal_tokens.TokenForbidden):
        personal_tokens.issue(db, viewer, "CI", False, 90, ci_only=True)


def test_сигнал_на_демо_стенде_закрыт(client, s, monkeypatch):
    from app.auth import create_access_token

    monkeypatch.setattr(settings, "demo_mode", True)
    jwt = {"Authorization": f"Bearer {create_access_token({"sub": s.arch.username, "role": s.arch.role})}"}
    assert client.post(SIGNAL, headers=jwt, json={"repo": SHOP}).status_code == 403


def test_рекомендация_называет_объекты_сверху_вниз(client, db, s):
    client.post(SIGNAL, headers=_bearer(s.ci), json={"repo": SHOP, "commit": "abcdef1"})
    [alert] = compute_alerts(db, s.p.id).code_changes
    assert alert.repo == "gitlab.example.org/market/shop" and alert.merges == 1
    assert [n.node_name for n in alert.nodes] == ["Заказы", "Корзина"]
    # объекты ушли из репозитория — напоминание не показывается
    s.orders.source_ref = None
    s.cart.source_ref = "host:cart"
    db.commit()
    assert compute_alerts(db, s.p.id).code_changes == []


def test_обновление_из_кода_снимает_напоминание(client, db, s):
    client.post(SIGNAL, headers=_bearer(s.ci), json={"repo": SHOP})
    client.post(SIGNAL, headers=_bearer(s.ci), json={"repo": "gitlab.example.org/market/pay"})
    run = (
        "nodes:\n- name: Ярмарка\n  element: system\n  children:\n"
        "  - name: Заказы\n    element: container\n"
        "    source: {repo: 'ssh://git@gitlab.example.org:2222/market/shop.git', path: orders}\n"
    )
    out = sync_apply(s.p.id, SyncApplyIn(contents=[run]), db=db, user=s.arch)
    assert out.code_changes_cleared == ["gitlab.example.org/market/shop"]
    db.expire_all()
    # напоминание другого репозитория осталось, у «Плёнки» своё
    assert [r.repo for r in db.query(CodeChange).filter_by(project_id=s.p.id)] == [
        "gitlab.example.org/market/pay"]
    assert db.query(CodeChange).filter_by(project_id=s.film.id).count() == 1


def test_документация_актуальна_снимает_вручную(client, db, s):
    from app.auth import create_access_token

    client.post(SIGNAL, headers=_bearer(s.ci), json={"repo": SHOP})
    row = db.query(CodeChange).filter_by(project_id=s.p.id).one()
    film = db.query(CodeChange).filter_by(project_id=s.film.id).one()
    jwt = {"Authorization": f"Bearer {create_access_token({"sub": s.arch.username, "role": s.arch.role})}",
           "X-Project-Id": str(s.p.id)}
    # чужое напоминание адресом своего проекта не снять
    assert client.delete(f"{SIGNAL}/{film.id}", headers=jwt).status_code == 404
    assert client.delete(f"{SIGNAL}/{row.id}", headers=jwt).status_code == 204
    db.expire_all()
    assert db.query(CodeChange).filter_by(project_id=s.p.id).count() == 0


def test_ключ_репозитория():
    assert code_changes.repo_key("git@GitLab.example.org:Market/Shop.git") == (
        "gitlab.example.org/market/shop")
    assert code_changes.repo_key("ssh://git@host:2222/a/b.git") == "host/a/b"
    assert code_changes.repo_key("https://host:8443/a/b") == "host/a/b"
    assert code_changes.repo_of_source("git:host:2222/a/b#svc") == "host/a/b"
    assert code_changes.repo_of_source("host:redis") is None
    assert code_changes.repo_key("  ") is None
