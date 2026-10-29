"""Действующий элемент архитектуры в выдачах узла: адаптер app/element к данным проекта.

app/element.py — чистая модель над картами, без ORM; здесь — её сборка из строк БД и
простановка вычисляемого Node.element_effective перед отдачей (docs/plan-c4-elements.md,
камни 2 и 14). Действующий элемент зависит от всех предков узла, поэтому Elements
собирается по ВСЕМУ проекту, один раз на запрос:
- роутер узлов (NodeResponse) — mark_element: одна выборка пяти колонок, как
  app/approval.mark_approval;
- граф уровня, контекст-схема, развёртывание — elements_from_nodes по карте узлов,
  которая у них уже в памяти (без нового SQL), как effective_approvals.
Дети — все, включая «Пользователей», как считает has_children: узел, у которого внутри
один «Пользователь», — узел с детьми, а не лист.

Дети в Elements идут по имени (затем по id): обход потомков в глубину (Elements.
members_of) тогда детерминирован, и отказ «внутри лежит база данных …» называет одного и
того же первого виновника при любом порядке выдачи БД (app/element_rules).
"""

import uuid
from collections.abc import Iterable, Mapping
from typing import NamedTuple

from sqlalchemy.orm import Session

from app.element import Elements
from app.models.node import Node


class ElementRow(NamedTuple):
    """Лёгкая запись узла для элементов: ради пяти колонок ORM-объекты не нужны."""

    id: uuid.UUID
    parent_id: uuid.UUID | None
    shape: str
    element: str | None
    name: str


def project_element_rows(db: Session, project_id: uuid.UUID) -> list[ElementRow]:
    """Записи всех узлов проекта — одна выборка пяти колонок."""
    return [
        ElementRow(nid, pid, shape, element, name)
        for nid, pid, shape, element, name in (
            db.query(Node.id, Node.parent_id, Node.shape, Node.element, Node.name)
            .filter(Node.project_id == project_id)
            .all()
        )
    ]


def build_elements(rows: Iterable[ElementRow]) -> Elements[uuid.UUID]:
    """Elements по записям; дети каждого узла — по имени, затем по id."""
    rows = list(rows)
    children: dict[uuid.UUID, list[ElementRow]] = {}
    for r in rows:
        if r.parent_id is not None:
            children.setdefault(r.parent_id, []).append(r)
    return Elements(
        {r.id: r.parent_id for r in rows},
        {r.id: r.shape for r in rows},
        {r.id: r.element for r in rows},
        {
            pid: [k.id for k in sorted(kids, key=lambda k: (k.name, str(k.id)))]
            for pid, kids in children.items()
        },
    )


def elements_for_project(db: Session, project_id: uuid.UUID) -> Elements[uuid.UUID]:
    """Действующие элементы всех узлов проекта (одна выборка)."""
    return build_elements(project_element_rows(db, project_id))


def element_rows_of(nodes: Iterable[Node]) -> list[ElementRow]:
    """Записи из уже загруженных ORM-узлов — без запроса."""
    return [ElementRow(n.id, n.parent_id, n.shape, n.element, n.name) for n in nodes]


def elements_from_nodes(all_nodes: Mapping[uuid.UUID, Node]) -> Elements[uuid.UUID]:
    """Действующие элементы по карте ВСЕХ узлов проекта, уже лежащей в памяти (граф
    уровня, контекст-схема, развёртывание)."""
    return build_elements(element_rows_of(all_nodes.values()))


def mark_element(db: Session, project_id: uuid.UUID, nodes: list[Node]) -> None:
    """Проставляет вычисляемый element_effective на экземплярах перед отдачей
    NodeResponse. Выборка по всему проекту: элемент узла зависит от его предков."""
    if not nodes:
        return
    elements = elements_for_project(db, project_id)
    for n in nodes:
        n.element_effective = elements.effective(n.id)
