import uuid

from sqlalchemy import Float, ForeignKey, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class GhostPosition(Base):
    """
    Координаты гостевого (сквозного) узла на конкретном уровне.

    Один и тот же узел может быть гостем на разных уровнях в разных местах,
    поэтому позиция хранится per-уровень: ключ — (container_id, node_id).
    container_id — узел-контейнер уровня (родитель локальных узлов). Гости
    появляются только на не-корневых уровнях, поэтому container_id не nullable.
    """

    __tablename__ = "ghost_positions"
    __table_args__ = (
        UniqueConstraint("container_id", "node_id", name="uq_ghost_position_level_node"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    container_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("nodes.id", ondelete="CASCADE"), nullable=False
    )
    node_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("nodes.id", ondelete="CASCADE"), nullable=False
    )
    # Абсолютные координаты гостя на уровне (own-on-first-render): позиция персистится
    # при первом показе и далее меняется только драгом / командой «Переразложить».
    pos_x: Mapped[float] = mapped_column(Float, nullable=False)
    pos_y: Mapped[float] = mapped_column(Float, nullable=False)
