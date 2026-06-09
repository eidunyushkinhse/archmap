"""add edge waypoints

Revision ID: b1c2d3e4f5a6
Revises: a7b8c9d0e1f2
Create Date: 2026-06-09 13:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b1c2d3e4f5a6'
down_revision: Union[str, None] = 'a7b8c9d0e1f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Кастомные точки-сгибы пути стрелки (ручные «обходы» узлов на основной схеме)
    op.add_column('edges', sa.Column('waypoints', sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column('edges', 'waypoints')
