import sqlalchemy as sa
from alembic import op

revision = "5a6b"
down_revision = ("2c3d", "3e4f")


def upgrade():
    op.rename_table("audit_log", "order_audit")
    op.create_primary_key("pk_audit", "order_audit", ["id"])
    op.drop_constraint("fk_sku", "order_items")
    op.alter_column("legacy", "x", nullable=True)
    if op.get_context().dialect.name == "postgresql":
        op.add_column("orders", sa.Column("search", sa.Text()))
    op.create_table_if_absent("feature_flags")
    op.execute(sa.text("CREATE TABLE settings (key text PRIMARY KEY, value jsonb)"))
