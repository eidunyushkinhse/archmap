"""гость демо-стенда

Revision ID: 7c2e9d41a5b3
Revises: 4ff27c4efc3f
Create Date: 2026-10-02 12:00:00.000000

Схема аддитивная (docs/tasks/demo-mode.md, шаг 1): признак гостя с серверным
дефолтом false (все нынешние пользователи остаются обычными) и время последней
активности гостя, пустое у обычных пользователей. Вне демо-режима поля не
используются.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '7c2e9d41a5b3'
down_revision: Union[str, None] = '4ff27c4efc3f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('users', sa.Column('is_guest', sa.Boolean(), server_default='false', nullable=False))
    op.add_column('users', sa.Column('last_active_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column('users', 'last_active_at')
    op.drop_column('users', 'is_guest')
