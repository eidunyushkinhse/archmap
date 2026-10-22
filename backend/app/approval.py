"""Статус страницы объекта: хранимый у листа, вычисленный у контейнера.

Статус СТРАНИЦЫ (документации), а не жизненный цикл узла (docs/tasks/page-status.md):
«в работе» или «согласовано». У листа он хранится в nodes.approval и меняется
человеком; у контейнера (узла с детьми) НЕ хранится, а складывается из детей:
«согласовано», только когда согласованы ВСЕ дети — у детей-контейнеров по их
вычисленному статусу. Внешние объекты и «Пользователи» считаются наравне с прочими
(решение Р1). Контейнер, оставшийся без детей, снова лист и показывает своё хранимое
значение (Р3) — отдельной ветки для этого не нужно.

Модуль доменный, без HTTP: роутер узлов зовёт mark_approval перед отдачей
NodeResponse, граф уровня и контекст-схема — effective_approvals по уже загруженной
карте узлов проекта (без нового SQL).
"""

import uuid
from collections.abc import Iterable

from sqlalchemy.orm import Session

from app.domain_types import NodeApproval
from app.models.node import Node

# Лёгкая запись узла для вычисления: (id, parent_id, хранимый approval). Ради трёх
# колонок ORM-объекты не нужны — mark_approval выбирает ровно их; где карта узлов
# уже в памяти (граф уровня, контекст), записи собираются из неё.
ApprovalRow = tuple[uuid.UUID, uuid.UUID | None, str]


def _stored(value: str) -> NodeApproval:
    # Колонка — строка: незнакомое значение (руками в БД) — «в работе», а не
    # «согласовано» — молча согласованная страница хуже лишней проверки.
    return "approved" if value == "approved" else "in_progress"


def effective_approvals(rows: Iterable[ApprovalRow]) -> dict[uuid.UUID, NodeApproval]:
    """Статус страницы каждого узла с учётом детей — по ВСЕМ узлам проекта.

    Лист — своё хранимое значение; узел с детьми — approved, если все дети approved
    по вычисленному, иначе in_progress. Обход итеративный (пост-порядок стеком), без
    рекурсии по глубине дерева. Каждый узел входит в обход один раз (seen): данные
    снимков и импорта бывают циклическими (урок аудита), и цикл здесь не зацикливает
    обход, а даёт «в работе» — недосчитанный ребёнок согласованным не считается."""
    own: dict[uuid.UUID, NodeApproval] = {}
    parent_of: dict[uuid.UUID, uuid.UUID | None] = {}
    for nid, pid, value in rows:
        own[nid] = _stored(value)
        parent_of[nid] = pid
    children: dict[uuid.UUID, list[uuid.UUID]] = {}
    for nid, pid in parent_of.items():
        # Родитель вне выборки (висячая ссылка) детей не получает — узел ему не
        # сообщит статус, а сам он в ответ не попадёт.
        if pid is not None and pid in own:
            children.setdefault(pid, []).append(nid)

    result: dict[uuid.UUID, NodeApproval] = {}
    seen: set[uuid.UUID] = set()
    for start in own:
        if start in seen:
            continue
        # (узел, дети уже обойдены?) — второй заход считает статус по готовым детям.
        stack: list[tuple[uuid.UUID, bool]] = [(start, False)]
        while stack:
            nid, kids_done = stack.pop()
            kids = children.get(nid, [])
            if kids_done:
                if not kids:
                    result[nid] = own[nid]
                elif all(result.get(k) == "approved" for k in kids):
                    result[nid] = "approved"
                else:
                    result[nid] = "in_progress"
                continue
            if nid in seen:
                continue
            seen.add(nid)
            stack.append((nid, True))
            stack.extend((k, False) for k in kids if k not in seen)
    return result


# Отказ ручной правки статуса у контейнера (решение Р4 docs/tasks/page-status.md).
CONTAINER_DETAIL = "Статус контейнера складывается из детей"


def manual_approval_refusal(db: Session, node: Node) -> str | None:
    """Почему статус страницы узла нельзя поставить руками; None — можно.

    Контейнер (есть хоть один ребёнок) — нельзя: его статус вычисляется по детям,
    хранимое значение он не показывает. Проверка — по наличию детей в БД, как у
    смены формы (app/reparent.validate_shape_change)."""
    if db.query(Node.id).filter(Node.parent_id == node.id).first() is not None:
        return CONTAINER_DETAIL
    return None


def mark_approval(db: Session, project_id: uuid.UUID, nodes: list[Node]) -> None:
    """Проставляет вычисляемый approval_effective на экземплярах перед отдачей
    NodeResponse. Одна выборка трёх колонок по всему проекту: статус контейнера
    зависит от всего его поддерева, а не только от прямых детей."""
    if not nodes:
        return
    rows = (
        db.query(Node.id, Node.parent_id, Node.approval)
        .filter(Node.project_id == project_id)
        .all()
    )
    effective = effective_approvals((nid, pid, value) for nid, pid, value in rows)
    for n in nodes:
        n.approval_effective = effective.get(n.id, _stored(n.approval))
