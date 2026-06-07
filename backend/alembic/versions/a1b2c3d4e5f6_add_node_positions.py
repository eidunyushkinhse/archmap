"""add node positions

Revision ID: a1b2c3d4e5f6
Revises: c2af3a9e21fc
Create Date: 2026-05-30 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, None] = 'c2af3a9e21fc'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('nodes', sa.Column('pos_x', sa.Float(), nullable=True))
    op.add_column('nodes', sa.Column('pos_y', sa.Float(), nullable=True))


def downgrade() -> None:
    op.drop_column('nodes', 'pos_y')
    op.drop_column('nodes', 'pos_x')
