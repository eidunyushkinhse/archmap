"""ghost edge handle keyed per displayed node

Revision ID: a7b8c9d0e1f2
Revises: f6a7b8c9d0e1
Create Date: 2026-06-07 01:00:00.000000

Пересоздаём ghost_edge_handles: ключ теперь (container_id, edge_id, node_id) и
одна строка хранит один хэндл гостевого конца для конкретной проекции. Прежняя
схема (source_handle/target_handle на пару container+edge) затирала хэндлы разных
проекций одного ребра друг другом. Таблица новая (фича этой же ветки), реальных
данных нет — просто пересоздаём.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a7b8c9d0e1f2'
down_revision: Union[str, None] = 'f6a7b8c9d0e1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_table('ghost_edge_handles')
    op.create_table(
        'ghost_edge_handles',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('container_id', sa.Uuid(), nullable=False),
        sa.Column('edge_id', sa.Uuid(), nullable=False),
        sa.Column('node_id', sa.Uuid(), nullable=False),
        sa.Column('handle', sa.String(length=128), nullable=False),
        sa.ForeignKeyConstraint(['container_id'], ['nodes.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['edge_id'], ['edges.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['node_id'], ['nodes.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint(
            'container_id', 'edge_id', 'node_id', name='uq_ghost_edge_handle_level_edge_node'
        ),
    )


def downgrade() -> None:
    op.drop_table('ghost_edge_handles')
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
