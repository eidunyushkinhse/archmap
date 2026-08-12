"""Схемы дозаливки СТРУКТУРЫ БД и ОБРАЩЕНИЙ от агента (BYOA, Ф5 plan-db-docs.md).

Отдельный контракт, а не расширение docs_import: там сущности «схема логики» и
«спека», здесь — таблицы, колонки и обращения. Общая только форма пакета (файлы) и
резолв адресов узлов, который переиспользуется из docs_import.
"""

import uuid

from pydantic import BaseModel, Field, model_validator

from app.schemas.db_doc import DataAccessMode
from app.schemas.docs_import import (
    MAX_PACKAGE_CHARS,
    MAX_PACKAGE_FILES,
    DocsAction,
    DocsFileIn,
)


class DataPromptOut(BaseModel):
    prompt: str


class DataImportIn(BaseModel):
    files: list[DocsFileIn] = Field(min_length=1, max_length=MAX_PACKAGE_FILES)
    # Объект, из окна которого открыта дозаливка: к нему уезжают записи без адреса.
    node_id: uuid.UUID | None = None
    # Политика занятых полей: false — не трогать заполненное (дефолт), true —
    # перезаписывать тип/описание существующих колонок и таблиц. УДАЛЕНИЙ НЕТ ни при
    # какой политике: агент не сносит то, чего не увидел (правило docs_import).
    overwrite: bool = False

    @model_validator(mode="after")
    def _package_size(self) -> "DataImportIn":
        total = sum(len(f.content) for f in self.files)
        if total > MAX_PACKAGE_CHARS:
            raise ValueError(f"пакет больше {MAX_PACKAGE_CHARS // 1_000_000} МБ")
        return self


class DataTableItem(BaseModel):
    """Строка превью по таблице: что приедет и что с ней станет."""

    node_path: str
    source: str
    schema_name: str
    name: str
    columns: int
    action: DocsAction


class DataAccessItem(BaseModel):
    """Строка превью по обращению: чей док, куда ходит и что делает."""

    node_path: str
    source: str
    doc: str
    target: str
    mode: DataAccessMode
    action: DocsAction


class DataImportReport(BaseModel):
    tables: list[DataTableItem] = []
    access: list[DataAccessItem] = []
    errors: list[str] = []
    warnings: list[str] = []
    applied: bool = False
    tables_written: int = 0
    columns_written: int = 0
    access_written: int = 0
