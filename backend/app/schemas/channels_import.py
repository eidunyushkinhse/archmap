"""Схемы дозаливки КАНАЛОВ брокера от агента (BYOA, Ф4 plan-broker-docs.md).

Отдельный контракт, а не расширение data_import: там сущности «таблица» и «колонка»,
здесь — каналы и поля сообщений со своей метой доставки. Общая только форма пакета
(файлы) и резолв адресов узлов, который переиспользуется из docs_import.

Обращений («кто публикует / кто потребляет») здесь нет: они приезжают пометками в
тексте схем логики (пивот §1 плана).
"""

import uuid

from pydantic import BaseModel, Field, model_validator

from app.schemas.docs_import import (
    MAX_PACKAGE_CHARS,
    MAX_PACKAGE_FILES,
    DocsAction,
    DocsFileIn,
)


class ChannelsPromptOut(BaseModel):
    prompt: str


class ChannelsImportIn(BaseModel):
    files: list[DocsFileIn] = Field(min_length=1, max_length=MAX_PACKAGE_FILES)
    # Объект, из окна которого открыта дозаливка: к нему уезжают каналы без адреса.
    node_id: uuid.UUID | None = None
    # Политика занятых полей: false — не трогать заполненное (дефолт), true —
    # перезаписывать мету канала и типы полей. У каналов дефолт значит больше, чем у
    # таблиц: один топик описывают пакеты РАЗНЫХ репозиториев, и «побеждает описанное
    # раньше» — единственное, что делает результат независимым от порядка загрузки.
    # УДАЛЕНИЙ НЕТ ни при какой политике.
    overwrite: bool = False

    @model_validator(mode="after")
    def _package_size(self) -> "ChannelsImportIn":
        total = sum(len(f.content) for f in self.files)
        if total > MAX_PACKAGE_CHARS:
            raise ValueError(f"пакет больше {MAX_PACKAGE_CHARS // 1_000_000} МБ")
        return self


class ChannelItem(BaseModel):
    """Строка превью по каналу: что приедет и что с ним станет."""

    node_path: str
    source: str
    group_name: str
    name: str
    fields: int
    action: DocsAction


class ChannelsImportReport(BaseModel):
    channels: list[ChannelItem] = []
    errors: list[str] = []
    warnings: list[str] = []
    applied: bool = False
    channels_written: int = 0
    fields_written: int = 0
