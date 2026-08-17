import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    # Только для типов: дочерние связи резолвятся реестром SQLAlchemy по строке.
    # Регистрация моделей — через импорты в alembic/env.py и tests/conftest.py.
    from app.models.process_fragment import ProcessFragment
    from app.models.process_message import ProcessMessage
    from app.models.process_participant import ProcessParticipant
    from app.models.project import Project


class BusinessProcess(Base):
    """Бизнес-процесс — UML sequence-диаграмма поверх схемы C4.

    Участники = узлы C4, сообщения = плечи задокументированных связей. Область
    (scope_node_id) задаёт поддерево, из которого берутся участники; null = вся схема.
    """

    __tablename__ = "business_processes"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    # Проект-владелец: процесс скоупится им (NOT NULL, каскад при удалении проекта).
    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    # null = корень всей схемы (участников можно брать откуда угодно).
    # FK гасит ссылку (SET NULL), а не сносит процесс: удаление узла-области не имеет
    # права уничтожить процесс с участниками, шагами и фрагментами — тем более что
    # снимок удаления (app/restore.py) процесс не несёт и откат его не вернул бы.
    # Процесс переживает удаление и становится процессом по всей схеме: расхождение
    # видно, работа цела — симметрично непривязанному участнику и повисшему шагу.
    scope_node_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("nodes.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
    )

    project: Mapped["Project"] = relationship("Project", back_populates="business_processes")
    # Каскад на уровне ORM + passive_deletes: при удалении процесса БД сама сносит
    # участников/сообщения/фрагменты (ondelete CASCADE на их FK).
    participants: Mapped[list["ProcessParticipant"]] = relationship(
        "ProcessParticipant",
        back_populates="process",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    messages: Mapped[list["ProcessMessage"]] = relationship(
        "ProcessMessage",
        back_populates="process",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    fragments: Mapped[list["ProcessFragment"]] = relationship(
        "ProcessFragment",
        back_populates="process",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
