import uuid
from datetime import UTC, datetime
from typing import Literal

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

# Роли в проекте (docs/tasks/project-access.md). Права внутри проекта определяет
# ТОЛЬКО эта роль; глобальная роль architect/viewer решает лишь, можно ли создавать
# новые проекты. Один источник набора: CHECK в БД, app/access.py и контракт API.
ProjectRole = Literal["owner", "editor", "reader"]


class ProjectMember(Base):
    """Участник проекта: пользователь и его роль в этом проекте.

    Владелец хранится такой же строкой с ролью owner. «Владелец ровно один» держит
    код (создание проекта и передача владения в app/access.py), а не частичный
    индекс: тесты гоняются на SQLite. Ключ — пара (проект, пользователь): у
    пользователя в проекте одна роль, отдельный суррогатный id не нужен.
    """

    __tablename__ = "project_members"
    __table_args__ = (
        CheckConstraint(
            "role IN ('owner', 'editor', 'reader')", name="ck_project_members_role"
        ),
    )

    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    # Пользователей не удаляют (блокируют), но если строку всё же снесут руками,
    # участие уходит вместе с ней, а не висит ссылкой в никуда.
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    role: Mapped[str] = mapped_column(String(16), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(UTC)
    )
