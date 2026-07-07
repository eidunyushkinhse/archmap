import uuid

from sqlalchemy import JSON, ForeignKey, String, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class ViewLayoutItem(Base):
    """Единое хранилище раскладки (R3 вид-центричного движка, C4_ENGINE_AUDIT.md §5.3).

    Строка = геометрия одного объекта на одном ВИДЕ. Вид = контейнер уровня
    (view_id — его узел; NULL — корневой вид проекта). item_id — строковый ключ
    объекта раскладки внутри вида:
      • uuid узла/отображаемой сущности → payload {"x","y"} — позиция
        (own-on-first-render: локалы, гости и свёрнутые контейнеры единообразно);
      • "b:<srcId>><tgtId>" — ПУЧОК рёбер между парой отображаемых сущностей →
        payload {"source_handle","target_handle","waypoints","anchor","label_t"}.
    Ключ пучка кодирует проекцию (пару отображаемых концов): у каждой проекции
    своя геометрия, а члены мастер-стрелки делят одну строку без fan-out.

    item_id сознательно БЕЗ FK: строки «не показанных сейчас» проекций живут и
    воскресают при возврате проекции (инвариант F6а); мусор после удаления узла
    подчищает delete_node (LIKE по uuid во всех ключах проекта).
    """

    __tablename__ = "view_layout"
    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "view_id",
            "item_id",
            name="uq_view_layout_item",
            # PG15: NULL view_id (корневой вид) участвует в уникальности как значение
            postgresql_nulls_not_distinct=True,
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    view_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("nodes.id", ondelete="CASCADE"), nullable=True, index=True
    )
    item_id: Mapped[str] = mapped_column(String(128), nullable=False)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False)
