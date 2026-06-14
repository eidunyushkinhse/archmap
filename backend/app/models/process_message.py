import uuid
from typing import TYPE_CHECKING

from sqlalchemy import ForeignKey, Integer, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    # Только для типов: связь резолвится реестром SQLAlchemy по строке в рантайме.
    from app.models.business_process import BusinessProcess


class ProcessMessage(Base):
    """Сообщение процесса — стрелка sequence-диаграммы.

    Подкреплено плечом задокументированного канала: edge_id + leg (forward/return).
    Спроецированные концы (from/to_participant_id) фиксируются на записи, чтобы рендер
    не плыл при смене набора участников (сквозные связи, ТЗ §2.2).
    """

    __tablename__ = "process_messages"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    process_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("business_processes.id", ondelete="CASCADE"), nullable=False
    )
    # Позиция сверху-вниз (время)
    order: Mapped[int] = mapped_column(Integer, nullable=False)
    # Задокументированный канал. ON DELETE SET NULL — намеренно: удаление связи из
    # схемы НЕ сносит сообщение, а делает его «повисшим» (valid=false), расхождение
    # со схемой видно, а не происходит тихо (ТЗ §2.2).
    edge_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("edges.id", ondelete="SET NULL"), nullable=True
    )
    # Плечо канала: "forward" (вызов) | "return" (ответ)
    leg: Mapped[str] = mapped_column(String(8), nullable=False)
    # Спроецированные отправитель/получатель (участники процесса)
    from_participant_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("process_participants.id", ondelete="CASCADE"), nullable=False
    )
    to_participant_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("process_participants.id", ondelete="CASCADE"), nullable=False
    )
    # Override подписи; null = дефолт из edge.label + плеча
    caption: Mapped[str | None] = mapped_column(String(256), nullable=True)

    process: Mapped["BusinessProcess"] = relationship(
        "BusinessProcess", back_populates="messages"
    )
