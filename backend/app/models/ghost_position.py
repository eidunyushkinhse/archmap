import uuid

from sqlalchemy import Boolean, Float, ForeignKey, UniqueConstraint, Uuid, text
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
    pos_x: Mapped[float] = mapped_column(Float, nullable=False)
    pos_y: Mapped[float] = mapped_column(Float, nullable=False)
    # pos_x/pos_y трактуются как ОФСЕТ относительно живого якоря группы (anchorG),
    # а не абсолют уровня, когда anchor_rel=true. Так раскладка детей раскрытой
    # гостевой рамки едет за якорем (см. ТЗ D2/D3). false — обычный абсолют (легаси
    # и все прочие гостевые позиции); фронт лениво мигрирует такие записи в офсет.
    anchor_rel: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
