"""отказ от вида схемы логики «обзор»

Вид «обзор» удаляется из контракта: у схемы логики остаются «операция» и
«воркер», оба — точки входа. Решение пользователя 2026-08-18.

Что делает миграция и почему именно так:

1. УДАЛЯЕТ схемы вида «обзор» вместе с телами. Перевести их было некуда: в
   «операцию» они уехали бы с пустым полем operation (и выпали бы из адресации),
   в «воркера» — с искажением смысла. Решение пользователя — «сносим и забываем»,
   а не переводим. На момент миграции в живой базе таких схем 102 (101 с телом).
2. Меняет server_default колонки kind с «overview» на «operation»: дефолт нужен
   строкам, которые вставляют в обход ORM, и он обязан быть из нового словаря.

⚠️ НЕОБРАТИМА ПО ДАННЫМ: downgrade возвращает старый server_default, но удалённые
схемы не воскрешает — их тела в БД больше нет.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "4c1e0a9f6b2d"
down_revision: str | Sequence[str] | None = "7930ba83ee51"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(sa.text("DELETE FROM node_docs WHERE kind = 'overview'"))
    op.alter_column(
        "node_docs",
        "kind",
        existing_type=sa.String(length=16),
        server_default="operation",
    )


def downgrade() -> None:
    # Данные не восстанавливаются: возвращаем только прежний дефолт.
    op.alter_column(
        "node_docs",
        "kind",
        existing_type=sa.String(length=16),
        server_default="overview",
    )
