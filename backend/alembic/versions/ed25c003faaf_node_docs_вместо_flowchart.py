"""node_docs вместо flowchart: коллекция именованных схем логики узла.

Этап 1 plan-agent-docs.md. Существующий текст nodes.flowchart переносится
доком «Логика» (kind=overview), затем колонка удаляется.

Revision ID: ed25c003faaf
Revises: b7c8d9e0f1a2
Create Date: 2026-07-16 19:33:16.559834

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'ed25c003faaf'
down_revision: Union[str, None] = 'b7c8d9e0f1a2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('node_docs',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('node_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=256), nullable=False),
    sa.Column('kind', sa.String(length=16), server_default='overview', nullable=False),
    sa.Column('operation', sa.String(length=256), nullable=True),
    sa.Column('content', sa.Text(), server_default='', nullable=False),
    sa.Column('version', sa.Integer(), server_default='1', nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['node_id'], ['nodes.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('node_id', 'name', name='uq_node_doc_name')
    )
    op.create_index(op.f('ix_node_docs_node_id'), 'node_docs', ['node_id'], unique=False)
    # Перенос данных: непустой flowchart → док «Логика» (gen_random_uuid — PG13+).
    op.execute(
        """
        INSERT INTO node_docs (id, node_id, name, kind, operation, content,
                               version, created_at, updated_at)
        SELECT gen_random_uuid(), id, 'Логика', 'overview', NULL, flowchart,
               1, now(), now()
        FROM nodes
        WHERE flowchart IS NOT NULL AND flowchart <> ''
        """
    )
    op.drop_column('nodes', 'flowchart')


def downgrade() -> None:
    # Best-effort: контент дока «Логика» возвращается в колонку, остальные доки теряются.
    op.add_column('nodes', sa.Column('flowchart', sa.TEXT(), autoincrement=False, nullable=True))
    op.execute(
        """
        UPDATE nodes SET flowchart = d.content
        FROM node_docs d
        WHERE d.node_id = nodes.id AND d.name = 'Логика'
        """
    )
    op.drop_index(op.f('ix_node_docs_node_id'), table_name='node_docs')
    op.drop_table('node_docs')
