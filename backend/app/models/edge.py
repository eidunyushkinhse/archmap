import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    # Только для типов/линтера: связь Node ↔ Edge SQLAlchemy резолвит по строке
    # через свой реестр в рантайме, поэтому здесь импорт не нужен (и создал бы цикл).
    from app.models.node import Node
    from app.models.project import Project


class Edge(Base):
    __tablename__ = "edges"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    # Проект-владелец: связь скоупится им (NOT NULL, каскад при удалении проекта).
    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    label: Mapped[str | None] = mapped_column(String(256), nullable=True)
    technology: Mapped[str | None] = mapped_column(String(128), nullable=True)
    source_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("nodes.id", ondelete="CASCADE"), nullable=False
    )
    target_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("nodes.id", ondelete="CASCADE"), nullable=False
    )
    # Синхронность канала (бизнес-процессы): задаётся явно тумблером в UI связи.
    # null = дефолт (синхронный, в т.ч. легаси); true/false = явный выбор архитектора.
    # Семантика, влияющая на доступные плечи (forward/return) — версионируемое поле.
    is_synchronous: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    # ГЕОМЕТРИИ здесь больше нет (R3): хэндлы/изломы/доля плашки пер-вид,
    # хранятся в view_layout ключом пучка "b:<src>><tgt>".
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )

    project: Mapped["Project"] = relationship("Project", back_populates="edges")
    source: Mapped["Node"] = relationship(
        "Node", foreign_keys=[source_id], back_populates="outgoing_edges"
    )
    target: Mapped["Node"] = relationship(
        "Node", foreign_keys=[target_id], back_populates="incoming_edges"
    )
