"""Статус страницы объекта «в работе» / «согласовано» (docs/tasks/page-status.md).

У листа статус хранится (nodes.approval) и меняется редактором проекта; у контейнера
он вычисляется: «согласовано», только когда согласованы ВСЕ дети (у детей-контейнеров —
по вычисленному). PATCH approval у контейнера — 422. Смена статуса — мета: двигает
meta_rev, а не graph_rev.
"""

import uuid

import pytest
from conftest import ensure_architect, ensure_project, make_project
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.approval import CONTAINER_DETAIL, effective_approvals
from app.auth import create_access_token
from app.database import get_db
from app.main import app
from app.models.node import Node
from app.models.project_member import ProjectMember
from app.models.user import User
from app.routers.nodes import (
    create_node,
    delete_node,
    get_children,
    get_deletion_snapshot,
    get_node,
    get_node_context_graph,
    get_root_graph,
    restore_nodes,
    update_node,
)
from app.schemas.node import NodeCreate, NodeResponse, NodeUpdate


def _node(db, name, parent=None, approval="in_progress", **fields):
    n = Node(
        id=uuid.uuid4(),
        name=name,
        parent_id=parent.id if parent else None,
        project_id=ensure_project(db).id,
        approval=approval,
        **fields,
    )
    db.add(n)
    return n


# ── Чистая функция ────────────────────────────────────────────────────────────


def test_лист_показывает_своё_значение():
    a, b = uuid.uuid4(), uuid.uuid4()
    # Записи чистой функции — (id, parent_id, хранимый approval).
    eff = effective_approvals([(a, None, "approved"), (b, None, "in_progress")])
    assert eff == {a: "approved", b: "in_progress"}


def test_контейнер_согласован_когда_согласованы_все_дети():
    c, x, y = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    # Хранимое значение контейнера не участвует: «в работе» у него не мешает.
    eff = effective_approvals([(c, None, "in_progress"), (x, c, "approved"), (y, c, "approved")])
    assert eff[c] == "approved"


def test_один_ребёнок_в_работе_держит_контейнер():
    c, x, y = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    # И наоборот: хранимое «согласовано» у контейнера не перебивает детей.
    eff = effective_approvals([(c, None, "approved"), (x, c, "approved"), (y, c, "in_progress")])
    assert eff[c] == "in_progress"


def test_внук_решает_статус_деда():
    g, p, k = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    # Порядок записей — снизу вверх и вперемешку: обход от него не зависит.
    rows = [(k, p, "in_progress"), (g, None, "approved"), (p, g, "approved")]
    eff = effective_approvals(rows)
    assert (eff[k], eff[p], eff[g]) == ("in_progress", "in_progress", "in_progress")
    rows[0] = (k, p, "approved")
    eff = effective_approvals(rows)
    assert (eff[k], eff[p], eff[g]) == ("approved", "approved", "approved")


def test_незнакомое_значение_считается_в_работе():
    a = uuid.uuid4()
    assert effective_approvals([(a, None, "что-то")]) == {a: "in_progress"}


def test_цикл_не_зацикливает_и_не_согласует():
    a, b = uuid.uuid4(), uuid.uuid4()
    eff = effective_approvals([(a, b, "approved"), (b, a, "approved")])
    assert eff == {a: "in_progress", b: "in_progress"}


def test_глубокая_цепочка_без_рекурсии():
    # Глубже предела рекурсии Python: обход итеративный.
    ids = [uuid.uuid4() for _ in range(5000)]
    rows = [(ids[0], None, "in_progress")] + [
        (ids[i], ids[i - 1], "in_progress") for i in range(1, len(ids))
    ]
    rows[-1] = (ids[-1], ids[-2], "approved")
    eff = effective_approvals(rows)
    assert eff[ids[0]] == "approved"


# ── Роутер узлов ──────────────────────────────────────────────────────────────


def test_новый_узел_в_работе(db):
    assert "approval" not in NodeCreate.model_fields
    node = create_node(
        NodeCreate(name="Сервис заказов"),
        db=db, project=ensure_project(db), user=ensure_architect(db),
    )
    out = NodeResponse.model_validate(node)
    assert (out.approval, out.approval_effective) == ("in_progress", "in_progress")


def test_patch_листа_согласует_и_двигает_только_мету(db):
    node = _node(db, "Сервис заказов")
    project = ensure_project(db)
    db.commit()
    g0, m0, v0 = project.graph_rev, project.meta_rev, node.version

    res = update_node(
        node.id, NodeUpdate(approval="approved", base_version=v0),
        db=db, project=project, user=ensure_architect(db),
    )
    out = NodeResponse.model_validate(res)
    assert (out.approval, out.approval_effective) == ("approved", "approved")
    assert out.version == v0 + 1
    db.refresh(project)
    assert project.graph_rev == g0
    assert project.meta_rev == m0 + 1


def test_patch_контейнера_422(db):
    parent = _node(db, "Заказы")
    _node(db, "Сервис заказов", parent=parent)
    project = ensure_project(db)
    db.commit()
    m0, v0 = project.meta_rev, parent.version

    with pytest.raises(HTTPException) as exc:
        update_node(
            parent.id, NodeUpdate(approval="approved"),
            db=db, project=project, user=ensure_architect(db),
        )
    assert exc.value.status_code == 422
    assert exc.value.detail == CONTAINER_DETAIL == "Статус контейнера складывается из детей"
    db.refresh(parent)
    db.refresh(project)
    assert (parent.approval, parent.version, project.meta_rev) == ("in_progress", v0, m0)


