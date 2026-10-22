"""версии документации объекта

Revision ID: c6d6099cf80d
Revises: 99c1f0ee8637
Create Date: 2026-10-22 14:40:39.406595

Ф0 эпика «версии документации объекта» (docs/tasks/doc-versions.md): таблица
зафиксированных редактором срезов документации объекта с поддеревом (node_id NULL —
срез всего проекта). Снимок — zlib канонического JSON, формат — отдельной колонкой;
content_hash — sha256 семантической проекции снимка. Номер уникален у объекта, NULL
node_id участвует в уникальности как значение (PG15, как у view_layout).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c6d6099cf80d'
down_revision: Union[str, None] = '99c1f0ee8637'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'node_versions',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('project_id', sa.Uuid(), nullable=False),
        sa.Column('node_id', sa.Uuid(), nullable=True),
        sa.Column('number', sa.Integer(), nullable=False),
        sa.Column('comment', sa.String(length=512), nullable=False),
        sa.Column('kind', sa.String(length=16), server_default='manual', nullable=False),
        sa.Column('restored_from', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('created_by_id', sa.Uuid(), nullable=True),
        sa.Column('snapshot', sa.LargeBinary(), nullable=False),
        sa.Column('snapshot_format', sa.Integer(), server_default='1', nullable=False),
        sa.Column('content_hash', sa.String(length=64), nullable=False),
        sa.Column('stats', sa.JSON(), nullable=False),
        sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['node_id'], ['nodes.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint(
            'project_id',
            'node_id',
            'number',
            name='uq_node_versions_number',
            # PG15: NULL node_id (срез всего проекта) участвует в уникальности как значение
            postgresql_nulls_not_distinct=True,
        ),
    )
    op.create_index(op.f('ix_node_versions_created_by_id'), 'node_versions', ['created_by_id'], unique=False)
    op.create_index(op.f('ix_node_versions_node_id'), 'node_versions', ['node_id'], unique=False)
    op.create_index(op.f('ix_node_versions_project_id'), 'node_versions', ['project_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_node_versions_project_id'), table_name='node_versions')
    op.drop_index(op.f('ix_node_versions_node_id'), table_name='node_versions')
    op.drop_index(op.f('ix_node_versions_created_by_id'), table_name='node_versions')
    op.drop_table('node_versions')
