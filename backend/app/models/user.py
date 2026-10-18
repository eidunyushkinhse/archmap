import uuid
from datetime import UTC, datetime

from sqlalchemy import Boolean, DateTime, Enum, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.domain_types import UserRole


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(256), nullable=False)
    role: Mapped[UserRole] = mapped_column(
        Enum("architect", "viewer", name="user_role"),
        nullable=False,
        default="viewer",
    )
    # Администратор — отдельный ПРИЗНАК поверх роли: управлять людьми. Администратор
    # всегда architect — полные права (решение владельца 2026-10-18; держат
    # app/access.set_global_role, роутер admin и create-admin, данные — миграция).
    # Регистрация его никогда не выставляет; первый админ — командой на сервере
    # (python -m app.admin create-admin).
    is_admin: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    # Блокировка вместо удаления: в проектах живут created_by/updated_by, строку
    # пользователя удалять нельзя. Заблокированный не входит, а его уже выданный
    # токен перестаёт работать сразу — get_current_user сверяет флаг с БД.
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    # Поколение сессий: номер зашит в токен входа, и токен со старым номером отбивается.
    # Смена и сброс пароля растят его — прежние входы закрываются сразу, а не по
    # истечении срока токена. Личные токены для MCP от него не зависят.
    session_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    # Гость демо-стенда (docs/tasks/demo-mode.md): учётка заводится кнопкой
    # «Попробовать без регистрации», пароль случайный и никому не показывается.
    # Гость живёт, пока активен: уборка app/demo.py удаляет его вместе с проектами
    # после суток бездействия.
    is_guest: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    # Последний запрос гостя (обновляется не чаще раза в минуту). По нему уборка
    # решает, жива ли песочница. У обычных пользователей не ведётся.
    last_active_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
