"""Pydantic-схемы разведки точек входа (docs/plan-recon.md).

Два потока: выдача промпта (Ф0) и приём перечня одним файлом (Ф1). Перечень —
оглавление, а не документация: его строки становятся ЗАГЛУШКАМИ (схемами с пустым
телом), поэтому контракт свой, а не расширение docs_import.
"""

from typing import Literal

from pydantic import BaseModel

from app.schemas.node_doc import NodeDocKind


class ReconPromptOut(BaseModel):
    prompt: str


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
