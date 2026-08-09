"""Тесты применения синхронизации (app/sync_apply.py + POST /sync/apply, Фаза 2).

Главное здесь — не «записалось ли», а ЧТО ПЕРЕЖИЛО запись: схемы логики, спеки,
раскладка и ручные правки. Ради этого синк и делался вместо пересоздания проекта.
Плюс сквозной фикспойнт: применили прогон → превью на том же входе пусто.
"""

import uuid

import pytest
from conftest import ensure_architect
from fastapi import HTTPException

from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.view_layout import ViewLayoutItem
from app.routers.projects import create_project, sync_apply, sync_preview
from app.schemas.project import ProjectCreate, SyncApplyIn, SyncPreviewIn

RUN = """
nodes:
  - name: Система
    children:
      - name: payments
        role: сервис
        source: {repo: github.com/org/payments, host: payments}
      - name: orders
        source: {repo: github.com/org/orders, host: orders}
      - name: orders-db
        shape: database
        source: {host: orders-db}
edges:
  - {from: orders, to: payments, label: платит}
  - {from: orders, to: orders-db, label: хранит}
"""

# Тот же прогон месяц спустя: payments переименован в billing, добавился cache.
NEXT_RUN = """
nodes:
  - name: Система
    children:
      - name: billing
        role: сервис
        source: {repo: github.com/org/payments, host: payments}
      - name: orders
        source: {repo: github.com/org/orders, host: orders}
      - name: orders-db
        shape: database
        source: {host: orders-db}
      - name: cache
        source: {host: cache}
edges:
  - {from: orders, to: billing, label: платит}
  - {from: orders, to: orders-db, label: хранит}
  - {from: billing, to: cache, label: кэширует}
"""


def _project(db, yaml_text: str = RUN):
    user = ensure_architect(db)
    p = create_project(
        ProjectCreate(name="Из репозитория", start="import", import_yaml=yaml_text),
        db=db, user=user,
    )
    return p, user


def _node(db, project_id, name: str) -> Node:
    return db.query(Node).filter(Node.project_id == project_id, Node.name == name).one()


def test_apply_creates_and_updates(db):
    """Новый узел и новая связь появляются; переименование по умолчанию не
    применяется, но узел опознан якорем — не создан заново."""
    p, user = _project(db)
    before = _node(db, p.id, "payments").id

    out = sync_apply(p.id, SyncApplyIn(contents=[NEXT_RUN]), db=db, _user=user)

    assert out.created_nodes == ["Система / cache"]
    assert out.created_edges == ["Система / billing → Система / cache"]
    assert out.skipped == []
    # Тот же узел, а не пересозданный: id сохранился, имя не тронуто политикой.
    assert _node(db, p.id, "payments").id == before
    assert db.query(Node).filter(Node.project_id == p.id).count() == 5


def test_apply_preserves_docs_specs_and_layout(db):
    """ГЛАВНОЕ обещание синка: обновление не теряет нажитое поверх импорта."""
    p, user = _project(db)
    payments = _node(db, p.id, "payments")
    db.add(NodeDoc(id=uuid.uuid4(), node_id=payments.id, name="Оплата", kind="обзор", content="graph TD;A-->B"))
    payments.openapi_spec = "openapi: 3.0.0"
    db.add(
        ViewLayoutItem(
            project_id=p.id, view_id=None, item_id=str(payments.id), payload={"x": 120, "y": 340}
        )
    )
    db.commit()

    sync_apply(p.id, SyncApplyIn(contents=[NEXT_RUN], update_names=True), db=db, _user=user)

    renamed = _node(db, p.id, "billing")  # имя обновилось по политике
    assert renamed.id == payments.id
    assert renamed.openapi_spec == "openapi: 3.0.0"
    assert [d.name for d in renamed.docs] == ["Оплата"]
    layout = (
        db.query(ViewLayoutItem)
        .filter(ViewLayoutItem.project_id == p.id, ViewLayoutItem.item_id == str(payments.id))
        .one()
    )
    assert layout.payload == {"x": 120, "y": 340}


def test_apply_is_fixpoint(db):
    """Сквозной критерий фазы: применили — превью на том же входе пусто."""
    p, user = _project(db)
    sync_apply(p.id, SyncApplyIn(contents=[NEXT_RUN]), db=db, _user=user)

    again = sync_preview(p.id, SyncPreviewIn(contents=[NEXT_RUN]), db=db, _user=user)
    assert again.is_noop, again.summary

    # И повторное применение ничего не делает.
    twice = sync_apply(p.id, SyncApplyIn(contents=[NEXT_RUN]), db=db, _user=user)
    assert (twice.created_nodes, twice.updated_nodes, twice.created_edges) == ([], [], [])


def test_apply_never_deletes(db):
    """Пропавший узел не удаляется; по политике помечается deprecated — наравне с
    узлом, заведённым руками (решение пользователя 2026-08-07: так прозрачнее)."""
    p, user = _project(db)
    manual = Node(id=uuid.uuid4(), project_id=p.id, name="ручной", parent_id=_node(db, p.id, "Система").id)
    db.add(manual)
    db.commit()
    without_db = RUN.replace(
        "      - name: orders-db\n        shape: database\n        source: {host: orders-db}\n", ""
    ).replace("  - {from: orders, to: orders-db, label: хранит}\n", "")

    out = sync_apply(
        p.id, SyncApplyIn(contents=[without_db], mark_missing_deprecated=True), db=db, _user=user
    )

    assert sorted(out.deprecated_nodes) == ["Система / orders-db", "Система / ручной"]
    assert _node(db, p.id, "orders-db").status == "deprecated"  # не удалён
    assert db.query(Edge).filter(Edge.project_id == p.id).count() == 2  # связи целы


def test_apply_bumps_graph_rev_and_guards_stale_preview(db):
    """Курсор схемы двигается (поллинг чужих сессий), а применение с устаревшим
    курсором отклоняется — пользователь не пишет вслепую то, чего не видел."""
    p, user = _project(db)
    preview = sync_preview(p.id, SyncPreviewIn(contents=[NEXT_RUN]), db=db, _user=user)
    rev_before = preview.graph_rev

    out = sync_apply(
        p.id, SyncApplyIn(contents=[NEXT_RUN], base_graph_rev=rev_before), db=db, _user=user
    )
    assert out.graph_rev > rev_before

    with pytest.raises(HTTPException) as exc:
        sync_apply(
            p.id, SyncApplyIn(contents=[NEXT_RUN], base_graph_rev=rev_before), db=db, _user=user
        )
    assert exc.value.status_code == 409


def test_apply_rejects_broken_yaml_and_unknown_project(db):
    p, user = _project(db)
    with pytest.raises(HTTPException) as exc:
        sync_apply(p.id, SyncApplyIn(contents=["nodes: [oops"]), db=db, _user=user)
    assert exc.value.status_code == 400

    with pytest.raises(HTTPException) as exc:
        sync_apply(uuid.uuid4(), SyncApplyIn(contents=[RUN]), db=db, _user=user)
    assert exc.value.status_code == 404
