"""Pydantic-схемы дозаливки доков от агента (этап 2 plan-agent-docs.md).

Literal-типы (Action/Origin/kind) — чтобы генерат типов фронта вышел строгим.
Отчёт превью несёт mermaid-тексты схем: бэкового валидатора mermaid нет,
валидность проверяет фронт по этим текстам (ленивый чанк mermaid уже в бандле).
"""

from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.node_doc import NodeDocKind

DocsAction = Literal["create", "overwrite", "skip", "unchanged"]
SpecOrigin = Literal["found", "generated", "synthesized"]
DocsInclude = Literal["logic", "api", "both"]


class DocsPromptOut(BaseModel):
    prompt: str


class DocsFileIn(BaseModel):
    """Один загруженный файл пакета: имя нужно для file-референсов манифеста
    и префиксов ошибок."""

    name: str = Field(min_length=1, max_length=512)
    content: str = Field(max_length=2_000_000)


class DocsImportIn(BaseModel):
    files: list[DocsFileIn] = Field(min_length=1, max_length=32)
    # Политика занятых слотов: false — пропускать (дефолт), true — перезаписывать.
    overwrite: bool = False


class DocsLogicItem(BaseModel):
    node_path: str
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
