from alembic import op

revision = "0003"
down_revision = "0002"


def upgrade():
    op.drop_table("import_buffer")


def downgrade():
    pass
