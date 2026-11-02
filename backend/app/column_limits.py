"""Длины строковых колонок — проверка перед записью (аудит 2026-10, M2/S4/S5/S8).

На Postgres значение длиннее String(n) — DataError, то есть 500. SQLite длину
VARCHAR не проверяет вовсе, поэтому тесты класс ошибок не видели. Зеркалить длины в
схемах запросов мало: в те же колонки пишут импорт архива и YAML, снимки отката,
синк и доки от агента — мимо схем. Поэтому проверка стоит у самой записи: слушатель
before_flush смотрит каждую ограниченную колонку у новых и изменённых строк и
отказывает понятным 422 до того, как запрос дойдёт до базы.

Почему не max_length в схемах: отказ pydantic — 422 со СПИСКОМ ошибок, а фронт
показывает detail строкой (вышел бы «[object Object]»); здесь detail — текст.

Превью ввоза объектов не создаёт и до flush не доходит, поэтому те же пределы оно
берёт отсюда же помощником too_long: ошибка разбора с путём до поля в документе
(«nodes[0].children[4].technology: длиннее 128 символов»), чтобы агент чинил документ
до применения, а не после отказа записи. Своих таблиц пределов у разборщиков нет.

Отказ записи называет поле словами продукта («Поле «Технология» длиннее 128 символов»),
а не именем колонки: имена берутся из FIELD_WORDS ниже, одной таблицы на весь сервер.
Ошибка разбора остаётся с путём до ключа в документе: его пишет агент или человек, и
ключ файла (technology) там и есть имя поля.
"""

from collections.abc import Iterable
from typing import Any

from sqlalchemy import String, event, inspect
from sqlalchemy.orm import Mapper, Session

# Имена полей словами интерфейса: атрибут модели → подпись, как её видит человек в окнах
# и разделах страницы объекта. Общий словарь по атрибуту и уточнения по модели, где одно
# имя атрибута значит разное (name таблицы — «Имя таблицы», name объекта — «Название»).
# Атрибута нет ни там, ни там — служебное поле, которое человек не вводит: отказ без
# имени («Значение длиннее N символов»). Вторую копию словаря в других модулях не заводить.
FIELD_WORDS: dict[str, str] = {
    "name": "Название",
    "role": "Роль",
    "technology": "Технология",
    "label": "Подпись",
    "channel": "Канал",
    "source_ref": "Источник",
    "shape": "Тип",
    "element": "Тип",
    "status": "Статус",
    "approval": "Статус страницы",
    "kind": "Вид",
    "group_name": "Группа",
    "partition_key": "Ключ партиции",
    "delivery": "Доставка",
    "retention": "Хранение",
    "type": "Тип",
    "value_type": "Тип значения",
    "default_value": "Значение по умолчанию",
    "schema_name": "Схема базы данных",
    "operation": "Операция",
    "comment": "Комментарий",
    "guard": "Условие",
    "caption": "Подпись",
    "username": "Логин",
}
FIELD_WORDS_BY_MODEL: dict[tuple[str, str], str] = {
    ("DbTable", "name"): "Имя таблицы",
    ("DbColumn", "name"): "Имя колонки",
    ("BrokerChannel", "name"): "Имя канала",
    ("ChannelField", "name"): "Имя поля",
    ("ConfigParam", "name"): "Имя параметра",
    ("NodeDoc", "name"): "Имя схемы",
    ("DeploymentSite", "name"): "Имя площадки",
    ("ProcessParticipant", "name"): "Имя участника",
}


def field_word(cls: type, key: str) -> str | None:
    """Подпись поля key модели cls словами интерфейса; None — служебное поле без подписи."""
    return FIELD_WORDS_BY_MODEL.get((cls.__name__, key)) or FIELD_WORDS.get(key)


class ValueTooLong(Exception):
    """Значение не помещается в колонку. main.py отдаёт его как 422 {"detail": …}.
    field — имя атрибута модели (для кода), detail — текст для человека."""

    def __init__(self, cls: type, field: str, limit: int) -> None:
        self.field = field
        self.limit = limit
        word = field_word(cls, field)
        self.detail = (
            f"Поле «{word}» {_longer(limit)}" if word else f"Значение {_longer(limit)}"
        )
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


def _longer(limit: int) -> str:
    """Общая часть отказа записи и ошибки разбора: текст один на оба пути."""
    return f"длиннее {limit} символов"


def column_limit(cls: type, key: str) -> int | None:
    """Предел строковой колонки key модели cls; None — без предела (Text, не строка)."""
    return dict(_limits_of(cls)).get(key)


def too_long(path: str, value: object, cls: type, key: str) -> str | None:
    """Ошибка разбора «путь: длиннее N символов», если строка value не поместится в
    колонку key модели cls, иначе None. Предел — тот же, что проверит запись
    (check_lengths); путь — до поля в документе ввоза."""
    limit = column_limit(cls, key)
    if limit is not None and isinstance(value, str) and len(value) > limit:
        return f"{path}: {_longer(limit)}"
    return None


def check_lengths(objects: Iterable[object]) -> None:
    """Первое значение длиннее своей колонки → ValueTooLong."""
    for obj in objects:
        for key, limit in _limits_of(type(obj)):
            value = obj.__dict__.get(key)
            if isinstance(value, str) and len(value) > limit:
                raise ValueTooLong(type(obj), key, limit)


def _before_flush(session: Session, _ctx: object, _instances: object) -> None:
    check_lengths([*session.new, *session.dirty])


def install() -> None:
    """Повесить проверку на все сессии (идемпотентно): и рабочие, и тестовые."""
    if not event.contains(Session, "before_flush", _before_flush):
        event.listen(Session, "before_flush", _before_flush)
