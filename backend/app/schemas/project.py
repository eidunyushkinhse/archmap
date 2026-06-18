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


class ProjectResponse(BaseModel):
    """Проект с метаданными для карточки лендинга. Счётчики/редактор — вычисляемые,
    поэтому собирается вручную в роутере (не from_attributes)."""

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
