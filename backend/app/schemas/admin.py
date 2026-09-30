"""Схемы API администратора: управление пользователями (docs/tasks/admin-users.md).

Хэш пароля наружу не отдаётся никогда: ответы собираются из явного набора полей.
"""

import uuid
from datetime import datetime

from pydantic import BaseModel

from app.schemas.auth import UserRole


class AdminUser(BaseModel):
    """Строка списка «Пользователи»."""

    id: uuid.UUID
    username: str
    role: UserRole
    is_admin: bool
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class AdminUserCreate(BaseModel):
    """Новый пользователь. Пароль — временный: администратор передаёт его человеку
    сам (почты нет), человек меняет его пунктом «Сменить пароль»."""

    username: str
    role: UserRole = "viewer"
    is_admin: bool = False
    password: str


class AdminUserUpdate(BaseModel):
    """Частичная правка: None — поле не трогать. Удаления нет — только блокировка."""

    role: UserRole | None = None
    is_admin: bool | None = None
    is_active: bool | None = None


class PasswordReset(BaseModel):
    """Сброс пароля администратором: новый пароль задаёт он сам."""

    new_password: str
