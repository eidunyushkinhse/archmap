"""Отчёт импорта архива знания (Ф4, docs/plan-archive-export.md).

Сводка ПО КАТЕГОРИЯМ: семьи фактов отдают свои родные отчёты (те же, что у
BYOA-дозаливки — вторых форматов отчёта не заводим), процессы — свои. Замечания
верхнего уровня (неразрешённые адреса доков/спек, пропавшие файлы) — общим
списком: деградация видимая, а не тихая.
"""

import uuid

from pydantic import BaseModel

from app.schemas.channels_import import ChannelsImportReport
from app.schemas.config_import import ConfigImportReport
from app.schemas.data_import import DataImportReport
from app.schemas.process_import import ProcessImportResult


class ArchiveImportResult(BaseModel):
    project_id: uuid.UUID
    project_name: str
    nodes: int
    edges: int
    docs_created: int
    specs_applied: int
    # Отчёты семей — None, если категории в архиве не было вовсе.
    db: DataImportReport | None = None
    channels: ChannelsImportReport | None = None
    config: ConfigImportReport | None = None
    processes: list[ProcessImportResult] = []
    warnings: list[str] = []
    # Споров о телах фактов, разрешённых при ввозе (единый импорт, Ф2а): дефолтом
    # плана или явным выбором пользователя. У одноархивного импорта споров нет по
    # построению — там всегда 0, поэтому поле с дефолтом, а не второй формат отчёта.
    resolved_conflicts: int = 0
