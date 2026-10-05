import uuid
from typing import Literal

from pydantic import BaseModel

from app.schemas.demo import DemoLimits

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
    # Гость демо-стенда (docs/tasks/demo-mode.md): фронт прячет меню профиля, «Доступ»
    # и показывает метку «Песочница».
    is_guest: bool = False
    # Можно ли создать ещё один проект: глобальная роль architect, а гостю ещё и
    # предел своих проектов. Считает сервер, фронт только гасит кнопку.
    can_create_project: bool = False

    model_config = {"from_attributes": True}


class UserBrief(BaseModel):
    """Пользователь в выборе участника проекта: только id и логин, без ролей и
    признаков (это не админский список /admin/users)."""

    id: uuid.UUID
    username: str

    model_config = {"from_attributes": True}


class PasswordChange(BaseModel):
    """Смена своего пароля: старый обязателен, иначе оставленная открытой вкладка
    позволила бы любому сменить пароль владельца."""

    old_password: str
    new_password: str


class AuthConfig(BaseModel):
    """Публичные настройки входа (без авторизации): их читают до логина."""

    allow_signup: bool
    # Демо-режим публичного стенда: вместо формы входа «Попробовать без регистрации».
    demo_mode: bool = False
    # Пределы проекта и файла; только в демо-режиме, иначе null.
    demo_limits: DemoLimits | None = None


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class TokenData(BaseModel):
    username: str | None = None
    role: str | None = None
