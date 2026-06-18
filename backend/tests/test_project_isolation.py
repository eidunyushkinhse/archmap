"""Изоляция проектов: данные одного проекта недоступны из другого.

Критерий приёмки #2: ни узлы, ни сквозные связи, ни поиск, ни граф не «текут»
между проектами. Дёргаем функции роутера напрямую, передавая разные Project.
"""

import uuid

import pytest
from fastapi import HTTPException

from app.models.node import Node
from app.models.project import Project
from app.routers.edges import create_edge
from app.routers.nodes import (
    create_node,
    get_node,
    get_root_graph,
    list_all_nodes,
    search_nodes,
)
from app.schemas.edge import EdgeCreate
from app.schemas.node import NodeCreate


def _project(db, name) -> Project:
    p = Project(id=uuid.uuid4(), name=name)
    db.add(p)
    db.commit()
    return p


def _arch(db):
    from conftest import ensure_architect

    return ensure_architect(db)


def _node(db, project, name) -> Node:
    n = Node(id=uuid.uuid4(), name=name, project_id=project.id)
    db.add(n)
    db.commit()
    return n


def test_node_of_other_project_is_not_accessible(db):
    p1, p2 = _project(db, "P1"), _project(db, "P2")
    n1 = _node(db, p1, "Только в P1")

    # Тот же узел из своего проекта виден, из чужого — 404.
    assert get_node(n1.id, db=db, project=p1).id == n1.id
    with pytest.raises(HTTPException) as ei:
        get_node(n1.id, db=db, project=p2)
    assert ei.value.status_code == 404


def test_root_graph_and_listings_are_scoped(db):
    p1, p2 = _project(db, "P1"), _project(db, "P2")
    _node(db, p1, "Узел P1")
    _node(db, p2, "Узел P2-альфа")
    _node(db, p2, "Узел P2-бета")

    # Корневой граф каждого проекта содержит только свои узлы.
    g1 = get_root_graph(db=db, project=p1)
    assert [n.name for n in g1.nodes] == ["Узел P1"]
    g2 = get_root_graph(db=db, project=p2)
    assert {n.name for n in g2.nodes} == {"Узел P2-альфа", "Узел P2-бета"}

    # list_all и поиск тоже скоуплены.
    assert {n.name for n in list_all_nodes(db=db, project=p1)} == {"Узел P1"}
    assert [n.name for n in search_nodes(q="P2", db=db, project=p1)] == []
    assert {n.name for n in search_nodes(q="P2", db=db, project=p2)} == {
        "Узел P2-альфа",
        "Узел P2-бета",
    }


def test_create_node_under_other_projects_parent_rejected(db):
    p1, p2 = _project(db, "P1"), _project(db, "P2")
    parent_p1 = _node(db, p1, "Родитель в P1")
    user = _arch(db)

    # Пытаемся создать узел в p2 с родителем из p1 — родитель «не найден» в p2.
    with pytest.raises(HTTPException) as ei:
        create_node(
            NodeCreate(name="Чужой ребёнок", parent_id=parent_p1.id),
            db=db,
            project=p2,
            user=user,
        )
    assert ei.value.status_code == 404


def test_create_edge_across_projects_rejected(db):
    p1, p2 = _project(db, "P1"), _project(db, "P2")
    n1 = _node(db, p1, "В P1")
    n2 = _node(db, p2, "В P2")
    user = _arch(db)

    # Связь между узлами разных проектов: цель не найдена в проекте источника.
    with pytest.raises(HTTPException) as ei:
        create_edge(
            EdgeCreate(source_id=n1.id, target_id=n2.id),
            db=db,
            project=p1,
            user=user,
        )
    assert ei.value.status_code == 404
