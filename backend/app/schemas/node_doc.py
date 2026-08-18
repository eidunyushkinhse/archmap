import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

# Вид схемы логики узла. Источник правды контракта — этот Literal; фронтовый
# NodeDocKind генерируется из него (openapi-typescript).
#
# Видов ДВА, и оба — точки входа: «операция» — сценарий, запускаемый извне
# (обработчик собственной API-операции ИЛИ действие пользователя в интерфейсе),
# «воркер» — фоновая работа. Третий вид «обзор» УДАЛЁН (решение пользователя
# 2026-08-18): он был дефолтом модели и потому доставался всему, что создавалось
# без явного выбора, а смысла «схема ни о чём конкретном» продукту не нужно.
# Поле operation заполняется только у операций СОБСТВЕННОГО API узла — у
# клиентских сценариев его нет и это законно (см. recon_import: безадресная
# схема не может «исчезнуть» из кода).
NodeDocKind = Literal["operation", "worker"]


class NodeDocCreate(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    kind: NodeDocKind = "operation"
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
    """Лёгкая мета дока для NodeResponse (без content — контент лениво GET-ом).
    version — для сигнатуры меты поллинга страницы: правка КОНТЕНТА доков
    (без смены имени/вида) тоже видна как изменение данных (V53)."""

    id: uuid.UUID
    name: str
    kind: NodeDocKind
    operation: str | None
    version: int = 1
    # Схема описана (тело непустое) — производное NodeDoc.described, считается в БД.
    # Без него витрина не отличает ЗАГЛУШКУ разведки от готовой схемы: content в
    # мете нет и не будет (docs/plan-recon.md, Ф2).
    described: bool

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


class NodeDocUsage(BaseModel):
    """Строка обратного индекса «используется в процессах» (Ф8 эпика «процессы →
    доки шага», барьер У10): шаги какого процесса задокументированы этой схемой.

    Третья реализация приёма после таблиц (TableUsage) и каналов (ChannelUsage):
    хранения нет, индекс — разворот привязок шагов (doc_id) на чтении. Отличие от
    узловой секции «Участвует в процессах»: та отвечает про УЗЕЛ, эта — про
    конкретную схему, что при полусотне операций и есть смысл фичи."""
    doc_id: uuid.UUID
    process_id: uuid.UUID
    process_name: str
    # Сколько шагов процесса привязано к схеме — «этой операцией процесс пользуется
    # трижды» читается иначе, чем «однажды».
    steps: int
