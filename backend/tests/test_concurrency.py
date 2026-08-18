"""Тесты конкурентных сессий, этап 0 (docs/archive/plan-concurrency.md).

Fence версии вида на PUT /views/{id}/layout: устаревший base_version → 409,
совпавший — применяется и бампает версию; без base_version — совместимость
(без проверки). Версия вида и курсор graph_rev отдаются в ответах PUT и в
GET graph. Relayout бампает fence (отставшие батчи отсекаются). Батч в
удалённый вид — 404 (раньше 500 на FK).
"""

import uuid

import pytest
from conftest import ensure_architect, ensure_project
from fastapi import HTTPException

from app.models.edge import Edge
from app.models.node import Node
from app.routers.edges import create_edge, delete_edge, update_edge
from app.routers.nodes import (
    create_node,
    delete_node,
    get_deletion_snapshot,
    get_root_graph,
    relayout_level,
    relayout_root_level,
    restore_nodes,
    update_node,
)
from app.routers.views import get_view_state, save_view_layout
from app.schemas.edge import EdgeCreate, EdgeUpdate
from app.schemas.node import NodeCreate, NodeUpdate, ViewLayoutBatch, ViewLayoutPayload


def _node(db, name, parent=None):
    n = Node(
        id=uuid.uuid4(),
        name=name,
        parent_id=parent.id if parent else None,
        project_id=ensure_project(db).id,
    )
    db.add(n)
    return n


def _put(db, view_id: str, items: dict, base_version: int | None = None):
    return save_view_layout(
        view_id,
        ViewLayoutBatch(items=items, base_version=base_version),
        db=db,
        project=ensure_project(db),
        _=ensure_architect(db),
    )


def test_fence_accepts_current_and_bumps(db):
    r1 = _node(db, "R1")
    db.commit()

    # Свежий вид: версии ещё нет (= 0), запись от неё принимается и бампает.
    res = _put(db, "root", {str(r1.id): ViewLayoutPayload(x=1, y=2)}, base_version=0)
    assert res.version == 1
    res2 = _put(db, "root", {str(r1.id): ViewLayoutPayload(x=3, y=4)}, base_version=1)
    assert res2.version == 2
    # Курсор проекта двигается каждой записью раскладки.
    assert res2.graph_rev == res.graph_rev + 1


def test_fence_rejects_stale(db):
    r1 = _node(db, "R1")
    db.commit()

    _put(db, "root", {str(r1.id): ViewLayoutPayload(x=1, y=2)}, base_version=0)
    with pytest.raises(HTTPException) as e:
        _put(db, "root", {str(r1.id): ViewLayoutPayload(x=9, y=9)}, base_version=0)
    assert e.value.status_code == 409
    # Отклонённый батч не применился и версию не сдвинул.
    graph = get_root_graph(db=db, project=ensure_project(db), _=ensure_architect(db))
    assert graph.layout[str(r1.id)].x == 1
    assert graph.version == 1


def test_fence_optional_for_unversioned_clients(db):
    r1 = _node(db, "R1")
    db.commit()

    _put(db, "root", {str(r1.id): ViewLayoutPayload(x=1, y=2)}, base_version=0)
    # Без base_version проверки нет (совместимость), но версия всё равно бампается.
    res = _put(db, "root", {str(r1.id): ViewLayoutPayload(x=5, y=6)})
    assert res.version == 2


def test_empty_batch_reports_but_keeps_version(db):
    r1 = _node(db, "R1")
    db.commit()

    res = _put(db, "root", {str(r1.id): ViewLayoutPayload(x=1, y=2)}, base_version=0)
    empty = _put(db, "root", {}, base_version=res.version)
    assert empty.version == res.version  # мир вида не менялся
    # Fence проверяется и у пустого батча — устаревшая сессия узнаёт о расхождении.
    with pytest.raises(HTTPException) as e:
        _put(db, "root", {}, base_version=0)
    assert e.value.status_code == 409


def test_dead_view_is_404_not_500(db):
    _node(db, "R1")
    db.commit()
    with pytest.raises(HTTPException) as e:
        _put(db, str(uuid.uuid4()), {"k": ViewLayoutPayload(x=1, y=1)})
    assert e.value.status_code == 404


def test_graph_carries_version_and_rev(db):
    # Пустой проект: поля присутствуют с нулевыми значениями.
    graph = get_root_graph(db=db, project=ensure_project(db), _=ensure_architect(db))
    assert graph.version == 0 and graph.graph_rev == 0

    r1 = _node(db, "R1")
    db.commit()
    res = _put(db, "root", {str(r1.id): ViewLayoutPayload(x=1, y=2)}, base_version=0)
    graph = get_root_graph(db=db, project=ensure_project(db), _=ensure_architect(db))
    assert graph.version == res.version == 1
    assert graph.graph_rev == res.graph_rev


