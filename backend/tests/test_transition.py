"""Тесты «принять переход» (app/transition.py + эндпоинты /nodes/transition).

Операция необратима, поэтому здесь закрепляется главное:
  • ЧТО уедет вместе с выводимыми узлами — «попутные потери» считаются отдельно,
    их и показывает окно до подтверждения;
  • вложенные друг в друга выводимые узлы не двоятся в счёте;
  • курсор схемы (CAS): план, показанный пользователю, не применяется вслепую,
    если схему успели изменить.
"""

import uuid

import pytest
from conftest import ensure_architect, ensure_project
from fastapi import HTTPException

from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.routers.nodes import transition_apply, transition_preview
from app.schemas.node import TransitionApplyIn
from app.transition import build_transition


def _node(db, name, parent=None, status="existing", spec=None):
    n = Node(
        id=uuid.uuid4(),
        name=name,
        parent_id=parent.id if parent else None,
        project_id=ensure_project(db).id,
        status=status,
        openapi_spec=spec,
    )
    db.add(n)
    return n


def _preview(db):
    return transition_preview(
        db=db, project=ensure_project(db), _=ensure_architect(db)
    )


def _apply(db, base_graph_rev=None):
    return transition_apply(
        TransitionApplyIn(base_graph_rev=base_graph_rev),
        db=db, project=ensure_project(db), user=ensure_architect(db),
    )


def test_план_разделяет_удаление_и_повышение(db):
    root = _node(db, "Система")
    _node(db, "legacy", parent=root, status="deprecated")
    _node(db, "payments", parent=root, status="planned")
    _node(db, "orders", parent=root)
    db.commit()

    out = _preview(db)

    assert [d.name for d in out.delete] == ["legacy"]
    assert [p.name for p in out.promote] == ["payments"]
    assert out.is_noop is False


def test_попутные_потери_названы_поимённо(db):
    # Внутри выводимого контейнера живут узлы, которых устаревшими не помечали:
    # молча удалять их нельзя — окно показывает их до подтверждения.
    root = _node(db, "Система")
    legacy = _node(db, "legacy", parent=root, status="deprecated")
    _node(db, "legacy-api", parent=legacy)
    _node(db, "legacy-db", parent=legacy, status="planned")
    db.commit()

    out = _preview(db)

    assert out.delete_total == 3  # сам контейнер и двое детей
    assert sorted(c.name for c in out.collateral) == ["legacy-api", "legacy-db"]
    # Узел, который всё равно уедет, в «повысить» не попадает
    assert out.promote == []


def test_вложенные_выводимые_не_двоятся(db):
    root = _node(db, "Система")
    outer = _node(db, "outer", parent=root, status="deprecated")
    _node(db, "inner", parent=outer, status="deprecated")
    db.commit()

    out = _preview(db)

    assert [d.name for d in out.delete] == ["outer"]  # inner уедет каскадом
    assert out.delete_total == 2


def test_считаются_связи_доки_и_спеки(db):
    root = _node(db, "Система")
    legacy = _node(db, "legacy", parent=root, status="deprecated", spec="openapi: 3.0.0\\n")
    keep = _node(db, "orders", parent=root)
    db.add(NodeDoc(node_id=legacy.id, name="Схема", kind="overview", content="graph TD; A"))
    db.add(Edge(
        id=uuid.uuid4(), project_id=root.project_id, source_id=keep.id, target_id=legacy.id
    ))
    db.commit()

    out = _preview(db)

    assert (out.delete_edges, out.delete_docs, out.delete_specs) == (1, 1, 1)


def test_путь_объекта_показан_целиком(db):
    root = _node(db, "Система")
    box = _node(db, "billing", parent=root)
    _node(db, "legacy", parent=box, status="deprecated")
    db.commit()

    assert _preview(db).delete[0].path == "Система / billing / legacy"


def test_применение_удаляет_и_повышает(db):
    root = _node(db, "Система")
    legacy = _node(db, "legacy", parent=root, status="deprecated")
    _node(db, "legacy-api", parent=legacy)
    planned = _node(db, "payments", parent=root, status="planned")
    db.commit()
    planned_id = planned.id

    out = _apply(db)

    assert (out.deleted_nodes, out.promoted_nodes) == (2, 1)
    assert db.query(Node).filter(Node.name.in_(["legacy", "legacy-api"])).count() == 0
    assert db.get(Node, planned_id).status == "existing"


def test_повторное_применение_ничего_не_делает(db):
    # Фикспойнт: переход принят — второй раз принимать нечего.
    root = _node(db, "Система")
    _node(db, "legacy", parent=root, status="deprecated")
    db.commit()

    _apply(db)
    again = _apply(db)

    assert (again.deleted_nodes, again.promoted_nodes) == (0, 0)
    assert _preview(db).is_noop is True


def test_устаревший_курсор_схемы_отклоняется(db):
    root = _node(db, "Система")
    _node(db, "legacy", parent=root, status="deprecated")
    db.commit()

    with pytest.raises(HTTPException) as e:
        _apply(db, base_graph_rev=ensure_project(db).graph_rev + 1)

    assert e.value.status_code == 409
    assert db.query(Node).filter(Node.name == "legacy").count() == 1


def test_курсор_схемы_двигается_только_когда_есть_что_делать(db):
    _node(db, "Система")
    db.commit()
    project = ensure_project(db)
    rev0 = project.graph_rev

    _apply(db)

    db.refresh(project)
    assert project.graph_rev == rev0


def test_план_не_трогает_чужие_статусы(db):
    root = _node(db, "Система")
    _node(db, "orders", parent=root)
    db.commit()

    plan = build_transition(db, ensure_project(db))

    assert plan.is_noop and plan.delete_ids == set() and plan.promote == []
