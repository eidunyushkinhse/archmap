"""Контракт превью пометок обращений для редактора схемы логики (пивот §9).

Плашка редактора спрашивает про ТЕКСТ, которого в базе ещё нет (пользователь его
печатает), поэтому вход — сам content, а не id дока: превью обязано отвечать до
сохранения. Резолв — по каталогу ВСЕГО проекта, как у обратного индекса базы.
"""

from typing import Literal

from pydantic import BaseModel

# Режим пометки — ОБЕ семьи сразу: плашка одна на док, а в одном доке рядом стоят и
# «пишет: orders», и «публикует: orders.created». Зеркалит app.data_refs.Mode.
DataRefMode = Literal["read", "write", "publish", "consume"]

# Итог резолва одной пометки. Зеркалит доменный app.data_refs.RefStatus (там —
# внутренний тип, здесь — контракт наружу); расхождение поймает mypy на
# присваивании в роутере. Статусы табличной и канальной семей разные («таблицы нет»
# и «канала нет» — разные починки), общий у них только «ambiguous».
DataRefStatus = Literal[
    "ok",
    "unknown_table",
    "unknown_column",
    "unknown_channel",
    "unknown_field",
    "ambiguous",
]


class DataRefPreviewIn(BaseModel):
    """Текст дока как он сейчас в редакторе (может быть несохранённым)."""

    content: str


class DataRefPreviewItem(BaseModel):
    """Одна пометка глазами резолва: что написано, что это значит и куда ведёт."""

    ref: str  # ссылка как написана в тексте
    mode: DataRefMode
    status: DataRefStatus
    # Готовая подпись цели для плашки: «<база> · <таблица>[.<колонка>]», у каналов —
    # «<брокер> · <канал>[.<поле>]». None у unknown_table/unknown_channel/ambiguous —
    # цели нет вовсе, показывать нечего (у ambiguous выбрать одну из подходящих
    # запрещено: см. app/data_refs.py).
    target: str | None
