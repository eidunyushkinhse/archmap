import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    # Только для типов/линтера: связь Node ↔ Edge SQLAlchemy резолвит по строке
    # через свой реестр в рантайме, поэтому здесь импорт не нужен (и создал бы цикл).
    from app.models.edge import Edge
    from app.models.project import Project


class Node(Base):
    __tablename__ = "nodes"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    # Проект-владелец: вся доменная модель скоупится им (NOT NULL, каскад при удалении).
    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    role: Mapped[str | None] = mapped_column(String(128), nullable=True)
    technology: Mapped[str | None] = mapped_column(String(128), nullable=True)
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("nodes.id", ondelete="CASCADE"), nullable=True
    )
    flowchart: Mapped[str | None] = mapped_column(Text, nullable=True)
    openapi_spec: Mapped[str | None] = mapped_column(Text, nullable=True)
    pos_x: Mapped[float | None] = mapped_column(Float, nullable=True)
    pos_y: Mapped[float | None] = mapped_column(Float, nullable=True)
    is_external: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # вариант отображения: service | database | broker | person (C4-формы)
    shape: Mapped[str] = mapped_column(String(32), default="service", server_default="service")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
    )

    project: Mapped["Project"] = relationship("Project", back_populates="nodes")
    parent: Mapped["Node | None"] = relationship(
        "Node", remote_side="Node.id", back_populates="children"
    )
    # passive_deletes=True: при удалении узла НЕ грузим/не правим связанные строки в
    # Python — доверяем БД-каскаду (ondelete="CASCADE" на FK ниже). Это и снимает повод
    # для прежнего bulk-костыля в delete_node: раньше ORM пытался занулить target_id
    # входящих рёбер потомков (incoming_edges без каскада, NOT NULL) → IntegrityError.
    children: Mapped[list["Node"]] = relationship(
        "Node", back_populates="parent", cascade="all, delete-orphan", passive_deletes=True
    )
    outgoing_edges: Mapped[list["Edge"]] = relationship(
        "Edge",
        foreign_keys="[Edge.source_id]",
        back_populates="source",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    incoming_edges: Mapped[list["Edge"]] = relationship(
        "Edge",
        foreign_keys="[Edge.target_id]",
        back_populates="target",
        # без cascade на уровне ORM: рёбра «принадлежат» источнику (outgoing_edges).
        # Удаление узла-цели сносит входящие рёбра БД-каскадом (target_id ondelete CASCADE).
        passive_deletes=True,
    )
