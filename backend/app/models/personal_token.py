import uuid
from datetime import UTC, datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class PersonalToken(Base):
    """Личный токен доступа (docs/plan-remote-mcp.md, Р4): учётная запись агента или
    скрипта от имени пользователя, на всём /api/v1 и на /mcp.

    Сам секрет не хранится — только sha256 и префикс для опознания в списке: показ
    секрета один, в ответе на выпуск. Прав токен не несёт: их решает строка
    пользователя на каждом запросе (блокировка гасит токены сразу). Отзыв — удаление
    строки.
    """

    __tablename__ = "personal_tokens"
    # Имя уникально у пользователя; это же ограничение — индекс под внешним ключом
    # user_id (сторож tests/test_schema_indexes.py).
    __table_args__ = (UniqueConstraint("user_id", "name", name="uq_personal_tokens_user_name"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    # «archmap_» и первые знаки секрета: по нему человек узнаёт токен в списке.
    prefix: Mapped[str] = mapped_column(String(16), nullable=False)
    # sha256 секрета, hex. Соль не нужна: секрет случайный, 256 бит.
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    # Только чтение: разрешены лишь GET/HEAD/OPTIONS (проверка по методу в app/auth.py).
    read_only: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(UTC)
    )
    # Отметка не чаще шага app/personal_tokens.USE_STEP — не запись на каждый запрос.
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # null — бессрочный.
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
