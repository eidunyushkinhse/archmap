import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field

# Один YAML-документ импорта (текст файла). Лимит — защита от «бомбы» в textarea.
_ImportDoc = Annotated[str, Field(max_length=2_000_000)]
# Максимум документов за раз (мульти-репо «Из репозитория»). Щедрый предел: реальные
# системы — десятки репозиториев (80+ сервисов, файл на репозиторий). Это лишь
# предохранитель от гигантского запроса: содержимое всё равно ограничено 2 МБ на файл
# и MAX_NODES/MAX_EDGES после слияния.
MAX_IMPORT_FILES = 256


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    description: str | None = None
    # Старт схемы: "blank" — пусто; "template:<id>" — преднастроенный каркас;
    # "copy:<projectId>" — глубокая копия другого проекта; "import" — схема из
    # YAML в формате экспорта (import_yaml либо import_yamls). Парсится в роутере.
    start: str = "blank"
    # YAML схемы в формате экспорта — только при start="import".
    import_yaml: str | None = Field(default=None, max_length=2_000_000)
    # Несколько YAML (мульти-репо): сливаются merge_imports. Приоритетнее import_yaml.
    import_yamls: list[_ImportDoc] | None = Field(default=None, max_length=MAX_IMPORT_FILES)


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=256)
    description: str | None = None


class ImportPreviewIn(BaseModel):
    """YAML для dry-run проверки импорта (без записи в БД): один текст (content)
    либо несколько (contents — мульти-репо, сливаются merge_imports)."""

    content: str | None = Field(default=None, max_length=2_000_000)
    contents: list[_ImportDoc] | None = Field(default=None, max_length=MAX_IMPORT_FILES)


class ImportPreviewOut(BaseModel):
    """Сводка dry-run импорта для живой валидации в модалке создания.
    Поля слияния заполнены и при одном файле (нулями) — фронт не ветвится."""

    ok: bool
    errors: list[str]  # пусто при ok=true
    node_count: int
    edge_count: int
    roots: list[str]  # имена корневых узлов (для сводки), не больше первых 8
    files: int = 1  # сколько документов разбиралось
    merged_count: int = 0  # узлов, склеенных из ≥2 файлов
    merged: list[str] = []  # пути склеенных узлов, не больше первых 8
    conflicts: list[str] = []  # расхождения полей (оставлено первое)
    warnings: list[str] = []  # fuzzy-пары, несовпавшие корни, похожие рёбра
    dropped_edges: int = 0  # выброшенные точные дубли рёбер


class SyncPreviewIn(BaseModel):
    """YAML свежего прогона агента для dry-run синхронизации ЖИВОГО проекта.
    Формат входа тот же, что у импорта (мульти-репо сливается merge_imports);
    отличаются только политики — что синку разрешено трогать."""

    contents: list[_ImportDoc] = Field(min_length=1, max_length=MAX_IMPORT_FILES)
    update_descriptions: bool = False
    update_names: bool = False
    sync_components: bool = False
    mark_missing_deprecated: bool = False
    # Снимать «устаревший» с вернувшихся в YAML. Симметрично пометке; см.
    # SyncPolicies — дефолт консервативный, потому что пометка могла быть ручной.
    restore_returned: bool = False


class SyncApplyIn(SyncPreviewIn):
    """Применение прогона. Вход тот же, что у превью (план ПЕРЕСЧИТЫВАЕТСЯ на
    сервере — клиентскому плану не доверяем), плюс курсор схемы, увиденный в
    превью: если схема успела измениться, применение отклоняется, а не пишет
    вслепую то, чего пользователь не видел."""

    base_graph_rev: int | None = None


class SyncNodeActionOut(BaseModel):
    path: str
    action: Literal["create", "update", "unchanged", "missing"]
    node_id: uuid.UUID | None = None
    source_ref: str | None = None
    fields: list[str] = []  # какие поля изменит update
    matched_by: Literal["source", "name"] | None = None  # чем опознан живой узел
    # Узел был помечен устаревшим, а в YAML снова есть. Показывается ВСЕГДА,
    # даже когда статус не трогаем.
    returned: bool = False


class SyncEdgeActionOut(BaseModel):
    source_path: str
    target_path: str
    action: Literal["create", "unchanged", "missing"]


class SyncPreviewOut(BaseModel):
    """Что изменится в живой схеме, если применить прогон. Ничего не записано —
    применение отдельным вызовом (Фаза 2 docs/plan-arch-sync.md)."""

    ok: bool
    errors: list[str] = []  # пусто при ok=true (ошибки разбора/лимитов)
    files: int = 0
    nodes: list[SyncNodeActionOut] = []
    edges: list[SyncEdgeActionOut] = []
    conflicts: list[str] = []  # решённые правилом расхождения (переименование, переезд)
    warnings: list[str] = []  # слияние файлов + тёзки из другого источника
    summary: dict[str, int] = {}  # счётчики действий для шапки превью
    is_noop: bool = False  # ничего не изменится (фикспойнт)
    graph_rev: int = 0  # курсор схемы на момент расчёта — вернуть в apply


class SyncApplyOut(BaseModel):
    """Что реально записано. Списки путей — для тоста и журнала, не для сверки:
    сверка была на превью."""

    created_nodes: list[str] = []
    updated_nodes: list[str] = []
    deprecated_nodes: list[str] = []
    created_edges: list[str] = []
    skipped: list[str] = []  # действия, потерявшие цель между расчётом и записью
    graph_rev: int = 0  # новый курсор схемы


class ImportPromptOut(BaseModel):
    """Текст универсального промпта «Из репозитория» для ИИ-агента пользователя."""

    prompt: str


class TemplateNodeOut(BaseModel):
    """Узел стартового шаблона для витрины выбора (GET /projects/templates).
    x/y всегда заданы — превью в модалке совпадает с раскладкой на холсте."""

    key: str
    name: str
    shape: Literal["service", "database", "broker", "person"]
    role: str | None = None
    technology: str | None = None
    is_external: bool
    x: float
    y: float


class TemplateEdgeOut(BaseModel):
    """Связь стартового шаблона: source/target — ключи узлов того же шаблона."""

    source: str
    target: str
    label: str | None = None
    technology: str | None = None


class TemplateOut(BaseModel):
    """Стартовый шаблон целиком: подписи для витрины + узлы/связи для превью."""

    id: str
    name: str
    tagline: str
    blurb: str
    techs: list[str]
    nodes: list[TemplateNodeOut]
    edges: list[TemplateEdgeOut]


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
