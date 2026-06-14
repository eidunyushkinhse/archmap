"""Pydantic-схемы бизнес-процессов.

Literal-типы (leg/kind/shape/fragment.kind) — чтобы генерат типов фронта вышел
строгим, а не патчился руками (CLAUDE.md). Раскладку диаграммы (координаты, активации,
изломы) НЕ персистим — она выводится на фронте из order/kind.
"""

import uuid
from typing import Literal

from pydantic import BaseModel

Leg = Literal["forward", "return"]
Kind = Literal["forward", "return", "async"]
FragmentKind = Literal["alt", "opt", "loop", "par"]
Shape = Literal["service", "database", "broker", "person"]


# ── Процесс ───────────────────────────────────────────────────────────────────
class ProcessCreate(BaseModel):
    name: str
    scope_node_id: uuid.UUID | None = None


class ProcessUpdate(BaseModel):
    # Оба опциональны; в роутере применяются через exclude_unset (null = корень схемы —
    # валидное значение, поэтому различаем «не передано» и «передано null»).
    name: str | None = None
    scope_node_id: uuid.UUID | None = None


class ProcessListItem(BaseModel):
    id: uuid.UUID
    name: str
    scope_node_id: uuid.UUID | None
    scope_name: str | None
    message_count: int


class ParticipantOut(BaseModel):
    id: uuid.UUID
    node_id: uuid.UUID
    name: str
    role: str | None
    shape: Shape
    is_external: bool
    order: int


class MessageOut(BaseModel):
    id: uuid.UUID
    order: int
    edge_id: uuid.UUID | None
    leg: Leg
    kind: Kind
    caption: str | None  # caption ?? default (из edge.label + плеча)
    from_id: uuid.UUID  # node_id спроецированного отправителя
    to_id: uuid.UUID  # node_id спроецированного получателя
    valid: bool  # edge_id is not None (false → связь удалена из схемы)


class FragmentOut(BaseModel):
    id: uuid.UUID
    kind: FragmentKind
    from_order: int
    to_order: int
    guard: str | None
    else_guard: str | None
    else_order: int | None


class ProcessDetail(BaseModel):
    id: uuid.UUID
    name: str
    scope_node_id: uuid.UUID | None
    scope_name: str | None
    participants: list[ParticipantOut]
    messages: list[MessageOut]
    fragments: list[FragmentOut]


# ── Участники ─────────────────────────────────────────────────────────────────
class ParticipantCreate(BaseModel):
    node_id: uuid.UUID
    order: int


class ReorderPayload(BaseModel):
    ids: list[uuid.UUID]


# ── Сообщения ─────────────────────────────────────────────────────────────────
class MessageCreate(BaseModel):
    edge_id: uuid.UUID
    leg: Leg
    from_participant_id: uuid.UUID
    to_participant_id: uuid.UUID
    caption: str | None = None
    order: int


class MessageUpdate(BaseModel):
    caption: str | None = None
    order: int | None = None


# ── Фрагменты ─────────────────────────────────────────────────────────────────
class FragmentCreate(BaseModel):
    kind: FragmentKind
    from_order: int
    to_order: int
    guard: str | None = None
    else_guard: str | None = None
    else_order: int | None = None


class FragmentUpdate(BaseModel):
    kind: FragmentKind | None = None
    from_order: int | None = None
    to_order: int | None = None
    guard: str | None = None
    else_guard: str | None = None
    else_order: int | None = None


# ── Композитор: каналы между парой участников ─────────────────────────────────
class LegOut(BaseModel):
    leg: Leg
    kind: Kind
    from_id: uuid.UUID  # СПРОЕЦИРОВАННЫЙ участник (node_id), не сырой конец ребра
    to_id: uuid.UUID
    default_caption: str | None


class ChannelOut(BaseModel):
    edge_id: uuid.UUID
    source_id: uuid.UUID
    target_id: uuid.UUID
    technology: str | None
    label: str | None
    synchronous: bool
    legs: list[LegOut]
