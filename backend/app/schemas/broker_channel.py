"""Контракт структуры брокера — каналы и поля сообщений.

Структура — «контракт» узла-брокера, симметрично таблицам у базы и openapi_spec у
сервиса: описывает то, что узел ПРЕДОСТАВЛЯЕТ. Кто публикует и кто потребляет —
использование, живущее у вызывающего пометкой «публикует:/потребляет:» в тексте его
схемы логики, не записями. Подробности принципа — docs/plan-broker-docs.md §1–§2.
"""

import uuid
from typing import Literal

from pydantic import BaseModel, Field

# Что операция делает с каналом («публикует:» / «потребляет:» в пометке). Слова свои,
# а не «пишет/читает»: семантика доставки другая — сопровождение спрашивает «кто ещё
# потребляет это событие», а не «кто пишет в топик» (решение §7.1 плана).
ChannelAccessMode = Literal["publish", "consume"]


class ChannelFieldCreate(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    # Тип как В СЕРИАЛИЗАЦИИ («string», «uuid», «int64») — по языкам не нормализуем.
    type: str = Field(default="", max_length=128)
    required: bool = False
    description: str | None = None
    order: int = 0


class ChannelFieldUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=256)
    type: str | None = Field(default=None, max_length=128)
    required: bool | None = None
    description: str | None = None
    order: int | None = None


class ChannelFieldResponse(BaseModel):
    id: uuid.UUID
    channel_id: uuid.UUID
    name: str
    type: str
    required: bool
    description: str | None
    order: int

    model_config = {"from_attributes": True}


class BrokerChannelCreate(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    # Группа/уровень изоляции движка (vhost, namespace, account). Пусто = без группы.
    group_name: str = Field(default="", max_length=128)
    # topic | queue | exchange | stream | subject — свободная строка ради
    # универсальности движков; типовые значения подсказывает интерфейс.
    kind: str = Field(default="", max_length=64)
    partition_key: str = Field(default="", max_length=256)
    # at-least-once | at-most-once | exactly-once — тоже свободная строка.
    delivery: str = Field(default="", max_length=64)
    retention: str = Field(default="", max_length=128)
    description: str | None = None


class BrokerChannelUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=256)
    group_name: str | None = Field(default=None, max_length=128)
    kind: str | None = Field(default=None, max_length=64)
    partition_key: str | None = Field(default=None, max_length=256)
    delivery: str | None = Field(default=None, max_length=64)
    retention: str | None = Field(default=None, max_length=128)
    description: str | None = None
    # CAS: версия, от которой клиент правил. Не совпала → 409. None — без проверки.
    base_version: int | None = None


class BrokerChannelResponse(BaseModel):
    id: uuid.UUID
    node_id: uuid.UUID
    name: str
    group_name: str
    kind: str
    partition_key: str
    delivery: str
    retention: str
    description: str | None
    version: int
    fields: list[ChannelFieldResponse] = []

    model_config = {"from_attributes": True}


class ChannelUsage(BaseModel):
    """Обратный индекс: кто публикует и кто потребляет этот канал.

    Разворот пометок «публикует:/потребляет:» из схем логики проекта — ради него
    структура каналов и заводилась: перечень каналов говорит, ЧТО брокер переносит,
    а индекс — кто кладёт событие и кто его ждёт (вопрос «кого сломает изменение»).
    """

    channel_id: uuid.UUID
    channel_name: str
    # Поле сообщения, если пометка называла глубину «канал.поле»; None — обращение к
    # каналу целиком (в том числе когда названного поля в канале нет).
    field_id: uuid.UUID | None
    field_name: str | None
    mode: ChannelAccessMode
    doc_id: uuid.UUID
    doc_name: str
    node_id: uuid.UUID
    node_name: str
