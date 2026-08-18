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
# Чем именно сломан шаг (см. MessageOut.invalid_reason).
MessageInvalidReason = Literal["edge_deleted", "leg_gone"]
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
    """Линия жизни процесса. НЕПРИВЯЗАННЫЙ участник (node_id = null) узла в схеме не
    имеет: имя у него своё, а свойства узла (роль/форма/статус) взять неоткуда —
    поэтому все они nullable. Фронт по node_id == null рисует «сломанный» стиль, как у
    повисшей стрелки."""

    id: uuid.UUID
    node_id: uuid.UUID | None
    name: str  # живое имя узла, а у непривязанного — своё (из импорта / до удаления узла)
    role: str | None
    shape: Shape | None
    is_external: bool | None
    status: NodeStatus | None  # статус узла-участника (цвет плеча/линии жизни)
    order: int


class MessageOut(BaseModel):
    id: uuid.UUID
    order: int
    edge_id: uuid.UUID | None
    leg: Leg
    kind: Kind
    caption: str | None  # caption ?? default (из edge.label + плеча)
    technology: str | None  # технология канала (для tech-chip); null у повисшего
    # Концы — УЧАСТНИКИ процесса, не узлы: у непривязанного участника узла нет.
    # Граница слоёв: C4 (каналы/плечи/направления) говорит узлами, процесс — участниками.
    from_participant_id: uuid.UUID
    to_participant_id: uuid.UUID
    # Шаг опирается на СУЩЕСТВУЮЩЕЕ плечо канала. Ломается двумя способами, и их
    # обязательно различать: «Восстановить связи» умеет чинить только первый.
    valid: bool
    # Почему шаг сломан (null — цел):
    #   edge_deleted — связь удалили из схемы (edge_id → NULL);
    #   leg_gone     — связь на месте, но плеча больше нет: канал сменил синхронность
    #                  на асинхронную, а у такого «ответа» не бывает.
    invalid_reason: MessageInvalidReason | None = None
    # Схема логики, к которой привязан шаг (null — не привязан). Витрине нужен ещё и
    # узел схемы, чтобы открыть оверлей и подписать строку, — он отдаётся рядом.
    doc_id: uuid.UUID | None = None
    doc_node_id: uuid.UUID | None = None
    doc_name: str | None = None
    # Синхронность канала под шагом (null — канала нет: самосообщение или повисший).
    # Нужна карточке шага: тумблер синхронности живёт там, потому что состав плеч —
    # вопрос процесса, а не C4-схемы (решение пользователя 2026-08-11). Выводить её
    # на фронте из kind можно, но окольно: связь «kind=return + leg_gone → канал
    # асинхронный» держалась бы на честном слове.
    edge_synchronous: bool | None = None


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


class BindResult(BaseModel):
    """Итог привязки: сам участник + сколько его повисших шагов подхватило каналы.
    Числа нужны интерфейсу: молча подхватывать и молчать — значит скрывать, что часть
    шагов осталась сломанной."""

    participant: "ParticipantOut"
    attached: int  # шагов подхватило канал
    dangling: int  # осталось повисшими (канала нет либо кандидатов несколько)


class ReattachResult(BaseModel):
    """Итог подхвата каналов по процессу. attached_ids нужен откату: он отцепляет
    ровно то, что прицепила эта операция, а не всё подряд."""

    attached: int
    dangling: int
    attached_ids: list[uuid.UUID]


class ParticipantBind(BaseModel):
    """Привязка непривязанного участника к узлу схемы.

    node_id = null — снятие привязки; нужно как компенсирующая операция для undo
    (иначе привязку нельзя было бы откатить). ПЕРЕпривязка привязанного запрещена:
    сообщения участника опираются на плечи каналов ЕГО узла, и подмена узла молча
    сделала бы их бессмысленными.
    """

    node_id: uuid.UUID | None


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
    # Привязка к схеме логики — «чем шаг задокументирован». Опциональна: большинство
    # шагов приезжает непривязанными, и это законное состояние (его показывает алерт
    # полноты, а не отказ ручки).
    doc_id: uuid.UUID | None = None


class MessageUpdate(BaseModel):
    caption: str | None = None
    order: int | None = None
    # Привязка к схеме логики. null — валидное значение «отвязать», поэтому ручка
    # различает «не передано» и «передан null» через exclude_unset, как у operation
    # схемы логики. Ссылочное поле: ручка проверяет, что схема из ЭТОГО проекта.
    doc_id: uuid.UUID | None = None


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
