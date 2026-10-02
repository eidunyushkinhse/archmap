import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field

from app.schemas.demo import DemoExcess
from app.schemas.node import NodeSource

# Роль в проекте (app/access.py): права ВНУТРИ проекта определяет только она. Тот же
# набор держит CHECK в БД (app/models/project_member.py). Объявлена здесь, а не у
# модели: схемы не тянут SQLAlchemy (их импортирует MCP-сервер для сверки контракта).
ProjectRole = Literal["owner", "editor", "reader"]

# Один YAML-документ прогона агента (текст файла). Лимит — защита от «бомбы».
_ImportDoc = Annotated[str, Field(max_length=2_000_000)]
# Максимум документов за раз (мульти-репо «Из репозитория»). Щедрый предел: реальные
# системы — десятки репозиториев (80+ сервисов, файл на репозиторий). Это лишь
# предохранитель от гигантского запроса: содержимое всё равно ограничено 2 МБ на файл
# и MAX_NODES/MAX_EDGES после слияния.
MAX_IMPORT_FILES = 256


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    description: str | None = None
    # Старт схемы: "blank" — пусто; "copy:<projectId>" — глубокая копия другого
    # проекта. Парсится в роутере. Старт "template:<id>" (каркасы C4 и демо-пакет)
    # снят 2026-09-30 вместе со способом «Шаблон» — теперь это 400.
    # Ввоз схемы из файлов — ТОЛЬКО единым путём (multipart /projects/import-unified);
    # старый start="import" с YAML текстами снесён 2026-09-05 (потребителей не было).
    start: str = "blank"


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=256)
    description: str | None = None
    # «Виден всем пользователям»: не-участники получают чтение. Меняет, как и
    # остальные поля PATCH, только владелец.
    visible_to_all: bool | None = None


class ProjectMemberOut(BaseModel):
    """Участник проекта для окна «Доступ»: логин и роль. user_id — адрес строки в
    PUT/DELETE /projects/{id}/members/{user_id}."""

    user_id: uuid.UUID
    username: str
    role: ProjectRole


class ProjectMemberIn(BaseModel):
    """Добавить участника или сменить ему роль. Роль owner так не выдаётся:
    владелец меняется только передачей владения."""

    role: Literal["editor", "reader"]


class ProjectTransferIn(BaseModel):
    """Кому передать владение: новый владелец становится owner, прежний остаётся
    в проекте редактором."""

    user_id: uuid.UUID


class FileRemarksOut(BaseModel):
    """Замечания к ОДНОМУ файлу пакета: их чинит агент того репозитория, из которого
    файл пришёл (он видит только свой код и переписывает только свой YAML). Тексты —
    без префикса «файл N: »: адресация уже в поле file."""

    file: int  # номер файла с 1 — та же нумерация, что в текстах «(файл 2)» и в чипах UI
    errors: list[str] = []
    warnings: list[str] = []


class MergedNodeOut(BaseModel):
    """Склеенный узел с ОСНОВАНИЕМ склейки словами (Ф2 docs/plan-anchor-ux.md).

    Якорь решает, какой узел считать тем же самым, — и до Ф2 это была невидимая
    магия: превью говорило «склеено узлов: 7», не называя, почему. basis — единый
    словарь бэка и фронта: «code» — совпал репозиторий (вид якоря «код»),
    «dependency» — совпало имя зависимости, «name» — якорей не было и решило имя
    внутри одного родителя."""

    path: str
    basis: Literal["code", "dependency", "name"]


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
    # Те же склейки с ОСНОВАНИЕМ каждой (Ф2 якорей). merged выше не заменяется:
    # его читает MCP, а контракты превью только дополняются.
    merged_nodes: list[MergedNodeOut] = []
    # Сколько узлов слитого дерева придут БЕЗ якоря — их следующий прогон опознает
    # только по имени внутри контейнера. Счётчик, а не список: при создании проекта
    # новые ВСЕ узлы, и перечень был бы шумом, а не предупреждением.
    nodes_without_anchor: int = 0
    conflicts: list[str] = []  # расхождения полей (оставлено первое)
    warnings: list[str] = []  # fuzzy-пары, несовпавшие корни, похожие рёбра
    dropped_edges: int = 0  # выброшенные точные дубли рёбер
    # Имена ВСЕХ узлов слитого дерева в порядке обхода (родители раньше детей) —
    # чтобы фронт сравнил попытку с предыдущей и показал, что исчезло. Полевой QA
    # (docs/qa-zabbix-7.md, раунд 2): на замечание «объекты без связей» слабая
    # модель отвечает удалением узлов, и до сих пор это происходило молча.
    node_names: list[str] = []
    # ── те же замечания, разложенные по природе (Ф6, docs/plan-skeptic-audit.md) ──
    # Пакет собирают N агентов, каждый видит только свой репозиторий: адресовать
    # агенту чужие замечания бессмысленно. file_remarks — по записи на КАЖДЫЙ
    # входной файл (в порядке файлов, включая файлы без замечаний), их уносят
    # агенту; schema_* — свойства слитой картины и отношений между файлами, их
    # рассудить может только человек, видящий все репозитории сразу.
    # Инвариант: объединение корзин == плоские errors/warnings/conflicts выше;
    # при одном файле ВСЁ лежит в file_remarks[0], а schema_* пусты.
    file_remarks: list[FileRemarksOut] = []
    schema_errors: list[str] = []  # нарушенные лимиты слияния
    schema_warnings: list[str] = []  # без общего файла-виновника: конфликты слияния, межфайловая изоляция…


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
    # ОСНОВАНИЕ матча словами (Ф2 docs/plan-anchor-ux.md) — тот же словарь, что у
    # склеек импорта: «code» — сошёлся репозиторий, «dependency» — имя зависимости,
    # «name» — якорей не было и решило имя внутри смэтченного родителя.
    matched_by: Literal["code", "dependency", "name"] | None = None
    # ЯКОРЬ, который получит узел (разбор source_ref, как в карточке объекта).
    # Нужен строкам create: «якорь: код github.com/org/x» против «якоря нет — будет
    # опознаваться по имени». Пусто и то и другое различает только это поле.
    source: NodeSource | None = None
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
    # Демо-стенд: после синка проект выйдет за предел (docs/tasks/demo-mode.md).
    demo_excess: DemoExcess | None = None


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
    # Действующая роль ТЕКУЩЕГО пользователя в проекте (у администратора всегда
    # owner). Фронт решает по ней, можно ли править проект и управлять им.
    my_role: ProjectRole
    # Логин владельца; null только у наследия миграции (проект без владельца).
    owner_username: str | None
    # «Виден всем пользователям»: не-участники получают чтение.
    visible_to_all: bool
