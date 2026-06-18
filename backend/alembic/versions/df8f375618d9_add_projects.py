"""проекты: таблица projects + project_id на доменных моделях (бэкоффил)

Revision ID: df8f375618d9
Revises: 4acc971e8bc2
Create Date: 2026-06-18

Изоляция схем по проектам. Создаём таблицу projects, добавляем project_id на
nodes/edges/business_processes. Существующие данные не должны осиротеть: создаём
«проект по умолчанию» (Основная схема) и привязываем к нему все существующие
строки, затем делаем колонки NOT NULL.
"""

import uuid

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = "df8f375618d9"
down_revision = "4acc971e8bc2"
branch_labels = None
depends_on = None

# Доменные таблицы, получающие project_id.
_DOMAIN_TABLES = ("nodes", "edges", "business_processes")


def upgrade() -> None:
    # 1. Таблица проектов.
    op.create_table(
        "projects",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=256), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by_id", sa.Uuid(), nullable=True),
        sa.Column("updated_by_id", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(["created_by_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["updated_by_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )

    bind = op.get_bind()

    # 2. Проект по умолчанию для бэкоффила существующих данных. created_by — первый
    #    architect (если есть), иначе null. Создаём только если в БД уже есть домен-
    #    строки (на пустой БД — ничего не плодим).
    has_data = False
    for tbl in _DOMAIN_TABLES:
        cnt = bind.execute(sa.text(f"SELECT COUNT(*) FROM {tbl}")).scalar()
        if cnt:
            has_data = True
            break

    default_id = None
    if has_data:
        default_id = uuid.uuid4()
        architect = bind.execute(
            sa.text("SELECT id FROM users WHERE role = 'architect' ORDER BY created_at LIMIT 1")
        ).scalar()
        bind.execute(
            sa.text(
                "INSERT INTO projects (id, name, description, created_at, updated_at, created_by_id) "
                "VALUES (:id, :name, NULL, now(), now(), :by)"
            ),
            {"id": default_id, "name": "Основная схема", "by": architect},
        )

    # 3. project_id: сначала nullable, затем бэкоффил, затем NOT NULL + FK + индекс.
    for tbl in _DOMAIN_TABLES:
        op.add_column(tbl, sa.Column("project_id", sa.Uuid(), nullable=True))
        if default_id is not None:
            bind.execute(
                sa.text(f"UPDATE {tbl} SET project_id = :pid"),
                {"pid": default_id},
            )
        op.alter_column(tbl, "project_id", nullable=False)
        op.create_index(f"ix_{tbl}_project_id", tbl, ["project_id"])
        op.create_foreign_key(
            f"fk_{tbl}_project_id_projects",
            tbl,
            "projects",
            ["project_id"],
            ["id"],
            ondelete="CASCADE",
        )


def downgrade() -> None:
    for tbl in _DOMAIN_TABLES:
        op.drop_constraint(f"fk_{tbl}_project_id_projects", tbl, type_="foreignkey")
        op.drop_index(f"ix_{tbl}_project_id", table_name=tbl)
        op.drop_column(tbl, "project_id")
    op.drop_table("projects")
