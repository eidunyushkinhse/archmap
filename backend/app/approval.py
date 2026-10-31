"""Статус страницы объекта: свой у контейнера, компонента и «Пользователя», вычисленный у системы.

Статус СТРАНИЦЫ (документации), а не жизненный цикл узла (docs/tasks/page-status.md):
«в работе» или «согласовано». Кто его хранит, решает элемент архитектуры (app/element.py,
решение Р14 эпика docs/plan-c4-elements.md, пересмотр page-status 2026-10-29):
- контейнер (в том числе с компонентами), компонент и «Пользователь» — ЕДИНИЦЫ статуса:
  своё значение в nodes.approval, его меняет человек. У контейнера свои факты
  (конфигурация, спецификация, площадки), и согласовать их больше нечем. «Пользователь»
  живёт на верхнем уровне, и вложенных объектов у него не бывает (N4, решение владельца
  2026-10-31): его статус — только его страница, ничего в него не складывается;
- система (группа, сама не запускается) статус НЕ хранит, а складывает из единиц: всех
  потомков любой глубины, кроме вложенных систем, — контейнеров и компонентов (и их
  частей). Вложенный «Пользователь» бывает только в старых данных (его отмечает AL25) и
  считается единицей, как прочие. «Согласовано», только когда согласованы все единицы.
  Внешние объекты считаются наравне с прочими (решение Р1 page-status), кроме внешней
  системы — внешнего листа-сервиса без хранимого элемента (Р42, 2026-10-31): она
  система без единиц, её статус не ведётся, ручная правка — отказ EXTERNAL_DETAIL.
При элементе null в проекте (все узлы с детьми — системы, листья — контейнеры) это
ровно прежнее «узел с детьми — по всем детям»: единицы системы — её листья. Узел,
оставшийся без детей, снова контейнер и показывает своё хранимое значение (Р3).

Модуль доменный, без HTTP: роутер узлов зовёт mark_approval перед отдачей
NodeResponse, граф уровня, контекст-схема и развёртывание — effective_approvals по уже
загруженной карте узлов проекта и Elements, собранному рядом (без нового SQL).
"""

import uuid
from collections.abc import Iterable

from sqlalchemy.orm import Session

from app.domain_types import NodeApproval
from app.element import Elements
from app.element_marks import ElementRow, build_elements, project_element_rows
from app.models.node import Node

# Лёгкая запись узла для вычисления: (id, parent_id, хранимый approval). Ради трёх
# колонок ORM-объекты не нужны — mark_approval выбирает ровно их (и колонки элемента);
# где карта узлов уже в памяти (граф уровня, контекст), записи собираются из неё.
ApprovalRow = tuple[uuid.UUID, uuid.UUID | None, str]


def _stored(value: str) -> NodeApproval:
    # Колонка — строка: незнакомое значение (руками в БД) — «в работе», а не
    # «согласовано» — молча согласованная страница хуже лишней проверки.
    return "approved" if value == "approved" else "in_progress"


