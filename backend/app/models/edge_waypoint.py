import uuid

from sqlalchemy import JSON, ForeignKey, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class EdgeWaypoint(Base):
    """
    Кастомный путь (изломы) ребра на конкретном уровне.

    Сквозная (гостевая) стрелка проецируется на РАЗНЫЕ уровни с разной геометрией:
    на каждом уровне свой набор узлов, свой спроецированный гостевой конец и своя
    система координат. Поэтому путь хранится per-уровень: ключ — (container_id, edge_id).
    Это зеркало ghost_positions/ghost_edge_handles — раскладка, привязанная к уровню.

    Путь локальной стрелки (оба конца на одном уровне — её единственный «домашний»
    уровень) хранится в колонке самого ребра (edges.waypoints), не здесь.

    waypoints — список {"x": float, "y": float} в координатах графа уровня, БЕЗ концов.
    Строки нет → авто-маршрут (smoothstep).
    """

    __tablename__ = "edge_waypoints"
    __table_args__ = (
        UniqueConstraint("container_id", "edge_id", name="uq_edge_waypoint_level_edge"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    container_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("nodes.id", ondelete="CASCADE"), nullable=False
    )
    edge_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("edges.id", ondelete="CASCADE"), nullable=False
    )
    waypoints: Mapped[list] = mapped_column(JSON, nullable=False)
    # Идентичность якоря излома (own-on-first-render, Ф3). Не null — точки waypoints это
    # ОФСЕТ от позиции отображаемой сущности anchor_node_id (гостевой конец-потомок раскрытой
    # рамки): излом едет ровно с этим узлом, а при его сворачивании (узел не отображается)
    # гаснет в авто-маршрут. Null — путь хранится АБСОЛЮТОМ уровня (обычная гостевая/локальная
    # стрелка, привязки нет). CASCADE: удалили узел-якорь → строка излома уходит (офсет без
    # якоря бессмыслен → авто-маршрут).
    anchor_node_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("nodes.id", ondelete="CASCADE"), nullable=True
    )
