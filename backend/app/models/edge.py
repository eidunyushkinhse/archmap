import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    # Только для типов/линтера: связь Node ↔ Edge SQLAlchemy резолвит по строке
    # через свой реестр в рантайме, поэтому здесь импорт не нужен (и создал бы цикл).
    from app.models.node import Node


class Edge(Base):
    __tablename__ = "edges"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    label: Mapped[str | None] = mapped_column(String(256), nullable=True)
    technology: Mapped[str | None] = mapped_column(String(128), nullable=True)
    source_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("nodes.id", ondelete="CASCADE"), nullable=False
    )
    target_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("nodes.id", ondelete="CASCADE"), nullable=False
    )
    source_handle: Mapped[str | None] = mapped_column(String(128), nullable=True)
    target_handle: Mapped[str | None] = mapped_column(String(128), nullable=True)
    # Синхронность канала (бизнес-процессы): задаётся явно тумблером в UI связи.
    # null = дефолт (синхронный, в т.ч. легаси); true/false = явный выбор архитектора.
    # Семантика, влияющая на доступные плечи (forward/return) — версионируемое поле.
    is_synchronous: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    # Кастомные точки-сгибы пути стрелки в координатах графа уровня: список
    # {"x": float, "y": float} БЕЗ концов (концы берутся из хэндлов при рендере).
    # null/пусто — авто-маршрут (smoothstep). Ручные «обходы» узлов на основной схеме.
    waypoints: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # Позиция плашки с описанием вдоль стрелки: доля arc-length пути в [0, 1]
    # (0 — у источника, 1 — у цели). null — по центру (дефолт). Доля, а не абсолютные
    # координаты, поэтому одна на ребро (не пер-уровень): она геометрия-независима и
    # «адаптируется» к смене хэндлов/изломов сама — пересчитывается от текущего пути.
    label_t: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )

    source: Mapped["Node"] = relationship(
        "Node", foreign_keys=[source_id], back_populates="outgoing_edges"
    )
    target: Mapped["Node"] = relationship(
        "Node", foreign_keys=[target_id], back_populates="incoming_edges"
    )
