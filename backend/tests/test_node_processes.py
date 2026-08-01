"""Тесты GET /nodes/{id}/processes — процессы с участием узла или его поддерева
(секция «Участвует в процессах» страницы объекта, single-schema).

Участие поддерева: участник-потомок считает процесс участием своего предка —
страница контейнера показывает процессы всех его потомков. Форма ответа — тот же
ProcessListItem, что у GET /processes (счётчик сообщений, статусы участников).
Участники/сообщения создаются роутерными хелперами (как в test_processes).
"""

import uuid

import pytest
from conftest import ensure_architect, ensure_project
from fastapi import HTTPException

from app.models.business_process import BusinessProcess
from app.models.node import Node
from app.routers.nodes import get_node_processes
from app.routers.processes import add_participant, create_message
from app.schemas.process import MessageCreate, ParticipantCreate


def _node(db, name, parent=None):
    n = Node(
        id=uuid.uuid4(),
        name=name,
        parent_id=parent.id if parent else None,
        project_id=ensure_project(db).id,
    )
    db.add(n)
    return n


def _process(db, name):
    p = BusinessProcess(id=uuid.uuid4(), name=name, project_id=ensure_project(db).id)
    db.add(p)
    return p


def _part(db, project, proc, node, order=0):
    return add_participant(
        proc.id,
        ParticipantCreate(node_id=node.id, order=order),
        db=db,
        project=project,
        user=ensure_architect(db),
    )


def test_subtree_participation(db, project):
    # A ⊃ A1; B — сосед. P1 с участником A1 (глубокий) → виден на странице A и A1;
    # P2 с участником B → на странице A не виден; P3 без участников — нигде.
    a = _node(db, "A")
    a1 = _node(db, "A1", a)
    b = _node(db, "B")
    p1 = _process(db, "P1")
    p2 = _process(db, "P2")
    _process(db, "P3")
    db.commit()
    _part(db, project, p1, a1)
    _part(db, project, p2, b)

    assert [p.name for p in get_node_processes(a.id, db=db, project=project, _=None)] == ["P1"]
    assert [p.name for p in get_node_processes(a1.id, db=db, project=project, _=None)] == ["P1"]
    assert [p.name for p in get_node_processes(b.id, db=db, project=project, _=None)] == ["P2"]


def test_list_item_shape_counts_and_statuses(db, project):
    # Та же форма, что у GET /processes: счётчик сообщений и статусы участников.
    a = _node(db, "A")
    b = _node(db, "B")
    b.status = "planned"
    p = _process(db, "P")
    db.commit()
    pa = _part(db, project, p, a, order=0)
    _part(db, project, p, b, order=1)
    # Самосообщение (внутренняя операция, без канала C4) — даёт message_count=1.
    create_message(
        p.id,
        MessageCreate(leg="forward", from_participant_id=pa.id, to_participant_id=pa.id, order=0),
        db=db,
        project=project,
        user=ensure_architect(db),
    )

    got = get_node_processes(a.id, db=db, project=project, _=None)
    assert len(got) == 1
    item = got[0]
    assert item.id == p.id
    assert item.name == "P"
    assert item.message_count == 1
    assert item.statuses == ["existing", "planned"]


def test_no_participation_empty_list(db, project):
    a = _node(db, "A")
    _process(db, "P")  # процесс без участников
    db.commit()
    assert get_node_processes(a.id, db=db, project=project, _=None) == []


def test_missing_node_404(db, project):
    with pytest.raises(HTTPException) as exc:
        get_node_processes(uuid.uuid4(), db=db, project=project, _=None)
    assert exc.value.status_code == 404