def effective_approvals(
    rows: Iterable[ApprovalRow], elements: Elements[uuid.UUID]
) -> dict[uuid.UUID, NodeApproval]:
    """Статус страницы каждого узла — по ВСЕМ узлам проекта.

    elements — действующие элементы тех же узлов (element_marks.build_elements); аргумент
    обязательный: без него функция молча считала бы по-старому (камень 2 плана эпика).
    Единица (не система) — своё хранимое значение; система — approved, если в её
    поддереве есть хоть одна единица и все единицы согласованы по ХРАНИМОМУ значению.

    Обход итеративный (пост-порядок стеком), без рекурсии по глубине дерева: для каждого
    узла копятся два признака поддерева — «все единицы согласованы» и «единица есть».
    Каждый узел входит в обход один раз (seen): данные снимков и импорта бывают
    циклическими (урок аудита), и цикл здесь не зацикливает обход, а даёт «в работе» —
    недосчитанный потомок согласованным не считается."""
    own: dict[uuid.UUID, NodeApproval] = {}
    parent_of: dict[uuid.UUID, uuid.UUID | None] = {}
    for nid, pid, value in rows:
        own[nid] = _stored(value)
        parent_of[nid] = pid
    children: dict[uuid.UUID, list[uuid.UUID]] = {}
    for nid, pid in parent_of.items():
        # Родитель вне выборки (висячая ссылка) детей не получает — узел ему не
        # сообщит статус, а сам он в ответ не попадёт. Петля на себя — не ребёнок
        # (как в app/element.Elements).
        if pid is not None and pid != nid and pid in own:
            children.setdefault(pid, []).append(nid)

    def is_system(nid: uuid.UUID) -> bool:
        return elements.effective(nid) == "system"

    # Признаки поддерева узла ВКЛЮЧАЯ его самого: все единицы согласованы, единица есть.
    all_ok: dict[uuid.UUID, bool] = {}
    has_unit: dict[uuid.UUID, bool] = {}
    result: dict[uuid.UUID, NodeApproval] = {}
    seen: set[uuid.UUID] = set()
    for start in own:
        if start in seen:
            continue
        # (узел, дети уже обойдены?) — второй заход считает признаки по готовым детям.
        stack: list[tuple[uuid.UUID, bool]] = [(start, False)]
        while stack:
            nid, kids_done = stack.pop()
            kids = children.get(nid, [])
            if kids_done:
                # Ребёнок без признаков (недосчитан в цикле) согласованным не считается.
                kids_ok = all(all_ok.get(k, False) for k in kids)
                kids_have = any(has_unit.get(k, False) for k in kids)
                if is_system(nid):
                    result[nid] = "approved" if kids_ok and kids_have else "in_progress"
                    all_ok[nid] = kids_ok
                    has_unit[nid] = kids_have
                else:
                    result[nid] = own[nid]
                    all_ok[nid] = own[nid] == "approved" and kids_ok
                    has_unit[nid] = True
                continue
            if nid in seen:
                continue
            seen.add(nid)
            stack.append((nid, True))
            stack.extend((k, False) for k in kids if k not in seen)
    return result


# Отказ ручной правки статуса у системы (решение Р14 эпика, пересмотр Р4 page-status).
SYSTEM_DETAIL = "Статус системы складывается из вложенных объектов"
# У внешней системы (Р42) вложенных нет и не ждут: внешнее не согласуют — без упрёка.
EXTERNAL_DETAIL = "Статус внешней системы не ведётся"


def manual_approval_refusal(
    db: Session,
    project_id: uuid.UUID,
    node: Node,
    *,
    parent_id: uuid.UUID | None,
    shape: str,
    element: str | None,
    is_external: bool,
) -> str | None:
    """Почему статус страницы узла нельзя поставить руками; None — можно.

    Система — нельзя: её статус складывается из единиц, хранимое значение она не
    показывает; у внешней системы без вложенных (Р42) статус не ведётся вовсе.
    Контейнер (с компонентами или без), компонент и «Пользователь» — можно.
    Элемент — по дереву ПОСЛЕ правки, как у проверки элемента (app/element_rules):
    parent_id, shape, element и is_external — значения узла с учётом того же запроса
    (PATCH может сделать систему контейнером и сразу согласовать её)."""
    after = [
        ElementRow(r.id, parent_id, shape, element, r.name, is_external) if r.id == node.id else r
        for r in project_element_rows(db, project_id)
    ]
    elements = build_elements(after)
    if elements.effective(node.id) != "system":
        return None
    return EXTERNAL_DETAIL if elements.external_system(node.id) else SYSTEM_DETAIL


def mark_approval(db: Session, project_id: uuid.UUID, nodes: list[Node]) -> None:
    """Проставляет вычисляемый approval_effective на экземплярах перед отдачей
    NodeResponse. Одна выборка колонок статуса и элемента по всему проекту: статус
    системы зависит от всего её поддерева, а элемент узла — от его предков."""
    if not nodes:
        return
    rows = (
        db.query(
            Node.id, Node.parent_id, Node.approval, Node.shape, Node.element, Node.name,
            Node.is_external,
        )
        .filter(Node.project_id == project_id)
        .all()
    )
    elements = build_elements(
        ElementRow(nid, pid, shape, element, name, bool(external))
        for nid, pid, _, shape, element, name, external in rows
    )
    effective = effective_approvals(
        ((nid, pid, value) for nid, pid, value, _, _, _, _ in rows), elements
    )
    for n in nodes:
        n.approval_effective = effective.get(n.id, _stored(n.approval))
