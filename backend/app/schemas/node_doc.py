import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

# Вид схемы логики узла. Источник правды контракта — этот Literal; фронтовый
# NodeDocKind генерируется из него (openapi-typescript).
NodeDocKind = Literal["overview", "operation", "worker"]


class NodeDocCreate(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    kind: NodeDocKind = "overview"
    # Привязка к операции OpenAPI-спеки узла («METHOD /path»)
    operation: str | None = Field(default=None, max_length=256)
    content: str = ""


class NodeDocUpdate(BaseModel):
    # Все поля опциональны; в роутере применяются через exclude_unset
    # (operation=null — валидное значение «отвязать», различаем с «не передано»).
    name: str | None = Field(default=None, min_length=1, max_length=256)
    kind: NodeDocKind | None = None
    operation: str | None = Field(default=None, max_length=256)
    content: str | None = None
    # CAS: версия дока, от которой клиент правил; не совпала с текущей → 409
    # (док изменён другой сессией). None — без проверки (компенсации undo).
    base_version: int | None = None


class NodeDocMeta(BaseModel):
    """Лёгкая мета дока для NodeResponse (без content — контент лениво GET-ом)."""

    id: uuid.UUID
    name: str
    kind: NodeDocKind
    operation: str | None

    model_config = {"from_attributes": True}


class NodeDocResponse(BaseModel):
    id: uuid.UUID
    node_id: uuid.UUID
    name: str
    kind: NodeDocKind
    operation: str | None
    content: str
    # Версия для optimistic CAS: клиент шлёт её обратно как base_version в PATCH.
    version: int = 1
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
