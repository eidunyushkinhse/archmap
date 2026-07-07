"""view_layout — единое хранилище раскладки (R3 вид-центричного движка).

Создаёт view_layout(project_id, view_id, item_id, payload) и СНОСИТ прежние пять
хранилищ раскладки: таблицы ghost_positions / ghost_edge_handles / edge_waypoints,
колонки nodes.pos_x/pos_y и edges.source_handle/target_handle/waypoints/label_t.

Данные НЕ мигрируются (санкция архитектора, 2026-07-07: проекты тестовые):
уровни пере-засеются own-on-first-render при первом открытии, ручная раскладка
теряется осознанно.

Revision ID: aa11bb22cc33
Revises: f5a1b2c3d4e5
"""

import sqlalchemy as sa
from alembic import op

revision = "aa11bb22cc33"
down_revision = "f5a1b2c3d4e5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "view_layout",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "project_id",
            sa.Uuid(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "view_id",
            sa.Uuid(),
            sa.ForeignKey("nodes.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("item_id", sa.String(length=128), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.UniqueConstraint(
            "project_id",
            "view_id",
            "item_id",
            name="uq_view_layout_item",
            postgresql_nulls_not_distinct=True,
        ),
    )
    op.create_index("ix_view_layout_project_id", "view_layout", ["project_id"])
    op.create_index("ix_view_layout_view_id", "view_layout", ["view_id"])

    op.drop_table("ghost_edge_handles")
    op.drop_table("edge_waypoints")
    op.drop_table("ghost_positions")

    op.drop_column("nodes", "pos_x")
    op.drop_column("nodes", "pos_y")
    op.drop_column("edges", "source_handle")
    op.drop_column("edges", "target_handle")
    op.drop_column("edges", "waypoints")
    op.drop_column("edges", "label_t")


def downgrade() -> None:
    # Обратной миграции данных нет (вперёд шли без переноса) — восстанавливаем
    # только схему прежних хранилищ пустыми.
    op.add_column("edges", sa.Column("label_t", sa.Float(), nullable=True))
    op.add_column("edges", sa.Column("waypoints", sa.JSON(), nullable=True))
    op.add_column("edges", sa.Column("target_handle", sa.String(length=128), nullable=True))
    op.add_column("edges", sa.Column("source_handle", sa.String(length=128), nullable=True))
    op.add_column("nodes", sa.Column("pos_y", sa.Float(), nullable=True))
    op.add_column("nodes", sa.Column("pos_x", sa.Float(), nullable=True))

    op.create_table(
        "ghost_positions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "container_id",
            sa.Uuid(),
            sa.ForeignKey("nodes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "node_id",
            sa.Uuid(),
            sa.ForeignKey("nodes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("pos_x", sa.Float(), nullable=False),
        sa.Column("pos_y", sa.Float(), nullable=False),
        sa.UniqueConstraint("container_id", "node_id", name="uq_ghost_position_level_node"),
    )
    op.create_table(
        "edge_waypoints",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "container_id",
            sa.Uuid(),
            sa.ForeignKey("nodes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "edge_id",
            sa.Uuid(),
            sa.ForeignKey("edges.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("waypoints", sa.JSON(), nullable=False),
        sa.Column(
            "anchor_node_id",
            sa.Uuid(),
            sa.ForeignKey("nodes.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.UniqueConstraint("container_id", "edge_id", name="uq_edge_waypoint_level_edge"),
    )
    op.create_table(
        "ghost_edge_handles",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "container_id",
            sa.Uuid(),
            sa.ForeignKey("nodes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "edge_id",
            sa.Uuid(),
            sa.ForeignKey("edges.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "node_id",
            sa.Uuid(),
            sa.ForeignKey("nodes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("handle", sa.String(length=128), nullable=False),
        sa.UniqueConstraint(
            "container_id", "edge_id", "node_id", name="uq_ghost_edge_handle_level_edge_node"
        ),
    )

    op.drop_index("ix_view_layout_view_id", table_name="view_layout")
    op.drop_index("ix_view_layout_project_id", table_name="view_layout")
    op.drop_table("view_layout")
