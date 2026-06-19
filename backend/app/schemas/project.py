import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    description: str | None = None
    # Старт схемы: "blank" — пусто; "template:<id>" — преднастроенный каркас;
    # "copy:<projectId>" — глубокая копия другого проекта. Парсится в роутере.
    start: str = "blank"


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=256)
    description: str | None = None


class ProjectPreviewNode(BaseModel):
    """Корневой узел схемы для мини-превью карточки. x/y — сохранённая раскладка
    холста (null, если узел ни разу не двигали — тогда фронт раскладывает сам)."""

    id: uuid.UUID
    is_external: bool
    x: float | None
    y: float | None


class ProjectPreviewEdge(BaseModel):
    """Связь корневого уровня: концы спроецированы на корневых предков (как ghost-
    проекция на холсте). source/target — id узлов из nodes того же превью."""

    source: uuid.UUID
    target: uuid.UUID


class ProjectPreview(BaseModel):
    """Реальная топология корневого уровня схемы в миниатюре (узлы + связи между
    ними). Пустая схема → пустые списки."""

    nodes: list[ProjectPreviewNode]
    edges: list[ProjectPreviewEdge]


class ProjectResponse(BaseModel):
    """Проект с метаданными для карточки лендинга. Счётчики/редактор/превью —
    вычисляемые, поэтому собирается вручную в роутере (не from_attributes)."""

    id: uuid.UUID
    name: str
    description: str | None
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime
    object_count: int
    edge_count: int
    # Имя пользователя, менявшего схему последним (инициалы фронт выводит сам); null —
    # никто не менял после создания или пользователь удалён.
    updated_by: str | None
    # Мини-граф корневого уровня для карточки (реальные узлы/связи).
    preview: ProjectPreview
