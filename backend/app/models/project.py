import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    # Только для типов: дочерние коллекции резолвятся реестром SQLAlchemy по строке.
    from app.models.business_process import BusinessProcess
    from app.models.edge import Edge
    from app.models.node import Node


class Project(Base):
    """Проект — изолированная схема системы.

    Корневая сущность: вся доменная модель (узлы, связи, бизнес-процессы)
    принадлежит ровно одному проекту и никогда не пересекается с другими. Одна
    организация без multi-tenant — проекты общие для всех пользователей, роль
    (architect/viewer) остаётся глобальной и проектом не меняется.
    """

    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # null = активен; datetime = в архиве (мягкое удаление; хранит и факт, и время).
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
    # «Дата изменения схемы» — трогается каждой смысловой мутацией внутри проекта
    # (узел/связь/процесс), см. touch_project. Раскладочные апдейты её НЕ меняют.
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
    )
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # «Кто менял последним» — обновляется вместе с updated_at (touch_project).
    updated_by_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    # БД-каскад сносит всю схему проекта при его удалении (ondelete CASCADE на FK
    # доменных моделей + passive_deletes здесь — не грузим строки в Python).
    nodes: Mapped[list["Node"]] = relationship(
        "Node", back_populates="project", cascade="all, delete-orphan", passive_deletes=True
    )
    edges: Mapped[list["Edge"]] = relationship(
        "Edge", back_populates="project", cascade="all, delete-orphan", passive_deletes=True
    )
    business_processes: Mapped[list["BusinessProcess"]] = relationship(
        "BusinessProcess",
        back_populates="project",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
