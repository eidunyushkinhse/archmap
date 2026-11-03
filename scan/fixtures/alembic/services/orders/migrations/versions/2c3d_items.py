import sqlalchemy as sa
from alembic import op

revision = "2c3d"
down_revision = "1a2b"


def upgrade():
    op.create_table(
        "order_items",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("order_id", sa.BigInteger(), nullable=False),
        sa.Column("sku", sa.String(64)),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["order_id"], ["orders.id"]),
    )
    op.add_column("orders", sa.Column("comment", sa.Text(), nullable=True))
    op.alter_column("orders", "status", new_column_name="state", nullable=False)
    with op.batch_alter_table("order_items") as batch_op:
        batch_op.add_column(sa.Column("qty", sa.Integer(), nullable=False))
        batch_op.alter_column("sku", type_=sa.String(length=128))
        batch_op.create_foreign_key("fk_sku", "products", ["sku"], ["sku"])
    op.execute(
        """
        ALTER TABLE orders ADD COLUMN paid_at timestamp;
        CREATE TABLE audit_log (id bigserial PRIMARY KEY, message text NOT NULL);
        """
    )


def downgrade():
    pass
