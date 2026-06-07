"""add edge handles

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2026-05-30 00:02:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c3d4e5f6a7b8'
down_revision: Union[str, None] = 'b2c3d4e5f6a7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('edges', sa.Column('source_handle', sa.String(128), nullable=True))
    op.add_column('edges', sa.Column('target_handle', sa.String(128), nullable=True))


def downgrade() -> None:
    op.drop_column('edges', 'target_handle')
    op.drop_column('edges', 'source_handle')
