from typing import Literal

from pydantic import BaseModel


class ExportResponse(BaseModel):
    """Экспорт схемы как текст. format держим явным полем, чтобы позже добавить
    другие сериализации без слома контракта; content — сам документ. mermaid —
    экспорт процесса (Ф2 архива: конвертер переехал с фронта единственной
    реализацией)."""

    format: Literal["yaml", "mermaid"]
    content: str
