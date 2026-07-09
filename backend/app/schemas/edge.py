import uuid
from datetime import datetime

from pydantic import BaseModel

# NB: геометрия стрелок на связи не живёт — её целиком ведёт авто-раскладка
# фронта (ручной слой изломов/хэндлов удалён 2026-07-09). Связь несёт только
# семантику.


class EdgeCreate(BaseModel):
    label: str | None = None
    technology: str | None = None
    source_id: uuid.UUID
    target_id: uuid.UUID
    # Синхронность канала (бизнес-процессы): null=дефолт (синхронный), true/false=явный выбор
    is_synchronous: bool | None = None


class EdgeUpdate(BaseModel):
    label: str | None = None
    technology: str | None = None
    # Смена концов связи (в т.ч. на узел другого уровня → связь становится сквозной)
    source_id: uuid.UUID | None = None
    target_id: uuid.UUID | None = None
    # Синхронность канала (бизнес-процессы): null=дефолт (синхронный), true/false=явный выбор
    is_synchronous: bool | None = None


class EdgeResponse(BaseModel):
    id: uuid.UUID
    label: str | None
    technology: str | None
    source_id: uuid.UUID
    target_id: uuid.UUID
    # Синхронность канала: null=дефолт (синхронный), true/false=явный выбор архитектора
    is_synchronous: bool | None = None
    created_at: datetime

    model_config = {"from_attributes": True}
