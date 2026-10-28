import uuid
from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, LargeBinary, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Upload(Base):
    """Файл, залитый с машины агента по одноразовой ссылке (app/uploads.py,
    docs/plan-mcp-upload.md). Удалённый MCP принимает файлы только текстом вызова, то есть
    модель их перепечатывает; загрузка — канал для байтов как есть.

    Ключ ссылки не хранится — только sha256: ссылка одноразовая (после приёма файла
    uploaded_at выставлен и повторный PUT отвергается), а сама загрузка живёт до
    expires_at и читается владельцем сколько угодно раз: превью и применение берут одни и
    те же входы. Просроченные строки чистятся лениво при новой загрузке."""

    __tablename__ = "uploads"
    # Индекс под внешним ключом user_id (сторож tests/test_schema_indexes.py).
    __table_args__ = (Index("ix_uploads_user_id", "user_id"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    # Имя файла, как его назвал агент: им файл зовут замечания превью.
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    # sha256 ключа ссылки, hex. Ключ случайный, 256 бит — соль не нужна.
    key_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(UTC)
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # Момент приёма файла; null — по ссылке ещё ничего не залито.
    uploaded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    size: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    # sha256 содержимого, hex — его агент сверяет с sha256sum у себя.
    sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    content: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
