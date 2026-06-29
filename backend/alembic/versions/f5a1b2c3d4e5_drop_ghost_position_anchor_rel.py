"""drop ghost_positions.anchor_rel (Ф5 own-on-first-render)

Revision ID: f5a1b2c3d4e5
Revises: a1c4e7b9f203
Create Date: 2026-06-29 00:00:00.000000

Ф5 рефакторинга own-on-first-render. Колонка anchor_rel хранила признак «pos_x/pos_y —
офсет от живого якоря группы» (старая модель раскладки детей раскрытой гостевой рамки).
Живой якорь снят ещё в Ф1: у каждого гостя своя АБСОЛЮТНАЯ позиция, все записи пишутся
с anchor_rel=false, легаси-офсеты давно сконвертированы. Колонка стала мёртвой — дропаем.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f5a1b2c3d4e5'
down_revision: Union[str, None] = 'a1c4e7b9f203'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_column('ghost_positions', 'anchor_rel')


def downgrade() -> None:
    op.add_column(
        'ghost_positions',
        sa.Column('anchor_rel', sa.Boolean(), server_default=sa.text('false'), nullable=False),
    )
