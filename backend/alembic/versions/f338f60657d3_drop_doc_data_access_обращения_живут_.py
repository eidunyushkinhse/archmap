"""drop doc_data_access — обращения живут пометками в доках

Пивот эпика (docs/plan-db-docs.md §9): факт «операция пишет orders.status» вводился
ДВАЖДЫ — прозой в схеме логики для человека и записью doc_data_access для машины, — и
две бухгалтерии неизбежно расходились. Теперь обращение живёт ровно в одном месте:
пометкой «читает:/пишет:» в тексте схемы логики. Разбор и резолв — на ЧТЕНИИ
(app/data_refs.py), поэтому хранить их не нужно вовсе, и класс задач «инвалидация
кэша при переименовании таблицы/узла» исчезает вместе с таблицей.

⚠️ ОБРАТНАЯ МИГРАЦИЯ ТЕРЯЕТ ДАННЫЕ: downgrade возвращает пустую таблицу — записи
восстановить неоткуда. Ветка на момент сноса не слита, в проде таких данных нет.

Revision ID: f338f60657d3
Revises: 8e444fffd977
Create Date: 2026-08-13 17:15:44.068781

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f338f60657d3'
down_revision: Union[str, None] = '8e444fffd977'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_index('ix_doc_data_access_node_doc_id', table_name='doc_data_access')
    op.drop_index('ix_doc_data_access_table_id', table_name='doc_data_access')
    op.drop_table('doc_data_access')


def downgrade() -> None:
    # Ровно та таблица, что заводила 8e444fffd977, — но пустая (см. предупреждение выше).
    op.create_table('doc_data_access',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('node_doc_id', sa.Uuid(), nullable=False),
    sa.Column('table_id', sa.Uuid(), nullable=False),
    sa.Column('column_id', sa.Uuid(), nullable=True),
    sa.Column('mode', sa.String(length=8), nullable=False),
    sa.Column('note', sa.Text(), nullable=True),
    sa.ForeignKeyConstraint(['column_id'], ['db_columns.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['node_doc_id'], ['node_docs.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['table_id'], ['db_tables.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_doc_data_access_node_doc_id'), 'doc_data_access', ['node_doc_id'], unique=False)
    op.create_index(op.f('ix_doc_data_access_table_id'), 'doc_data_access', ['table_id'], unique=False)
