"""Pydantic-схемы дозаливки доков от агента (этап 2 plan-agent-docs.md).

Literal-типы (Action/Origin/kind) — чтобы генерат типов фронта вышел строгим.
Отчёт превью несёт mermaid-тексты схем: бэкового валидатора mermaid нет,
валидность проверяет фронт по этим текстам (ленивый чанк mermaid уже в бандле).
"""

import uuid
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.schemas.node_doc import NodeDocKind

# Лимиты пакета (docs/plan-docs-mmd.md): файлов много, потому что схема логики —
# отдельный .mmd; потолок на весь пакет введён вместе с этим.
MAX_PACKAGE_FILES = 100
MAX_PACKAGE_CHARS = 16_000_000

DocsAction = Literal["create", "overwrite", "skip", "unchanged"]
SpecOrigin = Literal["found", "generated", "synthesized"]
DocsInclude = Literal["logic", "api", "both"]
# Фильтр типа дозаливки у preview/apply: окна логики и спеки раздельные — каждое
# применяет только своё (схемы логики ИЛИ OpenAPI-спеки), не смешивая сущности.
DocsOnly = Literal["logic", "api"]


class DocsPromptOut(BaseModel):
    prompt: str


class DocsFileIn(BaseModel):
    """Один загруженный файл пакета: имя нужно для file-референсов манифеста
    и префиксов ошибок."""

    name: str = Field(min_length=1, max_length=512)
    content: str = Field(max_length=2_000_000)


class DocsOverrideIn(BaseModel):
    """Правка строки превью: пользователь исправил имя/вид/адрес перед записью.

    Нужна с переездом на .mmd: раньше вид схемы правился ПЕРЕЗАПИСЬЮ текста
    манифеста на фронте, а манифеста больше нет — правка едет отдельным полем."""

    file: str = Field(min_length=1, max_length=512)
    name: str | None = Field(default=None, min_length=1, max_length=512)
    kind: NodeDocKind | None = None
    node: str | None = Field(default=None, min_length=1, max_length=512)


class DocsImportIn(BaseModel):
    # Потолок пакета поднят с 32: схема логики стала отдельным файлом, и у
    # монолита их десятки (docs/plan-docs-mmd.md).
    files: list[DocsFileIn] = Field(min_length=1, max_length=MAX_PACKAGE_FILES)
    # Политика занятых слотов: false — пропускать (дефолт), true — перезаписывать.
    overwrite: bool = False
    # Применить только схемы логики ("logic") или только OpenAPI-спеки ("api").
    # None — всё содержимое манифеста (для совместимости; окна ходят с фильтром).
    only: DocsOnly | None = None
    # Объект, из окна которого открыта дозаливка: к нему уезжают .mmd без
    # «%% archmap-node», им же ограничена область адресации.
    node_id: uuid.UUID | None = None
    overrides: list[DocsOverrideIn] = Field(default_factory=list, max_length=MAX_PACKAGE_FILES)

    @model_validator(mode="after")
    def _package_size(self) -> "DocsImportIn":
        # Отдельный файл лимитирован полем content, но сотня файлов по 2 МБ уехала
        # бы одним запросом — потолка на ПАКЕТ до переезда не было вовсе.
        total = sum(len(f.content) for f in self.files)
        if total > MAX_PACKAGE_CHARS:
            raise ValueError(f"пакет больше {MAX_PACKAGE_CHARS // 1_000_000} МБ")
        return self


class DocsLogicItem(BaseModel):
    node_path: str
    # Имя файла, из которого приехала схема: превью привязывает к нему правку.
    source: str
    name: str
    kind: NodeDocKind
    operation: str | None
    action: DocsAction
    # Текст схемы — фронт валидирует его mermaid-парсером в превью (✓/✗ советующе)
    mermaid: str


class DocsSpecItem(BaseModel):
    node_path: str
    source: str  # имя файла | "inline"
    origin: SpecOrigin | None
    action: DocsAction
    valid_yaml: bool
    looks_openapi: bool
    oas_version: str | None


class DocsImportReport(BaseModel):
    """Отчёт превью и применения (общая форма; applied различает)."""

    logic: list[DocsLogicItem] = []
    specs: list[DocsSpecItem] = []
    errors: list[str] = []
    warnings: list[str] = []
    conflicts: list[str] = []
    applied: bool = False
    created_docs: int = 0
    updated_docs: int = 0
    specs_written: int = 0
    # Сколько пометок каждой семьи распознано в схемах пакета (до резолва). Окно
    # сравнивает эти числа между попытками агента: упало — пометки, похоже, удалены
    # вместо починки (находка №2 docs/qa-sentry-brokers.md, ампутация Х3 в доках).
    data_refs_total: int = 0
    channel_refs_total: int = 0
