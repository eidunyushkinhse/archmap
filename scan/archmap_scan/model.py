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
    operations: int | None  # None — файл больше предела разбора, операции не посчитаны


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
class Hint:
    """Запись hints.yaml: раздел и данные как есть (тексты причин — из texts.py)."""

    section: str
    data: dict[str, object]


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
