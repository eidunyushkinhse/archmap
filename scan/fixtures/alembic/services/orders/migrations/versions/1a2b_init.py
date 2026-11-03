"""init

Revision ID: 1a2b
"""
from typing import Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "1a2b"
down_revision: Union[str, None] = None


def upgrade() -> None:
    op.create_table(
        "customers",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("tags", postgresql.ARRAY(sa.Text()), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        schema="shop",
    )
    orders = op.create_table(
        "orders",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("customer_id", postgresql.UUID(), sa.ForeignKey("shop.customers.id")),
        sa.Column("total", sa.Numeric(12, 2), nullable=False),
        sa.Column("status", sa.Enum("new", "paid", name="order_status")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_orders_status", "orders", ["status"])
    op.bulk_insert(orders, [{"id": 1}])


def downgrade() -> None:
    op.drop_table("orders")
    op.drop_table("customers", schema="shop")
