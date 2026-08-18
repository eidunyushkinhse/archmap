"""Тесты правил контейнеров (эпик «Правила контейнеров»).

1) Алерт «у контейнера свои доки/спека» (grandfather): контейнер = service с
   детьми; алерт зажигается, если на нём остались собственные node_docs или
   openapi_spec. Атомарные узлы с доками и контейнеры без своих доков не алертятся.
2) Эндпоинт distribute_docs («Распределить по детям»): перенос собственных доков
   контейнера на непосредственных детей + перенос openapi_spec одному ребёнку.
   Валидации: цель не ребёнок, имя занято у ребёнка, спеки нет / у ребёнка уже есть.
"""

import uuid

import pytest
from conftest import ensure_architect, ensure_project
from fastapi import HTTPException

from app.alerts import compute_alerts
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.routers.node_docs import distribute_docs
from app.schemas.node import DistributeDocAssignment, DistributeDocsIn


def _node(db, name, parent=None, shape="service", openapi_spec=None):
    n = Node(
        id=uuid.uuid4(),
        name=name,
        parent_id=parent.id if parent else None,
        project_id=ensure_project(db).id,
        shape=shape,
        openapi_spec=openapi_spec,
    )
    db.add(n)
    return n


def _doc(db, node, name="Схема", kind="operation"):
    d = NodeDoc(id=uuid.uuid4(), node_id=node.id, name=name, kind=kind, content="graph TD\nA-->B")
    db.add(d)
    return d


# ── Алерт container_own_docs ────────────────────────────────────────────────

def test_alert_container_with_own_docs(db):
    root = _node(db, "Контейнер")
    _node(db, "Дети", parent=root)  # у root есть дети → контейнер
    _doc(db, root)  # свой док → grandfather
    db.commit()

    rep = compute_alerts(db, ensure_project(db).id)
    assert len(rep.container_own_docs) == 1
    a = rep.container_own_docs[0]
    assert a.node_id == root.id
    assert a.has_docs is True
    assert a.has_spec is False


def test_alert_container_with_spec_only(db):
    root = _node(db, "Контейнер", openapi_spec="openapi: 3.0.0")
    _node(db, "Дети", parent=root)
    db.commit()

    rep = compute_alerts(db, ensure_project(db).id)
    assert len(rep.container_own_docs) == 1
    assert rep.container_own_docs[0].has_spec is True
    assert rep.container_own_docs[0].has_docs is False


def test_alert_container_without_own_docs_is_silent(db):
    root = _node(db, "Контейнер")
    child = _node(db, "Дети", parent=root)
    _doc(db, child)  # док на ребёнке — норма, не grandfather
    db.commit()

    rep = compute_alerts(db, ensure_project(db).id)
    assert rep.container_own_docs == []


def test_alert_atomic_node_with_docs_is_not_container_alert(db):
    leaf = _node(db, "Атомарный")  # без детей
    _doc(db, leaf)
    db.commit()

    rep = compute_alerts(db, ensure_project(db).id)
    # Атомарный узел с доками — это норма (не контейнер), в container_own_docs не попадает.
    assert rep.container_own_docs == []


def test_alert_non_service_with_children_not_flagged(db):
    # По правилам контейнером становится только service; БД с детьми не алертится.
    db_node = _node(db, "База", shape="database")
    _node(db, "Вложенный", parent=db_node)
    _doc(db, db_node)
    db.commit()

    rep = compute_alerts(db, ensure_project(db).id)
    assert rep.container_own_docs == []


# ── distribute_docs ─────────────────────────────────────────────────────────

def test_distribute_moves_docs_to_child(db):
    root = _node(db, "Контейнер")
    c1 = _node(db, "Дитя-1", parent=root)
    c2 = _node(db, "Дитя-2", parent=root)
    d1 = _doc(db, root, name="Док-A")
    d2 = _doc(db, root, name="Док-B")
    db.commit()

    out = distribute_docs(
        root.id,
        DistributeDocsIn(doc_assignments=[
            DistributeDocAssignment(doc_id=d1.id, child_id=c1.id),
            DistributeDocAssignment(doc_id=d2.id, child_id=c2.id),
        ]),
        db=db, project=ensure_project(db), user=ensure_architect(db),
    )
    assert out.moved_docs == 2
    assert out.spec_moved is False
    db.expire_all()
    assert db.get(NodeDoc, d1.id).node_id == c1.id
    assert db.get(NodeDoc, d2.id).node_id == c2.id


def test_distribute_moves_spec_to_child(db):
    root = _node(db, "Контейнер", openapi_spec="openapi: 3.0.0")
    c1 = _node(db, "Дитя", parent=root)
    db.commit()

    out = distribute_docs(
        root.id,
        DistributeDocsIn(spec_child_id=c1.id),
        db=db, project=ensure_project(db), user=ensure_architect(db),
    )
    assert out.spec_moved is True
    db.expire_all()
    assert db.get(Node, c1.id).openapi_spec == "openapi: 3.0.0"
    assert db.get(Node, root.id).openapi_spec is None


def test_distribute_rejects_non_child_target(db):
    root = _node(db, "Контейнер")
    _node(db, "Дитя", parent=root)
    stranger = _node(db, "Чужой")  # не ребёнок root
    d = _doc(db, root, name="Док")
    db.commit()

    with pytest.raises(HTTPException) as e:
        distribute_docs(
            root.id,
            DistributeDocsIn(doc_assignments=[
                DistributeDocAssignment(doc_id=d.id, child_id=stranger.id),
            ]),
            db=db, project=ensure_project(db), user=ensure_architect(db),
        )
    assert e.value.status_code == 409


def test_distribute_rejects_name_conflict_at_child(db):
    root = _node(db, "Контейнер")
    c1 = _node(db, "Дитя", parent=root)
    _doc(db, c1, name="Док")  # у ребёнка уже есть схема с именем «Док»
    d = _doc(db, root, name="Док")  # у контейнера — с тем же именем
    db.commit()

    with pytest.raises(HTTPException) as e:
        distribute_docs(
            root.id,
            DistributeDocsIn(doc_assignments=[
                DistributeDocAssignment(doc_id=d.id, child_id=c1.id),
            ]),
            db=db, project=ensure_project(db), user=ensure_architect(db),
        )
    assert e.value.status_code == 409


def test_distribute_spec_conflict_at_child(db):
    root = _node(db, "Контейнер", openapi_spec="openapi: 3.0.0")
    c1 = _node(db, "Дитя", parent=root, openapi_spec="openapi: 3.1.0")  # уже есть спека
    db.commit()

    with pytest.raises(HTTPException) as e:
        distribute_docs(
            root.id,
            DistributeDocsIn(spec_child_id=c1.id),
            db=db, project=ensure_project(db), user=ensure_architect(db),
        )
    assert e.value.status_code == 409
