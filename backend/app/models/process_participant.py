import uuid
from typing import TYPE_CHECKING

from sqlalchemy import ForeignKey, Integer, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    # Только для типов: связь резолвится реестром SQLAlchemy по строке в рантайме.
    from app.models.business_process import BusinessProcess


class ProcessParticipant(Base):
    """Участник процесса — линия жизни sequence-диаграммы (узел C4)."""

    __tablename__ = "process_participants"
    __table_args__ = (UniqueConstraint("process_id", "node_id", name="uq_participant_node"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    process_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("business_processes.id", ondelete="CASCADE"), nullable=False
    )
    node_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("nodes.id", ondelete="CASCADE"), nullable=False
    )
    # Позиция слева-направо (порядок линий жизни)
    order: Mapped[int] = mapped_column(Integer, nullable=False)

    process: Mapped["BusinessProcess"] = relationship(
        "BusinessProcess", back_populates="participants"
    )
