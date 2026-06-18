"""Тест эндпоинта потомков узла (GET /nodes/{id}/descendants).

Фиксирует контракт скоупленного выбора дальнего конца межуровневой связи:
возвращаются ВСЕ потомки на любой глубине, но НЕ сам узел и НЕ узлы вне поддерева.
"""

import uuid

import pytest
from conftest import ensure_project
from fastapi import HTTPException

from app.models.node import Node
from app.routers.nodes import get_descendants


def _node(db, name, parent=None):
    n = Node(
        id=uuid.uuid4(),
        name=name,
        parent_id=parent.id if parent else None,
        project_id=ensure_project(db).id,
    )
    db.add(n)
    return n


def test_descendants_returns_full_subtree_without_self(db):
    # A → A1 → A1a; A → A2. Снаружи X (не потомок).
    a = _node(db, "A")
    a1 = _node(db, "A1", a)
    a1a = _node(db, "A1a", a1)
    a2 = _node(db, "A2", a)
    _node(db, "X")
    db.commit()

    result = get_descendants(a.id, db=db, project=ensure_project(db))
    ids = {n.id for n in result}
    assert ids == {a1.id, a1a.id, a2.id}  # все потомки, без самого A и без X


def test_descendants_leaf_is_empty(db):
    leaf = _node(db, "leaf")
    db.commit()
    assert get_descendants(leaf.id, db=db, project=ensure_project(db)) == []


def test_descendants_missing_node_404(db):
    with pytest.raises(HTTPException) as ei:
        get_descendants(uuid.uuid4(), db=db, project=ensure_project(db))
    assert ei.value.status_code == 404
