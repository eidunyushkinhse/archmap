"""add edge_waypoints table (per-level paths for ghost edges)

Revision ID: c1d2e3f4a5b6
Revises: b1c2d3e4f5a6
Create Date: 2026-06-09 14:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c1d2e3f4a5b6'
down_revision: Union[str, None] = 'b1c2d3e4f5a6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Путь (изломы) сквозной/гостевой стрелки per-уровень — зеркало ghost_positions.
    op.create_table(
        'edge_waypoints',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('container_id', sa.Uuid(), nullable=False),
        sa.Column('edge_id', sa.Uuid(), nullable=False),
        sa.Column('waypoints', sa.JSON(), nullable=False),
        sa.ForeignKeyConstraint(['container_id'], ['nodes.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['edge_id'], ['edges.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('container_id', 'edge_id', name='uq_edge_waypoint_level_edge'),
    )


def downgrade() -> None:
    op.drop_table('edge_waypoints')
