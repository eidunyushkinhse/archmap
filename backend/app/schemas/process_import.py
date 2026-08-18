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
    # Шагов с заявленной привязкой «%% archmap-doc: …» (Ф7). Резолв — на применении;
    # дефолт 0 бережёт старых клиентов.
    doc_refs: int = 0


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
    # Внутренние операции участника (самосообщения): канала C4 у них нет по контракту,
    # к повисшим не относятся — считаются отдельно, иначе отчёт объявлял бы их сломанными.
    self_messages: int = 0
    fragments: int
    unsupported: list[str]
    # Привязки к схемам логики (Ф7): сколько адресов разрешилось в doc_id и сколько
    # нет (схемы нет / адрес неоднозначен) — такие шаги едут непривязанными и попадают
    # в алерт полноты AL34. Дефолты 0 берегут старых клиентов.
    doc_linked: int = 0
    doc_unresolved: int = 0
