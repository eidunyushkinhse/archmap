"""Длины строковых колонок — проверка перед записью (аудит 2026-10, M2/S4/S5/S8).

На Postgres значение длиннее String(n) — DataError, то есть 500. SQLite длину
VARCHAR не проверяет вовсе, поэтому тесты класс ошибок не видели. Зеркалить длины в
схемах запросов мало: в те же колонки пишут импорт архива и YAML, снимки отката,
синк и доки от агента — мимо схем. Поэтому проверка стоит у самой записи: слушатель
before_flush смотрит каждую ограниченную колонку у новых и изменённых строк и
отказывает понятным 422 до того, как запрос дойдёт до базы.

Почему не max_length в схемах: отказ pydantic — 422 со СПИСКОМ ошибок, а фронт
показывает detail строкой (вышел бы «[object Object]»); здесь detail — текст.
"""

from collections.abc import Iterable
from typing import Any

from sqlalchemy import String, event, inspect
from sqlalchemy.orm import Mapper, Session


class ValueTooLong(Exception):
    """Значение не помещается в колонку. main.py отдаёт его как 422 {"detail": …}."""

    def __init__(self, field: str, limit: int) -> None:
        self.field = field
        self.limit = limit
        self.detail = f"Поле «{field}» длиннее {limit} символов"
        super().__init__(self.detail)


# Класс модели → [(атрибут, предел)]: разбор маппинга один раз на класс.
_LIMITS: dict[type, list[tuple[str, int]]] = {}


def _limits_of(cls: type) -> list[tuple[str, int]]:
    cached = _LIMITS.get(cls)
    if cached is None:
        cached = []
        mapper: Mapper[Any] = inspect(cls)
        for prop in mapper.column_attrs:
            col_type = prop.columns[0].type
            # Text и String без длины — без предела; Enum — подкласс String, его длина
            # тоже честная.
            if isinstance(col_type, String) and col_type.length:
                cached.append((prop.key, col_type.length))
        _LIMITS[cls] = cached
    return cached


def check_lengths(objects: Iterable[object]) -> None:
    """Первое значение длиннее своей колонки → ValueTooLong."""
    for obj in objects:
        for key, limit in _limits_of(type(obj)):
            value = obj.__dict__.get(key)
            if isinstance(value, str) and len(value) > limit:
                raise ValueTooLong(key, limit)


def _before_flush(session: Session, _ctx: object, _instances: object) -> None:
    check_lengths([*session.new, *session.dirty])


def install() -> None:
    """Повесить проверку на все сессии (идемпотентно): и рабочие, и тестовые."""
    if not event.contains(Session, "before_flush", _before_flush):
        event.listen(Session, "before_flush", _before_flush)
