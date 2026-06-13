from typing import Literal

from pydantic import BaseModel


class ExportResponse(BaseModel):
    """Экспорт схемы как текст. format держим явным полем, чтобы позже добавить
    другие сериализации (mermaid/json) без слома контракта; content — сам документ."""

    format: Literal["yaml"]
    content: str
