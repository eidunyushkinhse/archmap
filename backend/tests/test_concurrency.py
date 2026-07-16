"""Тесты конкурентных сессий, этап 0 (docs/plan-concurrency.md).

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

from app.models.node import Node
from app.routers.nodes import get_root_graph, relayout_level, relayout_root_level
from app.routers.views import save_view_layout
from app.schemas.node import ViewLayoutBatch, ViewLayoutPayload


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
