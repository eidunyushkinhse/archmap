import uuid
from datetime import datetime

from pydantic import BaseModel


class Point(BaseModel):
    """Точка-сгиб пути стрелки в координатах графа уровня."""

    x: float
    y: float


class EdgeCreate(BaseModel):
    label: str | None = None
    technology: str | None = None
    source_id: uuid.UUID
    target_id: uuid.UUID
    source_handle: str | None = None
    target_handle: str | None = None


class EdgeUpdate(BaseModel):
    label: str | None = None
    technology: str | None = None
    # Смена концов связи (в т.ч. на узел другого уровня → связь становится сквозной)
    source_id: uuid.UUID | None = None
    target_id: uuid.UUID | None = None
    source_handle: str | None = None
    target_handle: str | None = None
    # Кастомные точки-сгибы пути (ручные «обходы»); пустой список — сброс в авто-маршрут
    waypoints: list[Point] | None = None
    # Позиция плашки вдоль стрелки (доля пути 0..1); null — сброс в центр
    label_t: float | None = None


class EdgeResponse(BaseModel):
    id: uuid.UUID
    label: str | None
    technology: str | None
    source_id: uuid.UUID
    target_id: uuid.UUID
    source_handle: str | None
    target_handle: str | None
    waypoints: list[Point] | None = None
    label_t: float | None = None
    created_at: datetime

    model_config = {"from_attributes": True}
