"""Действующий элемент архитектуры в выдачах узла: адаптер app/element к данным проекта.

app/element.py — чистая модель над картами, без ORM; здесь — её сборка из строк БД и
простановка вычисляемого Node.element_effective перед отдачей (docs/plan-c4-elements.md,
камни 2 и 14). Действующий элемент зависит от всех предков узла, поэтому Elements
собирается по ВСЕМУ проекту, один раз на запрос:
- роутер узлов (NodeResponse) — mark_element: одна выборка шести колонок, как
  app/approval.mark_approval;
- граф уровня, контекст-схема, развёртывание — elements_from_nodes по карте узлов,
  которая у них уже в памяти (без нового SQL), как effective_approvals.
Дети — все, включая «Пользователей», как считает has_children: узел, у которого внутри
один «Пользователь», — узел с детьми, а не лист. Внешность узла — тоже в записи: внешний
лист-сервис без хранимого элемента — система (Р42, app/element).

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
    """Лёгкая запись узла для элементов: ради шести колонок ORM-объекты не нужны."""

    id: uuid.UUID
    parent_id: uuid.UUID | None
    shape: str
    element: str | None
    name: str
    is_external: bool


def project_element_rows(db: Session, project_id: uuid.UUID) -> list[ElementRow]:
    """Записи всех узлов проекта — одна выборка шести колонок."""
    return [
        ElementRow(nid, pid, shape, element, name, bool(external))
        for nid, pid, shape, element, name, external in (
            db.query(
                Node.id, Node.parent_id, Node.shape, Node.element, Node.name, Node.is_external
            )
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
        external=[r.id for r in rows if r.is_external],
    )


def elements_for_project(db: Session, project_id: uuid.UUID) -> Elements[uuid.UUID]:
    """Действующие элементы всех узлов проекта (одна выборка)."""
    return build_elements(project_element_rows(db, project_id))


def element_rows_of(nodes: Iterable[Node]) -> list[ElementRow]:
    """Записи из уже загруженных ORM-узлов — без запроса."""
    return [
        ElementRow(n.id, n.parent_id, n.shape, n.element, n.name, bool(n.is_external))
        for n in nodes
    ]


def elements_from_nodes(all_nodes: Mapping[uuid.UUID, Node]) -> Elements[uuid.UUID]:
    """Действующие элементы по карте ВСЕХ узлов проекта, уже лежащей в памяти (граф
    уровня, контекст-схема, развёртывание)."""
    return build_elements(element_rows_of(all_nodes.values()))


def stamp_element(
    node: Node, elements: Elements[uuid.UUID], name_of: Mapping[uuid.UUID, str]
) -> None:
    """Вычисляемые element_effective и container_name одного узла перед отдачей
    NodeResponse — одна точка для всех четырёх мест сборки (роутер узлов, граф уровня,
    контекст-схема, граф развёртывания). name_of — имена узлов проекта."""
    node.element_effective = elements.effective(node.id)
    holder = elements.container_of(node.id) if node.element_effective == "component" else None
    node.container_name = name_of.get(holder) if holder is not None else None


def mark_element(db: Session, project_id: uuid.UUID, nodes: list[Node]) -> None:
    """Проставляет вычисляемые element_effective и container_name на экземплярах перед
    отдачей NodeResponse. Выборка по всему проекту: элемент узла зависит от его предков."""
    if not nodes:
        return
    rows = project_element_rows(db, project_id)
    elements = build_elements(rows)
    names = {r.id: r.name for r in rows}
    for n in nodes:
        stamp_element(n, elements, names)
