import uuid
from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class CodeChange(Base):
    """Код ушёл вперёд документации (app/code_changes.py, замечание владельца 2026-11-21):
    CI сообщил, что в основную ветку репозитория слиты изменения, а у проекта есть объекты,
    чей источник в этом репозитории.

    Строка одна на проект и репозиторий: новые слияния её копят (merges, last_*), а снимает
    её обновление из кода с объектами этого репозитория или кнопка «Документация актуальна».
    Какие объекты затронуты, не хранится: их считает чтение по источникам живых узлов.
    """

    __tablename__ = "code_changes"
    # Пара уникальна; это же ограничение — индекс под внешним ключом project_id (сторож
    # tests/test_schema_indexes.py).
    __table_args__ = (
        UniqueConstraint("project_id", "repo", name="uq_code_changes_project_repo"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    # Репозиторий как в источнике объекта («host/org/repo», app/identity.normalize_repo),
    # без порта: адрес из CI и адрес у агента расходятся портом SSH.
    repo: Mapped[str] = mapped_column(String(255), nullable=False)
    # Сколько слияний пришло с тех пор, как документацию последний раз обновляли.
    merges: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    first_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(UTC)
    )
    last_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(UTC)
    )
    # Коммиты первого и последнего слияния (hex, SHA-1 или SHA-256): между ними агент
    # смотрит, что поменялось. null — CI коммит не прислал.
    first_commit: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_commit: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Ветка, в которую слили в последний раз (обычно main).
    branch: Mapped[str | None] = mapped_column(String(255), nullable=True)
