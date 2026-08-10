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
    диапазон сообщений по order; у alt — ещё и ветви [иначе] (ТЗ §2.2), см. ниже.
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
    # Условие (для alt — условие ПЕРВОЙ ветки: она начинается с from_order)
    guard: Mapped[str | None] = mapped_column(String(256), nullable=True)

    process: Mapped["BusinessProcess"] = relationship(
        "BusinessProcess", back_populates="fragments"
    )
    # Ветви [иначе] со ВТОРОЙ и дальше, по возрастанию границы.
    branches: Mapped[list["ProcessFragmentBranch"]] = relationship(
        "ProcessFragmentBranch",
        back_populates="fragment",
        cascade="all, delete-orphan",
        order_by="ProcessFragmentBranch.start_order",
        lazy="selectin",
    )


class ProcessFragmentBranch(Base):
    """Ветвь [иначе] внутри alt: начинается со start_order и идёт до следующей ветви.

    Первой ветви в таблице НЕТ — она начинается с from_order фрагмента, её условие
    лежит в ProcessFragment.guard. Строки здесь — ветви со второй и дальше; их
    столько, сколько влезает шагов в охват (mermaid числом ветвей не ограничен —
    проверено парсером 11.15.0, см. docs/plan-alt-branches.md).

    Границы — те же order сообщений, что from_order/to_order фрагмента: ветвь держит
    ПОЗИЦИЮ, а не набор шагов (решение 2026-08-10), поэтому перестановка шагов её не
    двигает — меняется состав ветви.
    """

    __tablename__ = "process_fragment_branches"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    fragment_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("process_fragments.id", ondelete="CASCADE"), nullable=False
    )
    # С этого order начинается ветка (строго внутри охвата: from_order < start ≤ to_order)
    start_order: Mapped[int] = mapped_column(Integer, nullable=False)
    guard: Mapped[str | None] = mapped_column(String(256), nullable=True)

    fragment: Mapped["ProcessFragment"] = relationship(
        "ProcessFragment", back_populates="branches"
    )
