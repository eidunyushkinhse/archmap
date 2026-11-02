"""описание заглушки канала: прежний текст заменён текущим

Revision ID: 7d2e4b9c1a35
Revises: 50fc1576936a
Create Date: 2026-11-02 19:00:00.000000

Канал, который импорт заводит брокеру по подписи связи (заглушка, app/channels_import),
узнаётся по описанию: точное совпадение с EDGE_STUB_DESCRIPTION. Ревизия текстов
2026-11-02 переписала это описание словами продукта, а записи, заведённые раньше, несли
прежний текст, и код узнавал оба. Решение владельца 2026-11-02: прежний текст снести.
Миграция переписывает описание таких каналов на текущий текст (точное совпадение строки),
после неё код узнаёт только текущий.

Обе строки — литералами здесь, а не импортом из app: миграция обязана пережить будущие
правки кода. Откат возвращает прежний текст всем каналам с текущим описанием. Схема
таблиц не меняется.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = '7d2e4b9c1a35'
down_revision: str | None = '50fc1576936a'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Прежний текст описания заглушки (до 2026-11-02).
OLD = (
    "Заведён импортом по связи схемы: канал назван на стрелке, но структурой брокера "
    "ещё не описан — дозалейте пакет каналов или заполните поля."
)
# Текущий текст (app/channels_import.EDGE_STUB_DESCRIPTION на 2026-11-02).
NEW = (
    "Канал создан по подписи связи на схеме, его поля ещё не описаны. Заполните их "
    "вручную или загрузите файлы каналов."
)

_SWAP = sa.text("UPDATE broker_channels SET description = :to WHERE description = :frm")


def upgrade() -> None:
    op.get_bind().execute(_SWAP, {"to": NEW, "frm": OLD})


def downgrade() -> None:
    op.get_bind().execute(_SWAP, {"to": OLD, "frm": NEW})
