import sqlalchemy as sa
from alembic import op

revision = "3e4f"
down_revision = "1a2b"


def upgrade():
    op.create_table("tmp_import", sa.Column("raw", sa.JSON()))
    op.drop_table("tmp_import")
    op.drop_column("orders", "created_at")
