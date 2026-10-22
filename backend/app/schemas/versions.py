"""Снимок версии документации объекта (docs/tasks/doc-versions.md §3).

Строки — те же схемы, что у снимка удаления (app/schemas/restore.py): они несут
исходные id, а их полноту против моделей сторожит tests/test_restore.py по декларации
app/copy_plan.py. Параллельных схем здесь нет намеренно: новое поле модели доезжает до
версии само, вместе со снимком удаления. Сверх них версия несёт пути концов связей
(для показа дельты) и процессы с участием объекта.
"""

import uuid

from pydantic import BaseModel

from app.schemas.process import ProcessDetail
from app.schemas.restore import (
    BrokerChannelSnapshot,
    ChannelFieldSnapshot,
    ConfigParamSnapshot,
    DbColumnSnapshot,
    DbTableSnapshot,
    EdgeSnapshot,
    NodeDocSnapshot,
    NodeSnapshot,
)


class VersionEdge(EdgeSnapshot):
    """Связь с хотя бы одним концом в поддереве. Пути концов именами («Система /
    Сервис») — для показа: у связи с узлом вне поддерева другого конца в снимке нет, и
    дельте нечем было бы его подписать. В content_hash пути не входят — переименование
    чужого узла не изменение документации объекта."""

    source_path: str
    target_path: str


class ProcessVersion(BaseModel):
    """Процесс, в котором участвует узел поддерева: detail целиком и готовый mermaid.

    mermaid — производное от detail (process_export.detail_to_mermaid), хранится ради
    построчной дельты и показа «было/стало»; в content_hash не входит."""

    id: uuid.UUID
    name: str
    scope_node_id: uuid.UUID | None
    detail: ProcessDetail
    mermaid: str


class VersionSnapshot(BaseModel):
    """Срез документации объекта с поддеревом (root_id) или всего проекта (root_id —
    None). Все списки отсортированы по str(id) — два снимка одного состояния совпадают
    байт-в-байт.

    Раскладки холста нет намеренно: версия — семантика документации, а позиции блоков
    к ней не относятся (решение пользователя, ТЗ §2 п.7)."""

    root_id: uuid.UUID | None
    nodes: list[NodeSnapshot]
    edges: list[VersionEdge]
    node_docs: list[NodeDocSnapshot]
    db_tables: list[DbTableSnapshot]
    db_columns: list[DbColumnSnapshot]
    broker_channels: list[BrokerChannelSnapshot]
    channel_fields: list[ChannelFieldSnapshot]
    config_params: list[ConfigParamSnapshot]
    processes: list[ProcessVersion]
