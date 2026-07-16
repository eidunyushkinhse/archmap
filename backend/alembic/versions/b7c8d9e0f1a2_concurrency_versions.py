"""Версии для конкурентных сессий (этап 0 плана docs/plan-concurrency.md).

view_state — версия вида: fence + мьютекс (FOR UPDATE) батчей раскладки,
устаревший base_version отклоняется 409. Отсутствие строки = версия 0.
nodes.version / edges.version — optimistic CAS смысловых правок (PATCH с
устаревшим base_version → 409 вместо тихой перезаписи чужой работы).
projects.graph_rev — курсор «в проекте что-то поменялось» (поллинг этапа 1);
в отличие от updated_at, двигается и раскладочными мутациями.

Revision ID: b7c8d9e0f1a2
Revises: aa11bb22cc33
"""

import sqlalchemy as sa
from alembic import op

revision = "b7c8d9e0f1a2"
down_revision = "aa11bb22cc33"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "view_state",
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
        sa.Column("version", sa.Integer(), nullable=False, server_default="0"),
        sa.UniqueConstraint(
            "project_id",
            "view_id",
            name="uq_view_state_view",
            # PG15: NULL view_id (корневой вид) участвует в уникальности как значение
            postgresql_nulls_not_distinct=True,
        ),
    )
    op.create_index("ix_view_state_project_id", "view_state", ["project_id"])
    op.create_index("ix_view_state_view_id", "view_state", ["view_id"])

    op.add_column(
        "nodes", sa.Column("version", sa.Integer(), nullable=False, server_default="1")
    )
    op.add_column(
        "edges", sa.Column("version", sa.Integer(), nullable=False, server_default="1")
    )
    op.add_column(
        "projects", sa.Column("graph_rev", sa.Integer(), nullable=False, server_default="0")
    )


def downgrade() -> None:
    op.drop_column("projects", "graph_rev")
    op.drop_column("edges", "version")
    op.drop_column("nodes", "version")
    op.drop_index("ix_view_state_view_id", table_name="view_state")
    op.drop_index("ix_view_state_project_id", table_name="view_state")
    op.drop_table("view_state")
