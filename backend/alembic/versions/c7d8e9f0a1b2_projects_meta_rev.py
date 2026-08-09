"""projects.meta_rev — курсор изменений меты (атрибуты узла, доки, openapi).

Поллинг страницы объекта отличает «данные изменились в другой сессии»
(meta_rev) от «схема изменилась» (graph_rev): правки меты больше не двигают
graph_rev и не вызывают тост на схеме.

Revision ID: c7d8e9f0a1b2
Revises: ed25c003faaf
Create Date: 2026-08-01
"""

import sqlalchemy as sa
from alembic import op

revision = "c7d8e9f0a1b2"
down_revision = "ed25c003faaf"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column("meta_rev", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("projects", "meta_rev")
