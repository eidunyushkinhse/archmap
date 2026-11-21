"""Удаление пачкой с версией перед ним (app/deletions.py) — контракт POST /api/v1/deletions.

Путь агента и скриптов: личным токеном метод DELETE закрыт целиком, а удаляет он только
здесь, потому что здесь ArchMap сперва сохраняет версию, к которой человек откатит
удалённое в интерфейсе.
"""

import uuid

from pydantic import BaseModel, Field

from app.domain_types import DeletionKind

# Сколько пунктов в одной пачке: уборка за прогоном агента укладывается с запасом, а
# список в тысячи пунктов — уже не уборка, его разбирают глазами.
MAX_ITEMS = 200
# Предел причины: она идёт в комментарий версии (512 знаков) вместе с перечнем.
REASON_MAX = 200


class DeletionItem(BaseModel):
    kind: DeletionKind
    id: uuid.UUID


class DeletionRequest(BaseModel):
    items: list[DeletionItem] = Field(min_length=1, max_length=MAX_ITEMS)
    # Зачем удаляется: строка в комментарии версии «Перед удалением агентом».
    reason: str | None = Field(default=None, max_length=REASON_MAX)
    # Только посчитать, что уйдёт: ничего не удалять и версию не сохранять.
    dry_run: bool = False


class DeletionTarget(BaseModel):
    """Пункт пачки, как его поймёт человек: путь объекта, концы связи, схема у объекта."""

    kind: DeletionKind
    id: uuid.UUID
    label: str
    # Пункт уходит вместе с объектом той же пачки (вложенный объект, его связь или
    # схема): отдельно его не удаляют. None — удаляется сам.
    covered_by: uuid.UUID | None


class DeletionTotals(BaseModel):
    """Всё, что исчезнет, вместе с поддеревьями объектов пачки."""

    # Процессы пачки: откат их не вернёт, текст остаётся в версии всего проекта.
    processes: int
    nodes: int
    edges: int
    docs: int
    # Таблицы БД, каналы брокера и параметры конфигурации (колонки и поля — внутри них).
    facts: int
    # Размещения объектов на площадках.
    instances: int
    # Привязки процессов, которые останутся пустыми: участник без объекта, процесс без
    # области, шаг без связи или без схемы логики. Откат версии их не возвращает.
    process_links: int


class DeletionVersion(BaseModel):
    """Версия, к которой откатывают удалённое: ближайший общий родитель пачки."""

    # None — версия всего проекта (у пачки нет общего родителя ниже корня).
    node_id: uuid.UUID | None
    # Путь объекта; None — проект.
    label: str | None
    # Номер версии; None у dry_run (номер станет известен при удалении).
    number: int | None
    # True — версию сохранили перед удалением; False — изменений с последней версии не
    # было и откатывают к ней (или dry_run).
    created: bool


class DeletionOut(BaseModel):
    dry_run: bool
    items: list[DeletionTarget]
    totals: DeletionTotals
    version: DeletionVersion
