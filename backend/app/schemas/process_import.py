"""Схемы импорта процесса из mermaid: превью → применение.

Тот же паттерн, что у импорта YAML и доков от агента: сперва показать, что получится,
и дать сопоставить имена, и только потом писать.
"""

import uuid

from pydantic import BaseModel


class ImportNodeCandidate(BaseModel):
    """Узел-кандидат под имя из диаграммы. Имена узлов НЕ уникальны, поэтому
    кандидатов может быть несколько — тогда выбирает пользователь, а не мы."""

    id: uuid.UUID
    name: str
    parent_name: str | None  # чем различать тёзок


class ImportParticipantPreview(BaseModel):
    alias: str  # идентификатор в тексте диаграммы (ключ сопоставления)
    name: str  # отображаемое имя оттуда же
    node_id: uuid.UUID | None  # авто-сопоставление: единственный кандидат
    candidates: list[ImportNodeCandidate]


class ProcessImportIn(BaseModel):
    text: str
    name: str | None = None


class ProcessImportPreview(BaseModel):
    name: str
    participants: list[ImportParticipantPreview]
    message_count: int
    fragment_count: int
    # Строки, которые разбор не понял. Молча выпасть они не могут: пользователь
    # считал бы импорт полным.
    unsupported: list[str]


class ProcessImportApply(ProcessImportIn):
    """Применение. mapping: алиас участника → узел; отсутствующий или null означает
    «оставить непривязанным» — пользователь НЕ обязан сопоставить каждого."""

    mapping: dict[str, uuid.UUID | None] = {}


class ProcessImportResult(BaseModel):
    process_id: uuid.UUID
    participants: int
    unbound: int  # участников осталось без узла
    messages: int
    attached: int  # шагов встало на канал схемы
    dangling: int  # шагов осталось повисшими (канала нет либо кандидатов несколько)
    fragments: int
    unsupported: list[str]
