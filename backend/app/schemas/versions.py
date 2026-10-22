"""Снимок версии документации объекта (docs/tasks/doc-versions.md §3).

Строки — те же схемы, что у снимка удаления (app/schemas/restore.py): они несут
исходные id, а их полноту против моделей сторожит tests/test_restore.py по декларации
app/copy_plan.py. Параллельных схем здесь нет намеренно: новое поле модели доезжает до
версии само, вместе со снимком удаления. Сверх них версия несёт пути концов связей
(для показа дельты) и процессы с участием объекта.

Ниже снимка — контракт дельты двух версий (app/versions_diff.py, ТЗ §4): плоский
список элементов и три представления одного элемента («Изменения · Было · Стало»).
"""

import uuid
from datetime import datetime

from pydantic import BaseModel

from app.domain_types import DiffMark, VersionCategory, VersionItemStatus, VersionKind
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


# ── Дельта ─────────────────────────────────────────────────────────────────────


class VersionItem(BaseModel):
    """Элемент дельты — строка экрана «что изменилось в версии».

    item_id — адрес элемента для GET …/diff/{item_id}: «props:<id узла>»,
    «approval:<id узла>», «edge:<id связи>», «doc:<id схемы>», «spec:<id узла>»,
    «table:<id таблицы>», «channel:<id канала>», «config:<id узла>», «process:<id
    процесса>». node_path — путь объекта ВНУТРИ среза именами («Заказы / Сервис
    заказов»; у самого корня среза — пустая строка, у процесса — тоже: он общий).
    summary — короткая подробность для строки списка («+3 −2», «переименована: A → B»,
    «+1 ~1», «+2 ~1 шага», «в работе → согласовано»); статус словами — по status."""

    item_id: str
    category: VersionCategory
    node_path: str
    name: str
    status: VersionItemStatus
    summary: str


class DiffLine(BaseModel):
    """Строка построчной дельты текста: mark «add»/«del» — добавлена/удалена, пусто —
    контекст, «mod» — заголовок куска («@@ -3,4 +3,5 @@») или смена свойства схемы
    («имя: A → B»)."""

    mark: DiffMark
    text: str


class VersionRow(BaseModel):
    """Строка таблицы представления: свойство, связь, колонка, параметр или шаг. В
    «изменениях» у изменённой строки ячейка с отличием — «было → стало»; в «было» и
    «стало» метка всегда пустая."""

    mark: DiffMark
    cells: list[str]


class VersionView(BaseModel):
    """Одно представление элемента — ровно одна из трёх форм: text — полный текст
    (схема, спека на версии), lines — построчная дельта текста, columns + rows —
    таблица (свойства, связи, факты, шаги процесса). Все четыре поля пусты — элемента
    на этой стороне нет («было» у добавленного, «стало» у удалённого).

    Поля без дефолтов намеренно: в генерате фронта все четыре обязательны (string |
    null), и форма выбирается проверкой на null, а не на «поле есть»."""

    text: str | None
    lines: list[DiffLine] | None
    columns: list[str] | None
    rows: list[VersionRow] | None


class VersionItemDetail(BaseModel):
    """Один элемент дельты с тремя представлениями: «Изменения · Было · Стало»."""

    item: VersionItem
    changes: VersionView
    before: VersionView
    after: VersionView


class VersionRef(BaseModel):
    """Сторона сравнения: версия с номером или текущее состояние (number — null)."""

    number: int | None
    comment: str | None
    created_at: datetime | None


class VersionDiff(BaseModel):
    """Дельта от base к target. base — null: сравнивать не с чем (первая версия с
    «предыдущей»), всё содержимое target — добавлено."""

    base: VersionRef | None
    target: VersionRef
    items: list[VersionItem]


# ── Запись версии ──────────────────────────────────────────────────────────────


class VersionChanged(BaseModel):
    """Изменённый элемент относительно предыдущей версии — для строки списка
    («изменено: …») и вопроса «в каких версиях менялась схема». Хранится в stats."""

    item_id: str
    category: VersionCategory
    name: str
    status: VersionItemStatus


class VersionStats(BaseModel):
    """Счётчики версии по категориям (versions_snapshot.stats) и перечень изменённого
    относительно предыдущей версии объекта; у первой — относительно пустого."""

    nodes: int
    edges: int
    docs: int
    tables: int
    channels: int
    params: int
    processes: int
    changed: list[VersionChanged] = []


class VersionPending(BaseModel):
    """Есть ли незафиксированные изменения с последней версии: changed — сравнение
    хэшей, items — что именно. Версий ещё нет — changed true, items пуст: перечислять
    всю документацию объекта незачем."""

    changed: bool
    items: list[VersionItem]


# ── API ────────────────────────────────────────────────────────────────────────


class VersionCreate(BaseModel):
    """Фиксация версии: комментарий обязателен — по нему версию ищут (номер релиза,
    задачи). Пустой после обрезки пробелов — 422; длиннее 512 — 422 column_limits."""

    comment: str


class VersionOut(BaseModel):
    """Строка списка версий. author — имя пользователя, зафиксировавшего версию; null —
    пользователь удалён (история остаётся без автора)."""

    number: int
    comment: str
    kind: VersionKind
    restored_from: int | None
    created_at: datetime
    author: str | None
    stats: VersionStats


class VersionList(BaseModel):
    """Версии объекта (новые сверху) и есть ли изменения с последней."""

    versions: list[VersionOut]
    pending: VersionPending


class VersionText(BaseModel):
    """Текст на версии: схема логики (name — её имя), спека OpenAPI (name — имя
    объекта) или процесс в mermaid (name — имя процесса)."""

    name: str
    text: str
