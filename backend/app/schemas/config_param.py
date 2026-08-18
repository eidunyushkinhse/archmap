"""Контракт конфигурации сервиса — параметры и переменные окружения.

Третья семья фактов (docs/plan-config-docs.md). Как и у двух предыдущих, обращения
живут не записями, а ПОМЕТКОЙ «зависит от:» в тексте схемы логики; здесь описан
только сам перечень ручек, которые сервис читает.

ЗНАЧЕНИЙ НЕТ НИ В ОДНОЙ СХЕМЕ — сознательно: default_value несёт текст дефолта из
кода, а не значение, подставленное средой (§2.5 плана).
"""

import uuid

from pydantic import BaseModel, Field


class ConfigParamCreate(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    description: str | None = None
    # «string», «int», «bool», «duration», «json» — свободная строка ради разнообразия
    # конфигов; типовые значения подсказывает интерфейс.
    value_type: str = Field(default="", max_length=64)
    required: bool = False
    # Текст дефолта из кода («30s», «false»), НЕ значение среды.
    default_value: str = Field(default="", max_length=512)


class ConfigParamUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=256)
    description: str | None = None
    value_type: str | None = Field(default=None, max_length=64)
    required: bool | None = None
    default_value: str | None = Field(default=None, max_length=512)
    # CAS: версия, от которой клиент правил. Не совпала → 409. None — без проверки.
    base_version: int | None = None


class ConfigParamUsage(BaseModel):
    """Обратный индекс: какая схема логики зависит от этого параметра.

    Разворот пометок «зависит от:» — ради него конфигурация и заводилась: перечень
    ручек говорит, ЧТО у сервиса переключается, а индекс — что именно сломается,
    если ручку убрать.

    Узла в строке НЕТ, и это не упущение: сослаться на параметр может только схема
    ТОГО ЖЕ объекта (§3 плана), так что колонка «кто» несла бы одно и то же имя во
    всех строках. У таблиц и каналов она есть именно потому, что там зовущий — чужой.
    """

    param_id: uuid.UUID
    param_name: str
    doc_id: uuid.UUID
    doc_name: str


class ConfigParamResponse(BaseModel):
    id: uuid.UUID
    node_id: uuid.UUID
    name: str
    description: str | None
    value_type: str
    required: bool
    default_value: str
    version: int

    model_config = {"from_attributes": True}
