"""Разделение курсоров изменений: graph_rev (схема) vs meta_rev (мета узла).

2026-08-01: поллинг страницы отличает «данные изменились в другой сессии»
(meta_rev: атрибуты узла, доки, openapi) от «схема изменилась» (graph_rev:
узлы/рёбра/раскладка). Правки меты больше НЕ двигают graph_rev — тост схемы
не всплывает от собственных правок доков/спек.
"""

import uuid

from conftest import ensure_architect, ensure_project

from app.models.node import Node
from app.routers.node_docs import create_doc, delete_doc, update_doc
from app.routers.nodes import update_node
from app.schemas.node import NodeUpdate
from app.schemas.node_doc import NodeDocCreate, NodeDocUpdate


def _node(db, name):
    n = Node(id=uuid.uuid4(), name=name, project_id=ensure_project(db).id)
    db.add(n)
    return n


def test_docs_mutation_bumps_meta_not_graph(db):
    node = _node(db, "A")
    project = ensure_project(db)
    db.commit()
    g0, m0 = project.graph_rev, project.meta_rev
    arch = ensure_architect(db)

    doc = create_doc(
        node.id,
        NodeDocCreate(name="Схема", kind="overview", operation=None, content="graph TD"),
        db=db, project=project, user=arch,
    )
    db.refresh(project)
    assert (project.graph_rev, project.meta_rev) == (g0, m0 + 1)

    update_doc(
        node.id, doc.id,
        NodeDocUpdate(content="graph TD\n  A-->B"),
        db=db, project=project, user=arch,
    )
    db.refresh(project)
    assert (project.graph_rev, project.meta_rev) == (g0, m0 + 2)

    delete_doc(node.id, doc.id, db=db, project=project, user=arch)
    db.refresh(project)
    assert (project.graph_rev, project.meta_rev) == (g0, m0 + 3)


def test_update_node_meta_only_bumps_meta(db):
    node = _node(db, "A")
    project = ensure_project(db)
    db.commit()
    g0, m0 = project.graph_rev, project.meta_rev

    # Роль/технология/openapi — мета страницы, не схема
    update_node(
        node.id,
        NodeUpdate(role="ядро", technology="Python", openapi_spec="openapi: 3.0.0"),
        db=db, project=project, user=ensure_architect(db),
    )
    db.refresh(project)
    assert project.graph_rev == g0
    assert project.meta_rev == m0 + 1


def test_update_node_structural_bumps_graph(db):
    node = _node(db, "A")
    project = ensure_project(db)
    db.commit()
    g0, m0 = project.graph_rev, project.meta_rev

    # Имя/форма видны на холсте — схема
    update_node(node.id, NodeUpdate(name="A2"), db=db, project=project, user=ensure_architect(db))
    db.refresh(project)
    assert project.graph_rev == g0 + 1
    assert project.meta_rev == m0


def test_update_node_mixed_bumps_both(db):
    node = _node(db, "A")
    project = ensure_project(db)
    db.commit()
    g0, m0 = project.graph_rev, project.meta_rev

    update_node(
        node.id,
        NodeUpdate(name="A2", role="ядро"),
        db=db, project=project, user=ensure_architect(db),
    )
    db.refresh(project)
    assert project.graph_rev == g0 + 1
    assert project.meta_rev == m0 + 1


def test_update_node_full_payload_unchanged_structural_bumps_meta_only(db):
    # Клиент шлёт ПОЛНЫЙ payload (name/shape присутствуют и не изменились):
    # курсор двигает фактическое изменение значения, а не наличие ключа —
    # иначе любая мета-правка bump-ала бы graph_rev (ложный тост схемы).
    node = _node(db, "A")
    project = ensure_project(db)
    db.commit()
    g0, m0 = project.graph_rev, project.meta_rev

    update_node(
        node.id,
        NodeUpdate(name="A", shape="service", role="ядро"),
        db=db, project=project, user=ensure_architect(db),
    )
    db.refresh(project)
    assert project.graph_rev == g0
    assert project.meta_rev == m0 + 1
