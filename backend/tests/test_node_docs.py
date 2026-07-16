"""Тесты именованных схем логики узла (node_docs, этап 1 plan-agent-docs.md).

CRUD + скоуп по узлу/проекту, уникальность имени (409 человеком, не 500),
optimistic CAS контента (паттерн узла), мета в NodeResponse.docs, каскад при
удалении узла, снимок/restore удаления с доками, копия проекта с доками.
"""

import uuid

import pytest
from conftest import ensure_architect, ensure_project
from fastapi import HTTPException

from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.projects import copy_project_schema
from app.restore import build_deletion_snapshot, restore_from_snapshot
from app.routers.node_docs import create_doc, delete_doc, list_docs, update_doc
from app.routers.nodes import delete_node
from app.schemas.node import NodeResponse
from app.schemas.node_doc import NodeDocCreate, NodeDocUpdate


def _node(db, name, parent=None):
    n = Node(
        id=uuid.uuid4(),
        name=name,
        parent_id=parent.id if parent else None,
        project_id=ensure_project(db).id,
    )
    db.add(n)
    return n


def _create(db, node, **kw):
    return create_doc(
        node.id,
        NodeDocCreate(**kw),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )


def _patch(db, node, doc_id, **kw):
    return update_doc(
        node.id,
        doc_id,
        NodeDocUpdate(**kw),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )


def test_crud_round_trip(db):
    n = _node(db, "Сервис")
    db.commit()

    doc = _create(db, n, name="POST /orders", kind="operation", operation="POST /orders",
                  content="graph TD; A-->B")
    assert doc.version == 1 and doc.kind == "operation"

    docs = list_docs(n.id, db=db, project=ensure_project(db), _=ensure_architect(db))
    assert [d.name for d in docs] == ["POST /orders"]

    upd = _patch(db, n, doc.id, content="graph TD; A-->C", base_version=1)
    assert upd.version == 2 and upd.content == "graph TD; A-->C"

    delete_doc(n.id, doc.id, db=db, project=ensure_project(db), user=ensure_architect(db))
    assert db.query(NodeDoc).count() == 0


def test_duplicate_name_409(db):
    n = _node(db, "Сервис")
    db.commit()
    _create(db, n, name="Логика")
    with pytest.raises(HTTPException) as e:
        _create(db, n, name="Логика")
    assert e.value.status_code == 409

    other = _create(db, n, name="Воркер", kind="worker")
    with pytest.raises(HTTPException) as e:
        _patch(db, n, other.id, name="Логика")
    assert e.value.status_code == 409
    db.rollback()
    # На другом узле то же имя легально
    m = _node(db, "Другой")
    db.commit()
    assert _create(db, m, name="Логика").name == "Логика"


def test_cas_stale_version_409(db):
    n = _node(db, "Сервис")
    db.commit()
    doc = _create(db, n, name="Логика", content="graph TD; A")
    _patch(db, n, doc.id, content="graph TD; B", base_version=1)
    with pytest.raises(HTTPException) as e:
        _patch(db, n, doc.id, content="graph TD; C", base_version=1)
    assert e.value.status_code == 409
    db.rollback()
    assert db.get(NodeDoc, doc.id).content == "graph TD; B"
    # Без base_version — компенсация undo: пишется без проверки
    unfenced = _patch(db, n, doc.id, content="graph TD; D")
    assert unfenced.version == 3


def test_doc_scoped_to_node_404(db):
    a, b = _node(db, "A"), _node(db, "B")
    db.commit()
    doc = _create(db, a, name="Логика")
    with pytest.raises(HTTPException) as e:
        _patch(db, b, doc.id, content="x")
    assert e.value.status_code == 404


def test_meta_in_node_response(db):
    n = _node(db, "Сервис")
    db.commit()
    _create(db, n, name="Логика")
    _create(db, n, name="Воркер очереди", kind="worker")
    db.refresh(n)
    out = NodeResponse.model_validate(n, from_attributes=True)
    assert [(d.name, d.kind) for d in out.docs] == [("Воркер очереди", "worker"), ("Логика", "overview")]


def test_cascade_on_node_delete(db):
    root = _node(db, "Корень")
    child = _node(db, "Ребёнок", parent=root)
    db.commit()
    _create(db, root, name="Логика")
    _create(db, child, name="Логика")
    delete_node(root.id, db=db, project=ensure_project(db), user=ensure_architect(db))
    assert db.query(NodeDoc).count() == 0


def test_snapshot_restore_keeps_docs(db):
    root = _node(db, "Корень")
    child = _node(db, "Ребёнок", parent=root)
    db.commit()
    doc = _create(db, child, name="POST /pay", kind="operation", operation="POST /pay",
                  content="graph TD; X-->Y")

    doc_id, child_id = doc.id, child.id  # после commit удаления ORM-объекты detached

    snap = build_deletion_snapshot(db, root.id)
    assert [d.id for d in snap.node_docs] == [doc_id]

    delete_node(root.id, db=db, project=ensure_project(db), user=ensure_architect(db))
    assert db.query(NodeDoc).count() == 0

    restore_from_snapshot(db, snap, ensure_project(db).id)
    restored = db.get(NodeDoc, doc_id)
    assert restored is not None and restored.node_id == child_id
    assert restored.content == "graph TD; X-->Y" and restored.operation == "POST /pay"


def test_copy_project_copies_docs(db):
    from app.models.project import Project

    n = _node(db, "Сервис")
    db.commit()
    src_doc = _create(db, n, name="Логика", content="graph TD; A-->B")

    dst = Project(id=uuid.uuid4(), name="Копия")
    db.add(dst)
    db.flush()
    copy_project_schema(db, ensure_project(db).id, dst.id)
    db.commit()

    copied_node = db.query(Node).filter(Node.project_id == dst.id).one()
    copied = db.query(NodeDoc).filter(NodeDoc.node_id == copied_node.id).one()
    assert copied.id != src_doc.id
    assert (copied.name, copied.content) == ("Логика", "graph TD; A-->B")
