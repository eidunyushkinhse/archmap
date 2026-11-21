"""Сигнал CI о слиянии в репозитории (app/code_changes.py) — контракт POST
/api/v1/code-changes. Напоминание в проекте приходит классом рекомендаций
(schemas/alerts.CodeChangeAlert)."""

import uuid

from pydantic import BaseModel, Field


class CodeChangeIn(BaseModel):
    # Адрес репозитория в любом виде git: https, ssh или git@host:org/repo.git. Учётные
    # данные в адресе отбрасываются и не хранятся.
    repo: str = Field(min_length=1, max_length=1024)
    # Хэш коммита слияния: по нему агент потом смотрит, что поменялось.
    commit: str | None = Field(default=None, pattern=r"^[0-9a-fA-F]{7,64}$")
    # Ветка, в которую слили (обычно main).
    branch: str | None = Field(default=None, max_length=255)


class CodeChangeProject(BaseModel):
    """Проект, которому ушло напоминание, и сколько в нём объектов из репозитория."""

    id: uuid.UUID
    name: str
    objects: int


class CodeChangeOut(BaseModel):
    # Репозиторий как его сравнивает ArchMap: без схемы, учётных данных и порта.
    repo: str
    # Пусто — ни у одного видимого проекта объектов из репозитория нет: CI не падает,
    # но в журнале это видно.
    projects: list[CodeChangeProject]
