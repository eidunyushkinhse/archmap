"""Pydantic-схемы разведки точек входа (docs/plan-recon.md).

Два потока: выдача промпта (Ф0) и приём перечня одним файлом (Ф1). Перечень —
оглавление, а не документация: его строки становятся ЗАГЛУШКАМИ (схемами с пустым
телом), поэтому контракт свой, а не расширение docs_import.
"""

import uuid
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.schemas.docs_import import MAX_PACKAGE_CHARS, MAX_PACKAGE_FILES, DocsFileIn
from app.schemas.node_doc import NodeDocKind


class ReconPromptOut(BaseModel):
    prompt: str


class ReconImportIn(BaseModel):
    """Принесённые файлы: перечень среди них ищет приёмник (папку тащат целиком)."""

    files: list[DocsFileIn] = Field(min_length=1, max_length=MAX_PACKAGE_FILES)
    # Объект, из окна которого открыт приём: к нему уезжает перечень без строки node.
    node_id: uuid.UUID | None = None
    # Поля overwrite здесь НЕТ и не будет (Р13 плана): заглушки только создаются,
    # описанное не трогается ни при какой политике, удалений нет вовсе.

    @model_validator(mode="after")
    def _package_size(self) -> "ReconImportIn":
        total = sum(len(f.content) for f in self.files)
        if total > MAX_PACKAGE_CHARS:
            raise ValueError(f"пакет больше {MAX_PACKAGE_CHARS // 1_000_000} МБ")
        return self


# Действия превью. Свой Literal, а не DocsAction: значений тоже четыре, но смысл
# другой — здесь нет ни перезаписи, ни пропуска по политике, зато есть «уже ОПИСАНА»
# (главная гарантия повторного запуска) и «исчезла из кода».
ReconAction = Literal["create", "unchanged", "described", "vanished"]


class ReconItem(BaseModel):
    """Строка превью: точка входа и что с ней станет."""

    name: str
    kind: NodeDocKind
    operation: str | None = None
    action: ReconAction
    # Имя УЖЕ СУЩЕСТВУЮЩЕЙ схемы, когда оно отличается от строки перечня: операция
    # «POST /messages» бывает описана схемой «Отправка сообщения», и человек должен
    # видеть, что именно её закрыло.
    doc_name: str | None = None


class ReconImportReport(BaseModel):
    """Отчёт превью и применения (общая форма; applied различает)."""

    # Объект, которому принадлежит перечень: адрес из файла либо объект окна.
    node_path: str = ""
    items: list[ReconItem] = []
    errors: list[str] = []
    warnings: list[str] = []
    applied: bool = False
    created: int = 0
