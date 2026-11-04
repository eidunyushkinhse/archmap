import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None


def upgrade():
    op.create_table(
        "orders",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("customer_email", sa.String(255), nullable=False),
        sa.Column("total", sa.Numeric(12, 2), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "order_items",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("order_id", sa.BigInteger(), sa.ForeignKey("orders.id"), nullable=False),
        sa.Column("sku", sa.String(64), nullable=False),
        sa.Column("qty", sa.Integer(), nullable=False),
    )
    op.create_table("import_buffer", sa.Column("raw", sa.JSON()))


def downgrade():
    op.drop_table("import_buffer")
    op.drop_table("order_items")
    op.drop_table("orders")
