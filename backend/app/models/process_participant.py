import uuid
from typing import TYPE_CHECKING

from sqlalchemy import ForeignKey, Integer, String, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    # Только для типов: связь резолвится реестром SQLAlchemy по строке в рантайме.
    from app.models.business_process import BusinessProcess


class ProcessParticipant(Base):
    """Участник процесса — линия жизни sequence-диаграммы.

    Обычно это узел C4, но НЕ обязательно: участник может быть НЕПРИВЯЗАННЫМ
    (node_id = NULL). Так бывает в двух случаях:
      • импорт диаграммы, где имя не сопоставили ни с одним узлом проекта;
      • узел удалили из схемы — FK гасит ссылку (SET NULL), и процесс переживает
        удаление вместо того, чтобы молча лишиться участника и всех его шагов.
    Это вторая ось «незадокументированности», симметричная повисшему сообщению
    (edge_id = NULL): расхождение со схемой должно быть ВИДНО, а не исчезать.
    """

    __tablename__ = "process_participants"
    # Ограничение остаётся: NULL-ы в Postgres друг другу не конфликтуют, поэтому
    # непривязанных участников в процессе может быть сколько угодно.
    __table_args__ = (UniqueConstraint("process_id", "node_id", name="uq_participant_node"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    process_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("business_processes.id", ondelete="CASCADE"), nullable=False
    )
    node_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("nodes.id", ondelete="SET NULL"), nullable=True
    )
    # Имя НА МОМЕНТ ЗАВЕДЕНИЯ участника в процесс. Пока узел жив, показываем живое
    # имя узла, а это — запасное: удаление узла делает БД-каскад по всему поддереву,
    # приложение потомков не перечисляет и перехватить имя в тот момент негде.
    # Переименование узла сюда НЕ доезжает — значит, у осиротевшего участника имя
    # может быть устаревшим. Это осознанный размен: узнаваемое старое имя лучше,
    # чем безымянная линия жизни.
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    # Позиция слева-направо (порядок линий жизни)
    order: Mapped[int] = mapped_column(Integer, nullable=False)

    process: Mapped["BusinessProcess"] = relationship(
        "BusinessProcess", back_populates="participants"
    )
