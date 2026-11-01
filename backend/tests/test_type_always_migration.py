"""Миграция «тип выбран всегда» (alembic 50fc1576936a, решение владельца 2026-11-01,
docs/tasks/type-always.md): каждый сервис вне контейнера с NULL получает то, что до решения
давал действующий элемент, — систему у сервиса с вложенными и у внешнего листа, контейнер у
своего листа. Компоненты, база, брокер и «Пользователь» остаются с NULL; повторный запуск
ничего не меняет.

Функция обхода живёт в модуле миграции (миграции не импортируют app.*) и зовётся здесь на
SQLite тестов поверх тех же строк nodes, что пишет приложение.
"""

import importlib.util
import uuid
from pathlib import Path

from conftest import ensure_project

from app.element_marks import elements_for_project
from app.models.node import Node

_PATH = next((Path(__file__).parents[1] / "alembic" / "versions").glob("50fc1576936a_*.py"))
_spec = importlib.util.spec_from_file_location("type_always_migration", _PATH)
assert _spec is not None and _spec.loader is not None
migration = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(migration)


def _node(db, project, name, parent=None, shape="service", element=None, external=False) -> Node:
    n = Node(
        id=uuid.uuid4(), project_id=project.id, name=name, shape=shape, element=element,
        parent_id=parent.id if parent else None, is_external=external,
    )
    db.add(n)
    db.flush()
    return n


def _tree(db):
    """Система с детьми, свой лист, внешний лист, компонент внутри контейнера, база
    внутри системы, «Пользователь» и сервис, у которого внутри один «Пользователь»."""
    project = ensure_project(db)
    shop = _node(db, project, "Торговля")
    orders = _node(db, project, "orders", shop)
    api = _node(db, project, "api", orders)
    billing = _node(db, project, "billing", shop, element="container")
    worker = _node(db, project, "worker", billing)
    handler = _node(db, project, "handler", worker)
    db_node = _node(db, project, "orders-db", shop, shape="database")
    stripe = _node(db, project, "Stripe", external=True)
    buyer = _node(db, project, "Покупатель", shape="person")
    lonely = _node(db, project, "lonely")
    holder = _node(db, project, "holder")
    _node(db, project, "inner-person", holder, shape="person")
    db.commit()
    return project, {
        "shop": shop, "orders": orders, "api": api, "billing": billing, "worker": worker,
        "handler": handler, "db": db_node, "stripe": stripe, "buyer": buyer, "lonely": lonely,
        "holder": holder,
    }


def test_миграция_записывает_сегодняшнее_прочтение(db):
    project, n = _tree(db)
    before = elements_for_project(db, project.id)
    expected = {key: before.effective(node.id) for key, node in n.items()}

    written = migration.fill_elements(db.connection())
    db.commit()
    db.expire_all()

    stored = {key: db.get(Node, node.id).element for key, node in n.items()}
    assert stored == {
        "shop": "system",  # сервис с вложенными
        "orders": "system",
        "api": "container",  # свой лист
        "billing": "container",  # уже задан — не трогается
        "worker": None,  # внутри контейнера — компонент
        "handler": None,
        "db": None,  # база данных
        "stripe": "system",  # внешний лист (Р42)
        "buyer": None,  # «Пользователь»
        "lonely": "container",
        "holder": "system",  # внутри один «Пользователь» — тоже с вложенными
    }
    assert written == 6
    # Ни один объект не сменил вид.
    after = elements_for_project(db, project.id)
    assert {key: after.effective(node.id) for key, node in n.items()} == expected


def test_миграция_идемпотентна(db):
    _tree(db)
    assert migration.fill_elements(db.connection()) == 6
    db.commit()
    assert migration.fill_elements(db.connection()) == 0


def test_план_переживает_цикл_в_данных():
    # a ↔ b — цикл без корня: подъём к предкам не зацикливается, контейнеров над ними нет.
    rows = [("a", "b", "service", None, False), ("b", "a", "service", None, False)]
    assert migration.plan_elements(rows) == {"a": "system", "b": "system"}
