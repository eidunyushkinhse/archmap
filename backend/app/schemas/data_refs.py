"""Контракт превью пометок обращений для редактора схемы логики (пивот §9).

Плашка редактора спрашивает про ТЕКСТ, которого в базе ещё нет (пользователь его
печатает), поэтому вход — сам content, а не id дока: превью обязано отвечать до
сохранения. Резолв — по каталогу ВСЕГО проекта, как у обратного индекса базы.
"""

from typing import Literal

from pydantic import BaseModel

from app.schemas.db_doc import DataAccessMode

# Итог резолва одной пометки. Зеркалит доменный app.data_refs.RefStatus (там —
# внутренний тип, здесь — контракт наружу); расхождение поймает mypy на
# присваивании в роутере.
DataRefStatus = Literal["ok", "unknown_table", "ambiguous", "unknown_column"]


class DataRefPreviewIn(BaseModel):
    """Текст дока как он сейчас в редакторе (может быть несохранённым)."""

    content: str


class DataRefPreviewItem(BaseModel):
    """Одна пометка глазами резолва: что написано, что это значит и куда ведёт."""

    ref: str  # ссылка как написана в тексте
    mode: DataAccessMode
    status: DataRefStatus
    # Готовая подпись цели для плашки: «<база> · <таблица>[.<колонка>]». None у
    # unknown_table/ambiguous — цели нет вовсе, показывать нечего (у ambiguous
    # выбрать одну из подходящих запрещено: см. app/data_refs.py).
    target: str | None
