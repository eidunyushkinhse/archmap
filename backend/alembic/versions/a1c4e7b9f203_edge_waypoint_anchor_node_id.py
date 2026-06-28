"""edge_waypoints: anchor_rel (bool) → anchor_node_id (FK nodes)

Own-on-first-render, Ф3: якорь излома становится явной идентичностью узла. Раньше
anchor_rel=true означал «офсет от ВЫВЕДЕННОГО на рендере гостевого конца» — узел не
хранился, поэтому при сворачивании излом мог перепривязаться к другому концу и зависнуть
(баг 3). Теперь anchor_node_id хранит конкретный узел: излом гаснет ровно при его
сворачивании.

Данные: восстановить идентичность якоря для старых anchor_rel=true строк из SQL нельзя
(узел выводился на рендере) — их точки это офсеты от неизвестного узла, как абсолют они
встанут у начала координат. Это раскладочные строки дев-БД (MVP не выпущен) → удаляем их
(сброс этих изломов в авто-маршрут). anchor_rel=false строки были абсолютом → становятся
anchor_node_id=NULL без изменения геометрии.

Revision ID: a1c4e7b9f203
Revises: df8eca556e4b
Create Date: 2026-06-28 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'a1c4e7b9f203'
down_revision: Union[str, None] = 'df8eca556e4b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Старые офсетные изломы (якорь выводился на рендере, не хранится) — идентичность
    # неустановима → сбрасываем в авто-маршрут (удаляем строку).
    op.execute("DELETE FROM edge_waypoints WHERE anchor_rel = true")
    op.add_column('edge_waypoints', sa.Column('anchor_node_id', sa.Uuid(), nullable=True))
    op.create_foreign_key(
        'fk_edge_waypoints_anchor_node_id_nodes',
        'edge_waypoints', 'nodes',
        ['anchor_node_id'], ['id'], ondelete='CASCADE',
    )
    op.drop_column('edge_waypoints', 'anchor_rel')


def downgrade() -> None:
    op.add_column(
        'edge_waypoints',
        sa.Column('anchor_rel', sa.Boolean(), server_default=sa.text('false'), nullable=False),
    )
    op.drop_constraint('fk_edge_waypoints_anchor_node_id_nodes', 'edge_waypoints', type_='foreignkey')
    op.drop_column('edge_waypoints', 'anchor_node_id')
