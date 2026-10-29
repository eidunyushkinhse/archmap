"""элемент архитектуры узла

Revision ID: 6f97734c3fa7
Revises: 74b412a21668
Create Date: 2026-10-29 12:00:00.000000

У узла появляется хранимый элемент архитектуры — system | container | NULL
(docs/plan-c4-elements.md, решения Р1, Р2, Р7). NULL значит «не сказано» и читается как
сегодня: узел с детьми — система, лист — контейнер; действующий элемент вычисляется
(app/element.py), а не хранится. Поэтому колонка добавляется пустой — без server_default
и без вывода значений из данных: старые YAML, архивы, снимки версий и копии проектов
остаются прежними, а мердж, синк и догрузка отличают «не сказано» от явной «системы».
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = '6f97734c3fa7'
down_revision: Union[str, None] = '74b412a21668'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('nodes', sa.Column('element', sa.String(16), nullable=True))


def downgrade() -> None:
    op.drop_column('nodes', 'element')
