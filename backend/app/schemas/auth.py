import uuid

from pydantic import BaseModel

from app.domain_types import UserRole
from app.schemas.demo import DemoLimits


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
    """Пользователь в выборе участника проекта: id, логин и может ли он быть
    редактором или владельцем (архитектор). Остальные признаки — только в админском
    списке /admin/users."""

    id: uuid.UUID
    username: str
    can_edit: bool

    model_config = {"from_attributes": True}


class PasswordChange(BaseModel):
    """Смена своего пароля: старый обязателен, иначе оставленная открытой вкладка
    позволила бы любому сменить пароль владельца."""

    old_password: str
    new_password: str


class AuthConfig(BaseModel):
    """Публичные настройки входа (без авторизации): их читают до логина."""

    # Демо-режим публичного стенда: вместо формы входа «Попробовать без регистрации».
    demo_mode: bool = False
    # Пределы проекта и файла; только в демо-режиме, иначе null.
    demo_limits: DemoLimits | None = None


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"  # noqa: S105 — тип токена OAuth2, не пароль


class TokenData(BaseModel):
    username: str | None = None
    role: str | None = None
