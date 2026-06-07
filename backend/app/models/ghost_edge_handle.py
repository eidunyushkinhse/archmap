import uuid

from sqlalchemy import ForeignKey, String, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class GhostEdgeHandle(Base):
    """
    Точки стыковки (хэндлы) ребра на конкретном уровне — для концов, спроецированных
    на гостевой узел.

    Одно и то же ребро на разных уровнях проецируется на РАЗНЫЕ узлы: конец-потомок
    сворачивается на ближайшего видимого гостя, а гость на каждом уровне свой. Поэтому
    хэндл гостевого конца нельзя хранить в колонке самого ребра (она глобальна и
    относится к «домашнему» уровню локального конца) — он привязан к уровню:
    ключ — (container_id, edge_id).

    Заполняется только для того конца, который СПРОЕЦИРОВАН на гостя; второй конец
    на этом уровне локальный, и его хэндл живёт в edges.source_handle/target_handle.
    """

    __tablename__ = "ghost_edge_handles"
    __table_args__ = (
        UniqueConstraint("container_id", "edge_id", name="uq_ghost_edge_handle_level_edge"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    container_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("nodes.id", ondelete="CASCADE"), nullable=False
    )
    edge_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("edges.id", ondelete="CASCADE"), nullable=False
    )
    source_handle: Mapped[str | None] = mapped_column(String(128), nullable=True)
    target_handle: Mapped[str | None] = mapped_column(String(128), nullable=True)