def test_relayout_bumps_fence_root_and_level(db):
    c = _node(db, "C")
    c1 = _node(db, "C1", c)
    db.commit()

    _put(db, "root", {str(c.id): ViewLayoutPayload(x=1, y=2)}, base_version=0)
    relayout_root_level(db=db, project=ensure_project(db), _=ensure_architect(db))
    # Отставшая сессия (не видела перераскладку) отсекается fence'ом.
    with pytest.raises(HTTPException) as e:
        _put(db, "root", {str(c.id): ViewLayoutPayload(x=9, y=9)}, base_version=1)
    assert e.value.status_code == 409
    # Свежая версия (после ресинка) проходит.
    res = _put(db, "root", {str(c.id): ViewLayoutPayload(x=9, y=9)}, base_version=2)
    assert res.version == 3

    # То же для вида контейнера.
    _put(db, str(c.id), {str(c1.id): ViewLayoutPayload(x=1, y=1)}, base_version=0)
    relayout_level(c.id, db=db, project=ensure_project(db), _=ensure_architect(db))
    with pytest.raises(HTTPException) as e:
        _put(db, str(c.id), {str(c1.id): ViewLayoutPayload(x=2, y=2)}, base_version=1)
    assert e.value.status_code == 409


# ── CAS смысловых правок (узлы/связи) ──────────────────────────────────────


def _patch_node(db, node_id, **kwargs):
    return update_node(
        node_id,
        NodeUpdate(**kwargs),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )


def test_node_patch_cas(db):
    n = _node(db, "N")
    db.commit()
    assert n.version == 1

    updated = _patch_node(db, n.id, name="N2", base_version=1)
    assert updated.version == 2 and updated.name == "N2"
    # Та же (теперь устаревшая) версия второй раз — 409, правка не применяется.
    with pytest.raises(HTTPException) as e:
        _patch_node(db, n.id, openapi_spec="openapi: 3.0.0", base_version=1)
    assert e.value.status_code == 409
    db.rollback()
    assert db.get(Node, n.id).openapi_spec is None
    # Без base_version — совместимость/компенсации undo: пишется без проверки.
    unfenced = _patch_node(db, n.id, name="N3")
    assert unfenced.version == 3


def test_edge_patch_cas(db):
    a, b = _node(db, "A"), _node(db, "B")
    db.commit()
    e = Edge(id=uuid.uuid4(), source_id=a.id, target_id=b.id, project_id=ensure_project(db).id)
    db.add(e)
    db.commit()

    upd = update_edge(
        e.id,
        EdgeUpdate(label="ok", base_version=1),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )
    assert upd.version == 2
    with pytest.raises(HTTPException) as exc:
        update_edge(
            e.id,
            EdgeUpdate(label="stale", base_version=1),
            db=db,
            project=ensure_project(db),
            user=ensure_architect(db),
        )
    assert exc.value.status_code == 409


def test_edge_channel_patch_cas(db):
    """Канал брокера (Ф3) правится тем же PATCH и тем же CAS, что остальные поля
    связи: отдельного пути записи у него нет, и устаревшая правка канала обязана
    получить 409, а не затереть чужую."""
    сервис, брокер = _node(db, "orders"), _node(db, "Kafka")
    db.commit()
    e = Edge(
        id=uuid.uuid4(), source_id=сервис.id, target_id=брокер.id,
        project_id=ensure_project(db).id,
    )
    db.add(e)
    db.commit()

    upd = update_edge(
        e.id,
        EdgeUpdate(channel="orders.created", base_version=1),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )
    assert (upd.channel, upd.version) == ("orders.created", 2)

    with pytest.raises(HTTPException) as exc:
        update_edge(
            e.id,
            EdgeUpdate(channel="orders.v2", base_version=1),
            db=db,
            project=ensure_project(db),
            user=ensure_architect(db),
        )
    assert exc.value.status_code == 409
    db.refresh(e)
    assert e.channel == "orders.created"

    # Очистка поля (пользователь стёр инпут) — обычная правка, а не «не трогать».
    cleared = update_edge(
        e.id,
        EdgeUpdate(channel=None, base_version=2),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )
    assert cleared.channel is None


# ── Бампы fence структурными мутациями ─────────────────────────────────────


