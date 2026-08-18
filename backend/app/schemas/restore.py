"""Снимок удаляемого поддерева и его восстановление (Undo удаления узла).

Удаление узла сносит БД-каскадом не только само поддерево, но и ВСЮ его
документацию (схемы логики, таблицы БД с колонками, каналы брокера с полями),
инцидентные рёбра и строки раскладки (view_layout: свои виды — каскадом view_id,
ссылки из чужих видов — явной чисткой delete_node). Снимок собирается на бэке:
только он знает всё, что исчезнет. Схемы несут исходные id явно — restore
воссоздаёт строки с их сохранением (обычный create_node генерит новый id, поэтому
здесь отдельный путь).

Поля снимков — НЕ ручной перечень «что вспомнили»: их полноту сторожит
tests/test_restore.py, сверяя каждую схему с колонками-данными её модели по
app/copy_plan.py, а состав снимка — с реестром app/restore.py SNAPSHOT_PLAN. Так
класс «новое поле молча не доехало» (так снимок потерял source_ref, а таблицы и
каналы не попали в него вовсе) ловит гейт, а не пользователь.
"""

import uuid

from pydantic import BaseModel

from app.schemas.node import NodeShape, NodeStatus
from app.schemas.node_doc import NodeDocKind


class NodeSnapshot(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None = None
    role: str | None = None
    technology: str | None = None
    parent_id: uuid.UUID | None = None
    openapi_spec: str | None = None
    is_external: bool = False
    shape: NodeShape = "service"
    status: NodeStatus = "existing"
    # Якорь источника (импорт/синк «Архитектура из кода»): без него откат удаления
    # возвращал узел, которого следующий прогон агента не узнаёт — и заводил дубль.
    source_ref: str | None = None

    model_config = {"from_attributes": True}


class NodeDocSnapshot(BaseModel):
    """Док логики узла (node_docs) — умирает БД-каскадом вместе с узлом,
    восстанавливается с исходным id."""

    id: uuid.UUID
    node_id: uuid.UUID
    name: str
    kind: NodeDocKind = "overview"
    operation: str | None = None
    content: str = ""

    model_config = {"from_attributes": True}


class DbTableSnapshot(BaseModel):
    """Таблица узла-БД (db_tables) — умирает БД-каскадом node_id вместе с узлом.
    Структура базы это её «контракт», ровно как openapi_spec у сервиса: терять его
    при откате удаления — та же молчаливая потеря, что и потеря самого узла."""

    id: uuid.UUID
    node_id: uuid.UUID
    name: str
    schema_name: str = ""
    description: str | None = None

    model_config = {"from_attributes": True}


class DbColumnSnapshot(BaseModel):
    """Колонка таблицы (db_columns) — умирает каскадом table_id.

    references_column_id (внешний ключ КАРТЫ) переносится как есть: id при
    восстановлении сохраняются, поэтому ссылка снова находит свою цель. Порядок
    вставки при этом всё равно важен — см. restore_from_snapshot.
    """

    id: uuid.UUID
    table_id: uuid.UUID
    name: str
    type: str = ""
    nullable: bool = True
    is_primary_key: bool = False
    references_column_id: uuid.UUID | None = None
    description: str | None = None
    order: int = 0

    model_config = {"from_attributes": True}


class BrokerChannelSnapshot(BaseModel):
    """Канал узла-брокера (broker_channels) — умирает каскадом node_id.
    Имя канала несёт мягкую ссылку от связи (Edge.channel): вернуть узел без каналов
    значит порвать шов «стрелка → канал» ещё и в исходной схеме."""

    id: uuid.UUID
    node_id: uuid.UUID
    name: str
    group_name: str = ""
    kind: str = ""
    partition_key: str = ""
    delivery: str = ""
    retention: str = ""
    description: str | None = None

    model_config = {"from_attributes": True}


class ConfigParamSnapshot(BaseModel):
    """Параметр конфигурации сервиса (config_params) — умирает каскадом node_id.
    Перечень ручек сервиса — такой же его «контракт», как таблицы у базы: вернуть
    узел без конфигурации значит вернуть его без части документации, а пометки
    «зависит от:» в схемах логики после этого повисли бы замечаниями."""

    id: uuid.UUID
    node_id: uuid.UUID
    name: str
    description: str | None = None
    value_type: str = ""
    required: bool = False
    default_value: str = ""

    model_config = {"from_attributes": True}


class ChannelFieldSnapshot(BaseModel):
    """Поле сообщения канала (channel_fields) — умирает каскадом channel_id."""

    id: uuid.UUID
    channel_id: uuid.UUID
    name: str
    type: str = ""
    required: bool = False
    description: str | None = None
    order: int = 0

    model_config = {"from_attributes": True}


class EdgeSnapshot(BaseModel):
    id: uuid.UUID
    label: str | None = None
    technology: str | None = None
    # Канал брокера: без него откат удаления возвращал бы связь БЕЗ канала —
    # молчаливая потеря поля (урок «nodeFields без status»).
    channel: str | None = None
    source_id: uuid.UUID
    target_id: uuid.UUID
    is_synchronous: bool | None = None

    model_config = {"from_attributes": True}


class ViewLayoutItemSnapshot(BaseModel):
    """Строка раскладки (view_layout), которую снесёт удаление: позиция узла или
    геометрия пучка — на любом виде, где поддерево участвовало."""
    view_id: uuid.UUID | None = None
    item_id: str
    payload: dict

    model_config = {"from_attributes": True}


class DeletionSnapshot(BaseModel):
    """Полный снимок того, что исчезнет при удалении узла: поддерево узлов, ВСЯ их
    документация (схемы логики, таблицы БД с колонками, каналы брокера с полями,
    параметры конфигурации), инцидентные рёбра и строки раскладки. Достаточно для
    точного восстановления."""

    nodes: list[NodeSnapshot]
    edges: list[EdgeSnapshot]
    layout_items: list[ViewLayoutItemSnapshot] = []
    # Дефолты [] у всех коллекций документации: снимок, снятый ПРЕЖНЕЙ версией (он
    # живёт в памяти открытой сессии и в истории Undo), обязан остаться валидным —
    # иначе выкатка ломала бы откат уже начатых удалений.
    node_docs: list[NodeDocSnapshot] = []
    db_tables: list[DbTableSnapshot] = []
    db_columns: list[DbColumnSnapshot] = []
    broker_channels: list[BrokerChannelSnapshot] = []
    channel_fields: list[ChannelFieldSnapshot] = []
    config_params: list[ConfigParamSnapshot] = []
