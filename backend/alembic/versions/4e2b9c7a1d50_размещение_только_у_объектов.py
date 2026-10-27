"""размещение только у объектов: экземпляры контейнеров — их объектам

Revision ID: 4e2b9c7a1d50
Revises: bb77466716fb
Create Date: 2026-10-27 14:20:00.000000

Решение 2026-10-27 (docs/tasks/deployment-view.md §2а п. 14): наследования размещения
больше нет — экземпляры хранятся у объектов (листьев дерева), контейнер размещается
целиком, и его размещение выводится из объектов. Данные прежней модели переводятся так,
как они действовали: объект без своих экземпляров получает экземпляры ближайшего
размещённого предка, после чего экземпляры контейнеров удаляются. Схема таблиц не
меняется. Откат не нужен: прежний код читает новую форму как «свои экземпляры объектов».
"""
import uuid
from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa

from alembic import op

revision: str = '4e2b9c7a1d50'
down_revision: str | None = 'bb77466716fb'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


INSTANCES = sa.table(
    "deployment_instances",
    sa.column("id", sa.Uuid()),
    sa.column("project_id", sa.Uuid()),
    sa.column("node_id", sa.Uuid()),
    sa.column("site_id", sa.Uuid()),
)


def _depth(parent_of: dict[Any, Any], node_id: Any) -> int:
    d, seen, cur = 0, set(), node_id
    while cur in parent_of and parent_of[cur] is not None and cur not in seen:
        seen.add(cur)
        cur = parent_of[cur]
        d += 1
    return d


def _leaves_under(children: dict[Any, list[Any]], shape_of: dict[Any, str], root_id: Any) -> list[Any]:
    """Объекты поддерева — листья без «Пользователей»; обход с seen (цикл в данных)."""
    out: list[Any] = []
    seen: set[Any] = set()
    stack = [root_id]
    while stack:
        cur = stack.pop()
        if cur in seen:
            continue
        seen.add(cur)
        kids = children.get(cur)
        if kids:
            stack.extend(kids)
        elif shape_of.get(cur) != "person":
            out.append(cur)
    return out


def upgrade() -> None:
    bind = op.get_bind()
    nodes = bind.execute(sa.text("SELECT id, parent_id, shape, project_id FROM nodes")).fetchall()
    rows = bind.execute(
        sa.text("SELECT id, node_id, site_id, project_id FROM deployment_instances")
    ).fetchall()
    if not rows:
        return

    parent_of = {n.id: n.parent_id for n in nodes}
    shape_of = {n.id: n.shape for n in nodes}
    project_of = {n.id: n.project_id for n in nodes}
    children: dict[Any, list[Any]] = {}
    for n in nodes:
        if n.parent_id is not None and n.parent_id != n.id:
            children.setdefault(n.parent_id, []).append(n.id)
    own: dict[Any, list[Any]] = {}
    for r in rows:
        own.setdefault(r.node_id, []).append(r)

    # Контейнеры с экземплярами — от глубоких к внешним: объекту достаётся ближайший.
    containers = sorted(
        (nid for nid in own if nid in children), key=lambda nid: _depth(parent_of, nid), reverse=True
    )
    inserts: list[dict[str, Any]] = []
    for cid in containers:
        for leaf in _leaves_under(children, shape_of, cid):
            if leaf in own:
                continue
            placed = [
                {"id": uuid.uuid4(), "project_id": project_of.get(leaf, r.project_id),
                 "node_id": leaf, "site_id": r.site_id}
                for r in own[cid]
            ]
            own[leaf] = placed
            inserts.extend(placed)

    if inserts:
        op.bulk_insert(INSTANCES, inserts)
    stale = [r.id for cid in containers for r in own[cid]]
    if stale:
        bind.execute(sa.delete(INSTANCES).where(INSTANCES.c.id.in_(stale)))


def downgrade() -> None:
    # Данные прежней модели не восстанавливаются: экземпляры объектов читаются и
    # прежним кодом как свои (наследовать нечего).
    pass
