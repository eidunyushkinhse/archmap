import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"


def upgrade():
    op.add_column("orders", sa.Column("status", sa.String(16), nullable=False))
    op.add_column("orders", sa.Column("comment", sa.Text(), nullable=True))


def downgrade():
    op.drop_column("orders", "comment")
    op.drop_column("orders", "status")