def test_create_and_delete_bump_root_fence(db):
    r1 = _node(db, "R1")
    db.commit()
    _put(db, "root", {str(r1.id): ViewLayoutPayload(x=1, y=1)}, base_version=0)  # → v1

    created = create_node(
        NodeCreate(name="Новый", pos_x=5, pos_y=5),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )  # членство корня изменилось → v2
    with pytest.raises(HTTPException) as e:
        _put(db, "root", {str(r1.id): ViewLayoutPayload(x=2, y=2)}, base_version=1)
    assert e.value.status_code == 409
    res = _put(db, "root", {str(r1.id): ViewLayoutPayload(x=2, y=2)}, base_version=2)
    assert res.version == 3

    delete_node(created.id, db=db, project=ensure_project(db), user=ensure_architect(db))  # → v4
    with pytest.raises(HTTPException) as e:
        _put(db, "root", {str(r1.id): ViewLayoutPayload(x=3, y=3)}, base_version=3)
    assert e.value.status_code == 409


def test_delete_bumps_guest_views(db):
    a = _node(db, "A")
    c = _node(db, "C")
    _node(db, "C1", c)
    db.commit()

    # Гостевая позиция узла A на виде контейнера C.
    _put(db, str(c.id), {str(a.id): ViewLayoutPayload(x=7, y=7)}, base_version=0)  # → v1
    delete_node(a.id, db=db, project=ensure_project(db), user=ensure_architect(db))
    # Вид C потерял строку гостя — его fence сдвинут (v2), отставший батч отсечён.
    with pytest.raises(HTTPException) as e:
        _put(db, str(c.id), {"k": ViewLayoutPayload(x=1, y=1)}, base_version=1)
    assert e.value.status_code == 409


def test_parent_move_bumps_both_views(db):
    c = _node(db, "C")
    d = _node(db, "D")
    x = _node(db, "X", c)
    db.commit()

    _put(db, str(c.id), {str(x.id): ViewLayoutPayload(x=1, y=1)}, base_version=0)  # C → v1
    _put(db, str(d.id), {"seed": ViewLayoutPayload(x=1, y=1)}, base_version=0)  # D → v1
    _patch_node(db, x.id, parent_id=d.id)
    for view in (c, d):  # оба вида сдвинуты переносом → v2
        with pytest.raises(HTTPException) as e:
            _put(db, str(view.id), {"k": ViewLayoutPayload(x=2, y=2)}, base_version=1)
        assert e.value.status_code == 409


def test_restore_bumps_fence(db):
    r1 = _node(db, "R1")
    db.commit()
    _put(db, "root", {str(r1.id): ViewLayoutPayload(x=1, y=1)}, base_version=0)  # → v1

    snapshot = get_deletion_snapshot(
        r1.id, db=db, project=ensure_project(db), _=ensure_architect(db)
    )
    delete_node(r1.id, db=db, project=ensure_project(db), user=ensure_architect(db))  # → v2
    restore_nodes(snapshot, db=db, project=ensure_project(db), user=ensure_architect(db))  # → v3
    res = _put(db, "root", {str(r1.id): ViewLayoutPayload(x=2, y=2)}, base_version=3)
    assert res.version == 4


# ── Поллинг: /state и graph_rev ────────────────────────────────────────────


def test_state_endpoint_and_graph_rev_monotonic(db):
    state = get_view_state("root", db=db, project=ensure_project(db), _=ensure_architect(db))
    assert state.version == 0 and state.graph_rev == 0
    # Курсор процессов (Д9) отдаётся тем же лёгким опросом — его поллит страница
    # процесса; правки узлов/раскладки ниже его не двигают.
    assert state.process_rev == 0

    revs = [0]

    def snap():
        s = get_view_state("root", db=db, project=ensure_project(db), _=ensure_architect(db))
        revs.append(s.graph_rev)

    a = create_node(
        NodeCreate(name="A"), db=db, project=ensure_project(db), user=ensure_architect(db)
    )
    snap()
    b = create_node(
        NodeCreate(name="B"), db=db, project=ensure_project(db), user=ensure_architect(db)
    )
    snap()
    _put(db, "root", {str(a.id): ViewLayoutPayload(x=1, y=1)})
    snap()
    e = create_edge(
        EdgeCreate(source_id=a.id, target_id=b.id),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )
    snap()
    update_edge(
        e.id, EdgeUpdate(label="l"), db=db, project=ensure_project(db), user=ensure_architect(db)
    )
    snap()
    delete_edge(e.id, db=db, project=ensure_project(db), user=ensure_architect(db))
    snap()
    _patch_node(db, a.id, name="A2")
    snap()
    delete_node(b.id, db=db, project=ensure_project(db), user=ensure_architect(db))
    snap()

    # Каждая мутация двигает курсор строго вверх (в т.ч. раскладка — V48).
    assert revs == sorted(revs) and len(set(revs)) == len(revs)