def test_patch_без_поля_статус_не_трогает(db):
    node = _node(db, "Сервис заказов", approval="approved")
    project = ensure_project(db)
    db.commit()
    res = update_node(
        node.id, NodeUpdate(role="сервис", technology="Python"),
        db=db, project=project, user=ensure_architect(db),
    )
    assert res.approval == "approved"
    assert res.approval_effective == "approved"


def test_children_и_родитель_по_вычисленному(db):
    parent = _node(db, "Заказы")
    a = _node(db, "Сервис заказов", parent=parent)
    b = _node(db, "База заказов", parent=parent, shape="database")
    # Внешний объект среди детей считается наравне с прочими (решение Р1).
    ext = _node(db, "Платёжный шлюз", parent=parent, is_external=True)
    project = ensure_project(db)
    db.commit()
    arch = ensure_architect(db)

    kids = get_children(parent.id, db=db, project=project, _=arch)
    assert {k.name: k.approval_effective for k in kids} == {
        "Сервис заказов": "in_progress",
        "База заказов": "in_progress",
        "Платёжный шлюз": "in_progress",
    }

    for n in (a, b):
        update_node(n.id, NodeUpdate(approval="approved"), db=db, project=project, user=arch)
    assert get_node(parent.id, db=db, project=project, _=arch).approval_effective == "in_progress"

    update_node(ext.id, NodeUpdate(approval="approved"), db=db, project=project, user=arch)
    kids = get_children(parent.id, db=db, project=project, _=arch)
    assert {k.approval_effective for k in kids} == {"approved"}
    out = NodeResponse.model_validate(get_node(parent.id, db=db, project=project, _=arch))
    assert (out.approval, out.approval_effective) == ("in_progress", "approved")


def test_граф_уровня_и_контекст_несут_вычисленный_статус(db):
    sys_ = _node(db, "Заказы")
    _node(db, "Сервис заказов", parent=sys_, approval="approved")
    leaf = _node(db, "Склад", approval="approved")
    project = ensure_project(db)
    db.commit()
    arch = ensure_architect(db)

    graph = get_root_graph(db=db, project=project, _=arch)
    by_name = {n.name: n for n in graph.nodes}
    assert by_name["Заказы"].approval_effective == "approved"
    assert by_name["Заказы"].approval == "in_progress"
    assert by_name["Склад"].approval_effective == "approved"

    ctx = get_node_context_graph(leaf.id, db=db, project=project, _=arch)
    assert {n.name: n.approval_effective for n in ctx.nodes}["Склад"] == "approved"


def test_откат_удаления_возвращает_статус(db):
    node = _node(db, "Сервис заказов", approval="approved")
    project = ensure_project(db)
    db.commit()
    arch = ensure_architect(db)

    snap = get_deletion_snapshot(node.id, db=db, project=project, _=arch)
    delete_node(node.id, db=db, project=project, user=arch)
    restore_nodes(snap, db=db, project=project, user=arch)
    assert db.get(Node, node.id).approval == "approved"


# ── Права и формат ответа через HTTP ─────────────────────────────────────────


@pytest.fixture()
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _h(user: User, project) -> dict[str, str]:
    token = create_access_token({"sub": user.username, "role": user.role})
    return {"Authorization": f"Bearer {token}", "X-Project-Id": str(project.id)}


def test_читатель_не_меняет_статус_а_ответ_контейнера_в_общем_формате(client, db):
    owner = ensure_architect(db)
    reader = User(id=uuid.uuid4(), username="reader", hashed_password="x", role="architect")
    db.add(reader)
    p = make_project(db, "Ярмарка", owner=owner)
    db.add(ProjectMember(project_id=p.id, user_id=reader.id, role="reader"))
    parent = Node(id=uuid.uuid4(), project_id=p.id, name="Заказы")
    leaf = Node(id=uuid.uuid4(), project_id=p.id, name="Сервис заказов", parent_id=parent.id)
    db.add_all([parent, leaf])
    db.commit()
    url = "/api/v1/nodes"

    r = client.patch(f"{url}/{leaf.id}", headers=_h(reader, p), json={"approval": "approved"})
    assert r.status_code == 403

    r = client.patch(f"{url}/{leaf.id}", headers=_h(owner, p), json={"approval": "approved"})
    assert r.status_code == 200, r.text
    assert (r.json()["approval"], r.json()["approval_effective"]) == ("approved", "approved")

    r = client.patch(f"{url}/{parent.id}", headers=_h(owner, p), json={"approval": "approved"})
    assert r.status_code == 422
    assert r.json() == {"detail": "Статус контейнера складывается из детей"}

    r = client.get(f"{url}/{parent.id}", headers=_h(reader, p))
    assert (r.json()["approval"], r.json()["approval_effective"]) == ("in_progress", "approved")

    # Значение вне словаря — 422 валидации контракта.
    r = client.patch(f"{url}/{leaf.id}", headers=_h(owner, p), json={"approval": "done"})
    assert r.status_code == 422
