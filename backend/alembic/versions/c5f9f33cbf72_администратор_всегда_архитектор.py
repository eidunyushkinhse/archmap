"""администратор всегда архитектор

Revision ID: c5f9f33cbf72
Revises: 537853eef0bb
Create Date: 2026-10-18 15:43:37.801656

Администратор всегда архитектор — полные права (решение владельца 2026-10-18): прежде
админ мог быть «Пользователем» (viewer) и тогда не создавал проекты, а его токены были
только для чтения. Администраторам-«Пользователям» роль поднимается до архитектора.
Схема не меняется; откат данных не возвращает — прежние роли не сохранялись.
"""
from typing import Sequence, Union

from alembic import op


revision: str = 'c5f9f33cbf72'
down_revision: Union[str, None] = '537853eef0bb'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("UPDATE users SET role = 'architect' WHERE is_admin AND role = 'viewer'")


def downgrade() -> None:
    # Данные назад не разворачиваются: кто из админов был «Пользователем», неизвестно.
    pass
