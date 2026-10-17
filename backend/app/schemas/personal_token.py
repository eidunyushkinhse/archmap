"""Контракт личных токенов доступа (docs/plan-remote-mcp.md, Р4).

Имена схем — PersonalToken*, а не Token*: компоненты OpenAPI делят одно пространство
имён, а Token уже занят ответом входа (app/schemas/auth.py).
"""

import uuid
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, StringConstraints

from app.domain_types import TokenLifetimeDays


class PersonalTokenCreate(BaseModel):
    # Имя видит только владелец: «Claude Code на ноутбуке», «CI синка схемы».
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)]
    read_only: bool = False
    # Срок в днях; null — бессрочно.
    lifetime_days: TokenLifetimeDays | None = 90


class PersonalTokenOut(BaseModel):
    """Токен в списке: без секрета — только префикс для опознания."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    prefix: str
    read_only: bool
    created_at: datetime
    last_used_at: datetime | None
    expires_at: datetime | None


class PersonalTokenCreated(BaseModel):
    """Ответ на выпуск: секрет показывается ОДИН раз, потом его не узнать никому."""

    token: PersonalTokenOut
    secret: str


class PersonalTokenCurrent(BaseModel):
    """Токен, которым пришёл запрос, и его владелец (GET /tokens/current)."""

    id: uuid.UUID
    name: str
    prefix: str
    read_only: bool
    username: str
