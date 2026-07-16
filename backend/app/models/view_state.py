import uuid

from sqlalchemy import ForeignKey, Integer, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class ViewState(Base):
    """Версия вида — fence конкурентных записей раскладки (docs/plan-concurrency.md).

    Строка = счётчик изменений одного вида (view_id — контейнер уровня, NULL —
    корневой вид проекта). Инкрементируется каждой мутацией, меняющей мир вида:
    батч PUT layout, relayout, создание/удаление узла на виде, перенос узла между
    видами (parent_id). Батч раскладки с устаревшим base_version отклоняется 409.

    Строка берётся FOR UPDATE до применения батча — это одновременно и fence, и
    мьютекс писателей вида (гонка INSERT одного ключа view_layout исчезает).
    Отсутствие строки трактуется как версия 0 — виды не пересоздаются заранее.
    """

    __tablename__ = "view_state"
    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "view_id",
            name="uq_view_state_view",
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
    version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
