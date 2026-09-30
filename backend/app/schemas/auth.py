import uuid
from typing import Literal

from pydantic import BaseModel

# Роли пользователя: право на документацию. Администратор — отдельный признак
# is_admin, а не третья роль (docs/tasks/admin-users.md).
UserRole = Literal["architect", "viewer"]


class UserCreate(BaseModel):
    username: str
    password: str
    role: str = "viewer"


class UserResponse(BaseModel):
    username: str
    role: str

    model_config = {"from_attributes": True}


class MeResponse(BaseModel):
    """Текущий пользователь по данным БД, а не токена: роль и признак администратора
    меняются без перелогина, фронт берёт их отсюда при старте приложения."""

    id: uuid.UUID
    username: str
    role: UserRole
    is_admin: bool

    model_config = {"from_attributes": True}


class PasswordChange(BaseModel):
    """Смена своего пароля: старый обязателен, иначе оставленная открытой вкладка
    позволила бы любому сменить пароль владельца."""

    old_password: str
    new_password: str


class AuthConfig(BaseModel):
    """Публичные настройки входа (без авторизации): фронту и будущему демо-режиму."""

    allow_signup: bool


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class TokenData(BaseModel):
    username: str | None = None
    role: str | None = None
