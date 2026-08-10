"""ветви alt: process_fragment_branches

Одна пара else_order/else_guard в самом фрагменте позволяла ровно ОДНУ ветку
[иначе]. Ограничение было нашим: mermaid принимает сколько угодно ветвей
(проверено парсером 11.15.0). Выносим ветви в свои строки.

Первая ветвь строкой НЕ становится: она начинается с from_order фрагмента, её
условие остаётся в process_fragments.guard. В таблицу уезжают ветви со второй и
дальше — существующий else_order/else_guard как раз такая.

⚠️ ОБРАТНАЯ МИГРАЦИЯ НЕОБРАТИМА для фрагментов с двумя и более ветвями: в
колонки else_* влезает только первая, остальные теряются. Осознанная потеря —
альтернатива (отказ откатываться) хуже.

Revision ID: f117bee2af5b
Revises: 428e9cd20340
Create Date: 2026-08-10 12:51:27.219630

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f117bee2af5b'
down_revision: Union[str, None] = '428e9cd20340'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'process_fragment_branches',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('fragment_id', sa.Uuid(), nullable=False),
        sa.Column('start_order', sa.Integer(), nullable=False),
        sa.Column('guard', sa.String(length=256), nullable=True),
        sa.ForeignKeyConstraint(['fragment_id'], ['process_fragments.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        'ix_fragment_branches_fragment', 'process_fragment_branches', ['fragment_id'],
    )
    # Существующие ветки → строки. gen_random_uuid() есть в PostgreSQL с 13-й (pgcrypto
    # не нужен); проект живёт на 15+.
    op.execute(
        """
        INSERT INTO process_fragment_branches (id, fragment_id, start_order, guard)
        SELECT gen_random_uuid(), id, else_order, else_guard
        FROM process_fragments
        WHERE else_order IS NOT NULL
        """
    )
    op.drop_column('process_fragments', 'else_order')
    op.drop_column('process_fragments', 'else_guard')


def downgrade() -> None:
    op.add_column('process_fragments', sa.Column('else_guard', sa.VARCHAR(length=256), nullable=True))
    op.add_column('process_fragments', sa.Column('else_order', sa.INTEGER(), nullable=True))
    # Возвращаем ПЕРВУЮ ветвь каждого фрагмента; вторая и дальше теряются (см. шапку).
    op.execute(
        """
        UPDATE process_fragments f
        SET else_order = b.start_order, else_guard = b.guard
        FROM (
            SELECT DISTINCT ON (fragment_id) fragment_id, start_order, guard
            FROM process_fragment_branches
            ORDER BY fragment_id, start_order
        ) b
        WHERE b.fragment_id = f.id
        """
    )
    op.drop_index('ix_fragment_branches_fragment', table_name='process_fragment_branches')
    op.drop_table('process_fragment_branches')
