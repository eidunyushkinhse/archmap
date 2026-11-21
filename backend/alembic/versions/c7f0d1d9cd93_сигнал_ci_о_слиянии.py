"""сигнал CI о слиянии: таблица code_changes и токен ci_only

Сигнал CI «в основную ветку репозитория слиты изменения» (замечание владельца 2026-11-21):
таблица code_changes — напоминание проекту, что код ушёл вперёд документации, и признак
личного токена ci_only — токен, который умеет только этот сигнал.

Revision ID: c7f0d1d9cd93
Revises: 7d2e4b9c1a35
Create Date: 2026-11-21 14:35:19.863368

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c7f0d1d9cd93'
down_revision: Union[str, None] = '7d2e4b9c1a35'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('code_changes',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('repo', sa.String(length=255), nullable=False),
    sa.Column('merges', sa.Integer(), server_default='1', nullable=False),
    sa.Column('first_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('last_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('first_commit', sa.String(length=64), nullable=True),
    sa.Column('last_commit', sa.String(length=64), nullable=True),
    sa.Column('branch', sa.String(length=255), nullable=True),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('project_id', 'repo', name='uq_code_changes_project_repo')
    )
    op.add_column('personal_tokens', sa.Column('ci_only', sa.Boolean(), server_default='false', nullable=False))


def downgrade() -> None:
    op.drop_column('personal_tokens', 'ci_only')
    op.drop_table('code_changes')
