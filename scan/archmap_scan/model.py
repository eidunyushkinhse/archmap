"""Находки разборщиков (ТЗ §6) и то, что из них собирается для вывода (§5).

Разборщик возвращает Findings: сырые записи манифестов и миграций с основаниями
«файл:строка». Объекты схемы, связи и владельцев собирает assemble.py по правилам §5.1 и §7,
поэтому разборщики ничего не знают друг о друге и не держат состояния.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True, order=True)
class Loc:
    """Основание записи: файл от корня репозитория и номер строки (с 1)."""

    path: str
    line: int

    def __str__(self) -> str:
        return f"{self.path}:{self.line}"


@dataclass
class EnvVar:
    """Переменная окружения из манифеста. Значение держится только ради адреса зависимости и
    дефолта из примера; в вывод значение попадает лишь дефолтом по инварианту 6."""

    name: str
    loc: Loc
    value: str | None = None
    dynamic: bool = False  # значение с подстановкой ${VAR}: известно только при запуске


@dataclass
class Unit:
    """Кандидат в объект схемы из манифеста развёртывания (compose, k8s, Procfile и т.д.)."""

    name: str
    parser: str
    loc: Loc
    image: str | None = None
    build_dir: str | None = None  # каталог кода (контекст сборки) от корня репозитория
    dockerfile: str | None = None  # путь Dockerfile от корня репозитория
    command: str | None = None
    command_loc: Loc | None = None
    host: str | None = None  # имя, под которым продукт сам зовёт объект (compose, k8s Service)
    env: list[EnvVar] = field(default_factory=list)
    depends_on: list[tuple[str, Loc]] = field(default_factory=list)
    role: str | None = None  # роль, которую знает сам манифест (Procfile web, CronJob)
    shape: str | None = None  # вид, который знает сам манифест (Dockerfile на образе базы)
    technology: str | None = None
    schedule: str | None = None  # расписание CronJob
    home_dir: str | None = None  # каталог манифеста процесса (Procfile): код этого процесса
    language: str | None = None  # язык по базовому образу Dockerfile
    extra_locs: list[Loc] = field(default_factory=list)  # тот же объект в других файлах
    replicas: int | None = None  # numprocs supervisor: сколько копий процесса


@dataclass
class Dockerfile:
    path: str
    dir: str
    images: list[str]  # базовые образы стадий по порядку (FROM)
    from_loc: Loc
    command: str | None = None
    command_loc: Loc | None = None


@dataclass
class Package:
    """Манифест сборки: имя пакета, зависимости (имена без версий), язык."""

    path: str
    dir: str
    kind: str  # package.json, pyproject.toml, requirements.txt, go.mod и другие
    language: str
    name: str | None = None
    name_loc: Loc | None = None
    deps: tuple[str, ...] = ()
    workspaces: tuple[str, ...] = ()


@dataclass
class EnvFile:
    """Файл-пример окружения (.env.example и подобные)."""

    path: str
    dir: str
    vars: list[EnvVar]


@dataclass
class OpenApi:
    path: str
    operations: int | None  # None — операции не посчитаны, причина в reason
    reason: str | None = None  # None при operations None — файл больше предела разбора


@dataclass
class Column:
    name: str
    type: str | None = None
    pk: bool = False
    required: bool | None = None
    references: str | None = None
    locs: list[Loc] = field(default_factory=list)


@dataclass
class Table:
    name: str
    schema: str | None = None
    columns: list[Column] = field(default_factory=list)
    locs: list[Loc] = field(default_factory=list)

    def column(self, name: str) -> Column | None:
        return next((c for c in self.columns if c.name == name), None)


@dataclass
class TableSet:
    """Таблицы одного набора миграций (каталог) после применения всей цепочки."""

    parser: str  # sql | alembic | django
    dir: str
    tables: list[Table] = field(default_factory=list)
    dropped: int = 0
    skipped: int = 0
    skipped_examples: list[tuple[Loc, str]] = field(default_factory=list)
    # Миграции данных (RunPython): структуру таблиц не меняют, поэтому это не пропуск, но
    # счёт в покрытии виден отдельно.
    data_migrations: int = 0
    error: str | None = None
    # Диалект базы по признакам миграций (dialect.py) и его основание: из него строится
    # объект-база, если базы в манифестах нет (ТЗ §7, пункт 3).
    dialect: str | None = None
    dialect_loc: Loc | None = None


@dataclass
class Route:
    """Маршрут HTTP из кода (ТЗ §6.2): метод, путь со сложенными префиксами, основание."""

    method: str
    path: str
    loc: Loc
    framework: str
    parser: str
    prefix_unresolved: bool = False  # префикс подключения не виден в коде


@dataclass
class CodeParam:
    """Чтение параметра конфигурации в коде (ТЗ §6.2). Дефолт — текст литерала как есть;
    писать ли его, решает secrets.safe_default при сборке."""

    name: str
    loc: Loc
    parser: str
    default: str | None = None
    has_default: bool = False  # дефолт есть, даже если не литерал
    required: bool | None = None
    type: str | None = None


@dataclass
class ChannelUse:
    """Канал брокера в коде (ТЗ §6.2): имя дословно, вид, клиент и направление вызова."""

    name: str
    kind: str  # queue | topic | exchange | subject
    client: str  # вид брокера по библиотеке: Kafka, RabbitMQ, NATS, Celery
    direction: str | None  # publish | consume; None — объявление без направления
    loc: Loc
    parser: str
    broker_host: str | None = None  # адрес брокера литералом в том же файле
    # Технология брокера по схеме адреса литералом в том же файле (Celery: redis:// →
    # Redis): нужна, когда брокера в манифестах нет (ТЗ §13.2).
    broker_tech: str | None = None


@dataclass
class CodeSchedule:
    """Расписание из кода или crontab (ТЗ §6.2): имя, расписание как написано, задача."""

    name: str
    schedule: str
    task: str | None
    loc: Loc
    parser: str


@dataclass
class Hint:
    """Запись hints.yaml: раздел и данные (тексты причин — из texts.py). У записи любого
    раздела один набор ключей (ТЗ §5.3): kind, name, reason, source, при необходимости
    object (имя сервиса или контейнера, к которому относится запись) и дальше ключи
    раздела; порядок ключей ставит output/agent.py."""

    section: str
    data: dict[str, object]


def unparsed_hint(rel: str, reason: str) -> Hint:
    """Файл, который разборщик не смог прочитать: раздел unparsed."""
    return Hint("unparsed", {"kind": "file", "name": rel, "reason": reason, "source": rel})


@dataclass
class Findings:
    units: list[Unit] = field(default_factory=list)
    dockerfiles: list[Dockerfile] = field(default_factory=list)
    packages: list[Package] = field(default_factory=list)
    env_files: list[EnvFile] = field(default_factory=list)
    openapi: list[OpenApi] = field(default_factory=list)
    table_sets: list[TableSet] = field(default_factory=list)
    hints: list[Hint] = field(default_factory=list)
    # Пояснения к семьям покрытия: семья → тексты (Helm templates и подобное).
    notes: dict[str, list[str]] = field(default_factory=dict)
    # Опознанные стеки без разборщика по семьям: семья → имена стеков.
    unsupported: dict[str, list[str]] = field(default_factory=dict)
    # Ярус кода (ТЗ §6.2).
    routes: list[Route] = field(default_factory=list)
    code_params: list[CodeParam] = field(default_factory=list)
    channels: list[ChannelUse] = field(default_factory=list)
    schedules: list[CodeSchedule] = field(default_factory=list)
    # Разборщики кода, чей стек в репозитории есть (они читали файлы): по ним семья «пусто»
    # отличается от «не опознан стек».
    applied: set[str] = field(default_factory=set)
    # Файлы кода в каталогах для разработки, которые разборщик не читал: имя разборщика →
    # файлы (ТЗ §4, покрытие skipped.dev_code по семьям).
    dev_code: dict[str, set[str]] = field(default_factory=dict)

    def extend(self, other: Findings) -> None:
        self.units.extend(other.units)
        self.dockerfiles.extend(other.dockerfiles)
        self.packages.extend(other.packages)
        self.env_files.extend(other.env_files)
        self.openapi.extend(other.openapi)
        self.table_sets.extend(other.table_sets)
        self.hints.extend(other.hints)
        for fam, items in other.notes.items():
            self.notes.setdefault(fam, []).extend(items)
        for fam, items in other.unsupported.items():
            self.unsupported.setdefault(fam, []).extend(items)
        self.routes.extend(other.routes)
        self.code_params.extend(other.code_params)
        self.channels.extend(other.channels)
        self.schedules.extend(other.schedules)
        self.applied |= other.applied
        for parser, rels in other.dev_code.items():
            self.dev_code.setdefault(parser, set()).update(rels)
