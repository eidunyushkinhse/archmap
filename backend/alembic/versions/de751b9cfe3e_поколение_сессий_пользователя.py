"""поколение сессий пользователя

Revision ID: de751b9cfe3e
Revises: c5f9f33cbf72
Create Date: 2026-10-18 20:00:00.000000

Смена и сброс пароля закрывают прежние входы (решение владельца 2026-10-18): номер
поколения зашит в токен входа и сверяется на каждом запросе. Токены, выданные до
миграции, номера не несут и считаются поколением 0 — текущие входы не рвутся.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = 'de751b9cfe3e'
down_revision: Union[str, None] = 'c5f9f33cbf72'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'users',
        sa.Column('session_version', sa.Integer(), server_default='0', nullable=False),
    )


def downgrade() -> None:
    op.drop_column('users', 'session_version')
