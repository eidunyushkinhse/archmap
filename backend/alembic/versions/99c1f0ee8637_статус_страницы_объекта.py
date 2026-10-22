"""статус страницы объекта

Revision ID: 99c1f0ee8637
Revises: de751b9cfe3e
Create Date: 2026-10-22 12:00:00.000000

У страницы объекта появляется статус «в работе» / «согласовано» (docs/tasks/page-status.md)
— статус ДОКУМЕНТАЦИИ, не жизненный цикл узла (nodes.status остаётся как был). Колонка
хранит значение листа; у контейнера статус вычисляется по детям и в колонке не живёт
(app/approval.py). Все существующие объекты получают «в работе»: согласование — решение
человека, задним числом его не ставим.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = '99c1f0ee8637'
down_revision: Union[str, None] = 'de751b9cfe3e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'nodes',
        sa.Column('approval', sa.String(16), server_default='in_progress', nullable=False),
    )


def downgrade() -> None:
    op.drop_column('nodes', 'approval')
