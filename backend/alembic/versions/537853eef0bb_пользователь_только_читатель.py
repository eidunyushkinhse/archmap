"""пользователь только читатель

Revision ID: 537853eef0bb
Revises: 59ca9c09e04f
Create Date: 2026-10-18 15:28:18.093898

«Пользователь» (глобальная роль viewer) только смотрит: в проекте он лишь читатель
(app/access.py, can_edit). Прежде его можно было сделать редактором и передать ему
владение — данные приводятся к правилу:

1. «Пользователь»-владелец становится архитектором: проект не остаётся без хозяина,
   а владелец и раньше правил и управлял им — новое у него только право создавать
   проекты. Идёт первым, чтобы его редакторства в других проектах уцелели.
2. Остальные «Пользователи»-редакторы становятся читателями.

Схема не меняется. Откат данных не возвращает: прежние роли не сохранялись.
"""
from typing import Sequence, Union

from alembic import op


revision: str = '537853eef0bb'
down_revision: Union[str, None] = '59ca9c09e04f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "UPDATE users SET role = 'architect' WHERE role = 'viewer' AND id IN "
        "(SELECT user_id FROM project_members WHERE role = 'owner')"
    )
    op.execute(
        "UPDATE project_members SET role = 'reader' WHERE role = 'editor' AND user_id IN "
        "(SELECT id FROM users WHERE role = 'viewer')"
    )


def downgrade() -> None:
    # Данные назад не разворачиваются: кто был редактором до понижения, неизвестно.
    pass
