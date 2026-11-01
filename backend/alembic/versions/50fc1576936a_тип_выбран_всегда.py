"""тип выбран всегда: явный элемент у каждого сервиса вне контейнера

Revision ID: 50fc1576936a
Revises: 6f97734c3fa7
Create Date: 2026-11-01 21:00:00.000000

Решение владельца 2026-11-01 (docs/tasks/type-always.md, вариант Б): у сервиса вне
контейнера элемент архитектуры хранится явно — system или container. До решения NULL
значил «не сказано» и читался так: сервис с вложенными и внешний лист — система, свой
лист — контейнер. Миграция записывает ровно это прочтение каждому сервису вне контейнера
с NULL, поэтому ни один объект не меняет вид. Компоненты (всё внутри узла с хранимым
container), базы данных, брокеры и «Пользователи» остаются с NULL.

Обход — здесь же, на Python по таблице nodes, без импорта app.*: миграции не зависят от
кода приложения. Повторный запуск ничего не меняет — записанные значения уже не NULL.
Схема таблиц не меняется.
"""
from collections.abc import Iterable, Sequence
from typing import Any

import sqlalchemy as sa

from alembic import op

revision: str = '50fc1576936a'
down_revision: str | None = '6f97734c3fa7'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


NODES = sa.table(
    "nodes",
    sa.column("id", sa.Uuid()),
    sa.column("parent_id", sa.Uuid()),
    sa.column("shape", sa.String(16)),
    sa.column("element", sa.String(16)),
    sa.column("is_external", sa.Boolean()),
)

# Порция IN-списка в UPDATE: SQLite тестов и большие проекты Postgres одинаково.
_CHUNK = 500


def plan_elements(rows: Iterable[Any]) -> dict[Any, str]:
    """Что записать: id сервиса вне контейнера с NULL → «system» или «container».

    rows — строки (id, parent_id, shape, element, is_external) всех узлов. Прочтение —
    то, что до решения давал действующий элемент: компонент — у кого есть предок (не сам
    узел) с хранимым container, у сервиса с вложенными (любой формы, включая
    «Пользователей») и у внешнего листа — система, у своего листа — контейнер. Подъём к
    предкам — с seen: данные бывают циклическими."""
    rows = list(rows)
    parent_of = {r[0]: r[1] for r in rows}
    stored = {r[0]: r[3] for r in rows}
    has_children = {r[1] for r in rows if r[1] is not None and r[1] != r[0]}

    def inside_container(node_id: Any) -> bool:
        seen = {node_id}
        cur = parent_of.get(node_id)
        while cur is not None and cur not in seen:
            if stored.get(cur) == "container":
                return True
            seen.add(cur)
            cur = parent_of.get(cur)
        return False

    out: dict[Any, str] = {}
    for node_id, _parent_id, shape, element, is_external in rows:
        if shape != "service" or element is not None or inside_container(node_id):
            continue
        out[node_id] = "system" if node_id in has_children or is_external else "container"
    return out


def fill_elements(bind: sa.engine.Connection) -> int:
    """Записать план по всем узлам базы; вернуть число записанных. Отдельной функцией —
    её зовёт тест миграции на SQLite (tests/test_type_always_migration.py)."""
    rows = bind.execute(
        sa.select(NODES.c.id, NODES.c.parent_id, NODES.c.shape, NODES.c.element, NODES.c.is_external)
    ).fetchall()
    plan = plan_elements((r[0], r[1], r[2], r[3], bool(r[4])) for r in rows)
    for value in ("system", "container"):
        ids = [node_id for node_id, element in plan.items() if element == value]
        for i in range(0, len(ids), _CHUNK):
            bind.execute(
                sa.update(NODES).where(NODES.c.id.in_(ids[i:i + _CHUNK])).values(element=value)
            )
    return len(plan)


def upgrade() -> None:
    fill_elements(op.get_bind())


def downgrade() -> None:
    # Прежний код читает явные значения так же, как читал NULL: откатывать нечего.
    pass
