"""индексы внешних ключей

Revision ID: b41e7a9c2d05
Revises: 7c2e9d41a5b3
Create Date: 2026-10-13 22:00:00.000000

Аудит 2026-10 (M10, Q-1): Postgres не создаёт индекс под внешний ключ сам. Без него
каскадное удаление узла сканирует edges/nodes/process_* целиком, а выборки детей узла
и связей узла идут seq scan. Схема аддитивная: только индексы, данные не меняются.
"""
from typing import Sequence, Union

from alembic import op


revision: str = 'b41e7a9c2d05'
down_revision: Union[str, None] = '7c2e9d41a5b3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# (таблица, колонка) — имя индекса по конвенции моделей: ix_<таблица>_<колонка>.
_FK_COLUMNS = (
    ('business_processes', 'scope_node_id'),
    ('db_columns', 'references_column_id'),
    ('edges', 'source_id'),
    ('edges', 'target_id'),
    ('nodes', 'parent_id'),
    ('process_fragments', 'process_id'),
    ('process_messages', 'process_id'),
    ('process_messages', 'edge_id'),
    ('process_messages', 'from_participant_id'),
    ('process_messages', 'to_participant_id'),
    ('process_messages', 'doc_id'),
    ('process_participants', 'node_id'),
    ('projects', 'created_by_id'),
    ('projects', 'updated_by_id'),
)


def upgrade() -> None:
    for table, column in _FK_COLUMNS:
        op.create_index(op.f(f'ix_{table}_{column}'), table, [column], unique=False)


def downgrade() -> None:
    for table, column in reversed(_FK_COLUMNS):
        op.drop_index(op.f(f'ix_{table}_{column}'), table_name=table)
