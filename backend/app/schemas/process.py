"""Pydantic-схемы бизнес-процессов.

Literal-типы (leg/kind/shape/fragment.kind) — чтобы генерат типов фронта вышел
строгим, а не патчился руками (CLAUDE.md). Раскладку диаграммы (координаты, активации,
изломы) НЕ персистим — она выводится на фронте из order/kind.
"""

import uuid
from typing import Literal

from pydantic import BaseModel

from app.schemas.node import NodeStatus

Leg = Literal["forward", "return"]
# "self" — самосообщение (внутренняя операция участника): не плечо канала C4, концы
# совпадают (from==to), edge_id отсутствует. Производный kind, как и остальные.
Kind = Literal["forward", "return", "async", "self"]
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
    # Различные статусы узлов-участников (для производного бейджа процесса в списке:
    # to-be / вывод / миграция). Пусто/только existing → бейджа нет.
    statuses: list[NodeStatus]


class ParticipantOut(BaseModel):
    id: uuid.UUID
    node_id: uuid.UUID
    name: str
    role: str | None
    shape: Shape
    is_external: bool
    status: NodeStatus  # статус жизненного цикла узла-участника (цвет плеча/линии жизни)
    order: int


class MessageOut(BaseModel):
    id: uuid.UUID
    order: int
    edge_id: uuid.UUID | None
    leg: Leg
    kind: Kind
    caption: str | None  # caption ?? default (из edge.label + плеча)
    technology: str | None  # технология канала (для tech-chip); null у повисшего
    from_id: uuid.UUID  # node_id спроецированного отправителя
    to_id: uuid.UUID  # node_id спроецированного получателя
    valid: bool  # edge_id is not None (false → связь удалена из схемы)


class BranchOut(BaseModel):
    """Ветвь [иначе] у alt: начинается со start_order и идёт до следующей ветви.

    Первой ветви в списке НЕТ — она начинается с from_order фрагмента, её условие
    лежит в guard самого фрагмента. Здесь ветви со второй и дальше, по возрастанию.
    """

    start_order: int
    guard: str | None


class FragmentOut(BaseModel):
    id: uuid.UUID
    kind: FragmentKind
    from_order: int
    to_order: int
    guard: str | None
    branches: list[BranchOut]


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
    # edge_id опционален: у самосообщения (from==to, внутренняя операция) связи C4 нет.
    edge_id: uuid.UUID | None = None
    leg: Leg
    from_participant_id: uuid.UUID
    to_participant_id: uuid.UUID
    caption: str | None = None
    order: int


class MessageUpdate(BaseModel):
    caption: str | None = None
    order: int | None = None


# ── Фрагменты ─────────────────────────────────────────────────────────────────
class BranchIn(BaseModel):
    start_order: int
    guard: str | None = None


class FragmentCreate(BaseModel):
    kind: FragmentKind
    from_order: int
    to_order: int
    guard: str | None = None
    branches: list[BranchIn] = []


class FragmentUpdate(BaseModel):
    kind: FragmentKind | None = None
    from_order: int | None = None
    to_order: int | None = None
    guard: str | None = None
    # Ветви правятся ЦЕЛИКОМ (как и порядок сообщений): пришёл список — он и станет
    # новым набором; не пришёл — ветви не трогаем.
    branches: list[BranchIn] | None = None


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


class DirectionOut(BaseModel):
    """Куда можно завести сообщение: пара участников с плечом в эту сторону."""

    from_id: uuid.UUID
    to_id: uuid.UUID
