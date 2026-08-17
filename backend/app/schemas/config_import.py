"""Схемы дозаливки КОНФИГУРАЦИИ сервиса от агента (BYOA, Ф3 plan-config-docs.md).

Отдельный контракт, а не расширение channels_import: там каналы с полями сообщений и
метой доставки, здесь — плоские параметры. Общая только форма пакета (файлы) и резолв
адресов узлов, который переиспользуется из docs_import.

Зависимости («какая развилка от ручки зависит») здесь не приезжают: они живут
пометками «зависит от:» в тексте схем логики (§5 плана).

ЗНАЧЕНИЙ КОНТРАКТ НЕ НЕСЁТ: default — текст дефолта из кода, не значение среды.
"""

import uuid

from pydantic import BaseModel, Field, model_validator

from app.schemas.docs_import import (
    MAX_PACKAGE_CHARS,
    MAX_PACKAGE_FILES,
    DocsAction,
    DocsFileIn,
)


class ConfigPromptOut(BaseModel):
    prompt: str


class ConfigImportIn(BaseModel):
    files: list[DocsFileIn] = Field(min_length=1, max_length=MAX_PACKAGE_FILES)
    # Объект, из окна которого открыта дозаливка: к нему уезжают параметры без адреса.
    node_id: uuid.UUID | None = None
    # Политика занятых полей: false — не трогать заполненное (дефолт), true —
    # перезаписывать тип, дефолт и назначение. Дефолт «не трогать» значит то же, что у
    # каналов: один сервис описывают несколько прогонов, и «побеждает описанное
    # раньше» — единственное, что делает результат независимым от порядка загрузки.
    # УДАЛЕНИЙ НЕТ ни при какой политике.
    overwrite: bool = False

    @model_validator(mode="after")
    def _package_size(self) -> "ConfigImportIn":
        total = sum(len(f.content) for f in self.files)
        if total > MAX_PACKAGE_CHARS:
            raise ValueError(f"пакет больше {MAX_PACKAGE_CHARS // 1_000_000} МБ")
        return self


class ConfigParamItem(BaseModel):
    """Строка превью по параметру: что приедет и что с ним станет."""

    node_path: str
    source: str
    name: str
    value_type: str
    required: bool
    action: DocsAction


class ConfigImportReport(BaseModel):
    params: list[ConfigParamItem] = []
    errors: list[str] = []
    warnings: list[str] = []
    applied: bool = False
    params_written: int = 0
