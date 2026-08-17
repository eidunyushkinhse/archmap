"""область процесса переживает удаление узла

Область процесса (business_processes.scope_node_id) ссылалась на узел с
ON DELETE CASCADE: удаление узла, назначенного областью, сносило ВЕСЬ процесс —
вместе с участниками, шагами и фрагментами. Отмена удаления его не вернула бы:
снимок удаления (app/restore.py) процессы не несёт.

Стало SET NULL: процесс переживает удаление узла и становится процессом по всей
схеме (null = вся схема — семантика поля с самого начала). Расхождение со схемой
остаётся видимым, а работа пользователя цела — симметрично непривязанному
участнику (process_participants.node_id) и повисшему шагу (process_messages.edge_id).

Обратная миграция возвращает CASCADE и данных не теряет: строки не трогаем.

Revision ID: 5c7ab8de46d6
Revises: 6f0e2f9b617c
Create Date: 2026-08-17 14:14:52.926392

"""
from typing import Sequence, Union

from alembic import op

revision: str = '5c7ab8de46d6'
down_revision: Union[str, None] = '6f0e2f9b617c'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_constraint(
        'business_processes_scope_node_id_fkey', 'business_processes', type_='foreignkey'
    )
    op.create_foreign_key(
        'business_processes_scope_node_id_fkey',
        'business_processes', 'nodes',
        ['scope_node_id'], ['id'],
        ondelete='SET NULL',
    )


def downgrade() -> None:
    op.drop_constraint(
        'business_processes_scope_node_id_fkey', 'business_processes', type_='foreignkey'
    )
    op.create_foreign_key(
        'business_processes_scope_node_id_fkey',
        'business_processes', 'nodes',
        ['scope_node_id'], ['id'],
        ondelete='CASCADE',
    )
