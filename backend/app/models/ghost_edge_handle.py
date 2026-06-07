import uuid

from sqlalchemy import ForeignKey, String, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class GhostEdgeHandle(Base):
    """
    Точка стыковки (хэндл) гостевого конца ребра на конкретном уровне.

    Один и тот же конец ребра на одном уровне проецируется на РАЗНЫЕ отображаемые
    сущности в зависимости от expand/collapse-состояния (известного только фронту):
    свёрнутый гость рисуется предком-контейнером, развёрнутый — самим листом-гостем.
    Поэтому, как и у координат (ghost_positions), хэндл привязан не только к уровню и
    ребру, но и к id ОТОБРАЖАЕМОЙ сущности, к которой он пристыкован:
    ключ — (container_id, edge_id, node_id). Так у каждой проекции своя строка и они
    не затирают друг друга.

    node_id — id отображаемой сущности (лист-гость ИЛИ предок-контейнер). handle —
    значение хэндла React Flow («<node_id>--<сторона>--<индекс>»), пристыкованного к
    гостевому концу. Хэндл локального конца хранится в колонке самого ребра.
    """

    __tablename__ = "ghost_edge_handles"
    __table_args__ = (
        UniqueConstraint(
            "container_id", "edge_id", "node_id", name="uq_ghost_edge_handle_level_edge_node"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    container_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("nodes.id", ondelete="CASCADE"), nullable=False
    )
    edge_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("edges.id", ondelete="CASCADE"), nullable=False
    )
    node_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("nodes.id", ondelete="CASCADE"), nullable=False
    )
    handle: Mapped[str] = mapped_column(String(128), nullable=False)
