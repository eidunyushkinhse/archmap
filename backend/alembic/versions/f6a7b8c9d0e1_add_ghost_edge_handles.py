"""add ghost edge handles

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
Create Date: 2026-06-07 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f6a7b8c9d0e1'
down_revision: Union[str, None] = 'e5f6a7b8c9d0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'ghost_edge_handles',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('container_id', sa.Uuid(), nullable=False),
        sa.Column('edge_id', sa.Uuid(), nullable=False),
        sa.Column('source_handle', sa.String(length=128), nullable=True),
        sa.Column('target_handle', sa.String(length=128), nullable=True),
        sa.ForeignKeyConstraint(['container_id'], ['nodes.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['edge_id'], ['edges.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('container_id', 'edge_id', name='uq_ghost_edge_handle_level_edge'),
    )


def downgrade() -> None:
    op.drop_table('ghost_edge_handles')
