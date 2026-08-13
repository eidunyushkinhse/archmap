"""Контракт структуры БД (таблицы/колонки) и обратного индекса обращений.

Структура — «контракт» узла-базы, симметрично openapi_spec у сервиса; обращения —
использование, живущее у ВЫЗЫВАЮЩЕГО: пометкой «читает:/пишет:» в тексте схемы его
операции, не записями (пивот §9). Подробности принципа — docs/plan-db-docs.md §1.
"""

import uuid
from typing import Literal

from pydantic import BaseModel, Field

# Что операция делает с данными («читает:» / «пишет:» в пометке). Отдельного «delete»
# нет: карте данных важно, меняет ли операция состояние, а чем именно — деталь
# реализации.
DataAccessMode = Literal["read", "write"]


class DbColumnCreate(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    # Тип как В КОДЕ («uuid», «varchar(256)») — по диалектам не нормализуем.
    type: str = Field(default="", max_length=128)
    nullable: bool = True
    is_primary_key: bool = False
    # Внешний ключ КАРТЫ: колонка другой таблицы, на которую ссылается эта.
    references_column_id: uuid.UUID | None = None
    description: str | None = None
    order: int = 0


class DbColumnUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=256)
    type: str | None = Field(default=None, max_length=128)
    nullable: bool | None = None
    is_primary_key: bool | None = None
    # null — валидное значение «снять ссылку»; отличается от «не передано»
    # (exclude_unset в роутере).
    references_column_id: uuid.UUID | None = None
    description: str | None = None
    order: int | None = None


class DbColumnResponse(BaseModel):
    id: uuid.UUID
    table_id: uuid.UUID
    name: str
    type: str
    nullable: bool
    is_primary_key: bool
    references_column_id: uuid.UUID | None
    description: str | None
    order: int

    model_config = {"from_attributes": True}


class DbTableCreate(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    # Контур/логическая схема БД. Пусто = без контура.
    schema_name: str = Field(default="", max_length=128)
    description: str | None = None


class DbTableUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=256)
    schema_name: str | None = Field(default=None, max_length=128)
    description: str | None = None
    # CAS: версия, от которой клиент правил. Не совпала → 409. None — без проверки.
    base_version: int | None = None


class DbTableResponse(BaseModel):
    id: uuid.UUID
    node_id: uuid.UUID
    name: str
    schema_name: str
    description: str | None
    version: int
    columns: list[DbColumnResponse] = []

    model_config = {"from_attributes": True}


class TableUsage(BaseModel):
    """Обратный индекс: кто обращается к таблице этой базы.

    Разворот пометок из схем логики проекта — ради него вся модель и построена:
    инженеру сопровождения нужен не перечень таблиц, а «кто кладёт сюда значение».
    """

    table_id: uuid.UUID
    table_name: str
    column_id: uuid.UUID | None
    column_name: str | None
    mode: DataAccessMode
    doc_id: uuid.UUID
    doc_name: str
    node_id: uuid.UUID
    node_name: str
