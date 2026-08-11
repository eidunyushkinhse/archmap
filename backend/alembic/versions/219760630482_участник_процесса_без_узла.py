"""участник процесса без узла

Участник перестаёт быть обязательно узлом C4: node_id становится nullable, а FK —
SET NULL вместо CASCADE. Так процесс переживает удаление узла: вместо молчаливого
исчезновения участника и всех его шагов остаётся видимое расхождение со схемой —
симметрично повисшему сообщению (edge_id = NULL).

Добавляется name — имя на момент заведения участника. Оно нужно осиротевшему
участнику: удаление узла делает БД-каскад по всему поддереву, приложение потомков
не перечисляет, и перехватить имя в тот момент негде. Для существующих строк
заполняется именами их узлов.

⚠️ ОБРАТНАЯ МИГРАЦИЯ ТЕРЯЕТ ДАННЫЕ: колонка снова становится NOT NULL, поэтому
непривязанные участники удаляются, а с ними (FK ON DELETE CASCADE на концах
сообщения) — все их шаги. Иначе откатиться нельзя вовсе.

Revision ID: 219760630482
Revises: f117bee2af5b
Create Date: 2026-08-10 15:12:44.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '219760630482'
down_revision: Union[str, None] = 'f117bee2af5b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1) Имя: сперва nullable, заполняем из узлов, затем NOT NULL.
    op.add_column('process_participants', sa.Column('name', sa.String(length=256), nullable=True))
    op.execute(
        """
        UPDATE process_participants p
        SET name = n.name
        FROM nodes n
        WHERE n.id = p.node_id
        """
    )
    # Страховка на случай осиротевших строк (FK этого не допускает, но пусто быть не должно).
    op.execute("UPDATE process_participants SET name = 'Без имени' WHERE name IS NULL")
    op.alter_column('process_participants', 'name', nullable=False)

    # 2) Ссылка на узел — необязательная, гаснет при удалении узла.
    op.alter_column('process_participants', 'node_id', existing_type=sa.Uuid(), nullable=True)
    op.drop_constraint('process_participants_node_id_fkey', 'process_participants', type_='foreignkey')
    op.create_foreign_key(
        'process_participants_node_id_fkey',
        'process_participants', 'nodes',
        ['node_id'], ['id'],
        ondelete='SET NULL',
    )


def downgrade() -> None:
    # Непривязанным участникам в старой схеме места нет — удаляем их (вместе с шагами,
    # это делает FK ON DELETE CASCADE на from/to_participant_id). См. шапку.
    op.execute("DELETE FROM process_participants WHERE node_id IS NULL")
    op.drop_constraint('process_participants_node_id_fkey', 'process_participants', type_='foreignkey')
    op.create_foreign_key(
        'process_participants_node_id_fkey',
        'process_participants', 'nodes',
        ['node_id'], ['id'],
        ondelete='CASCADE',
    )
    op.alter_column('process_participants', 'node_id', existing_type=sa.Uuid(), nullable=False)
    op.drop_column('process_participants', 'name')
