import uuid
from typing import TYPE_CHECKING

from sqlalchemy import ForeignKey, Integer, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    # Только для типов: связь резолвится реестром SQLAlchemy по строке в рантайме.
    from app.models.business_process import BusinessProcess


class ProcessFragment(Base):
    """Управляющий фрагмент — свободный слой процесса (alt/opt/loop/par).

    Со схемой C4 не связан (связей не утверждает): только порядок/условия. Охватывает
    диапазон сообщений по order; для alt — вторая ветка [иначе] (ТЗ §2.2).
    """

    __tablename__ = "process_fragments"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    process_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("business_processes.id", ondelete="CASCADE"), nullable=False
    )
    # Вид фрагмента: "alt" | "opt" | "loop" | "par"
    kind: Mapped[str] = mapped_column(String(8), nullable=False)
    # Диапазон охваченных сообщений (по order)
    from_order: Mapped[int] = mapped_column(Integer, nullable=False)
    to_order: Mapped[int] = mapped_column(Integer, nullable=False)
    # Условие (для alt — первая ветка)
    guard: Mapped[str | None] = mapped_column(String(256), nullable=True)
    # Вторая ветка alt: с этого order начинается [иначе] (для opt/loop/par не используются)
    else_guard: Mapped[str | None] = mapped_column(String(256), nullable=True)
    else_order: Mapped[int | None] = mapped_column(Integer, nullable=True)

    process: Mapped["BusinessProcess"] = relationship(
        "BusinessProcess", back_populates="fragments"
    )
