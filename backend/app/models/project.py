import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, Uuid
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
    организация без multi-tenant. Доступ — по участникам (ProjectMember, роли
    owner/editor/reader) и флагу visible_to_all; глобальная роль architect/viewer
    решает только, можно ли создавать проекты (app/access.py).
    """

    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # null = активен; datetime = в архиве (мягкое удаление; хранит и факт, и время).
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # «Виден всем пользователям»: не-участники получают чтение. По умолчанию проект
    # виден только участникам.
    visible_to_all: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
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
    # Курсор изменений схемы (этап 1 конкурентности, docs/archive/plan-concurrency.md):
    # инкремент на КАЖДУЮ мутацию узлов/рёбер/раскладки — в отличие от updated_at,
    # который раскладку сознательно игнорирует. Клиент поллит его и перечитывает
    # уровень при росте. Инкремент — только через view_state.bump_graph_rev.
    graph_rev: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    # Курсор изменений МЕТЫ (2026-08-01): атрибуты узла (роль/технология/статус/
    # описание/внешность/openapi) и доки (node_docs) — то, что видно на странице
    # объекта, но НЕ на схеме. Поллинг страницы отличает «данные изменились» от
    # «схема изменилась» (graph_rev). Инкремент — только через bump_meta_rev.
    meta_rev: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    # Курсор изменений ПРОЦЕССОВ (Ф6 эпика «процессы → доки шага», Д9): любая мутация
    # процессов/участников/шагов/фрагментов. Свой курсор, а не meta_rev/graph_rev:
    # чужие курсоры дали бы ложные рефетчи странице объекта и канвасу. Поллит
    # страница процесса. Инкремент — только через bump_process_rev.
    process_rev: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
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
