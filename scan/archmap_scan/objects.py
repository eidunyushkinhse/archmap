"""Собранная модель схемы (ТЗ §5): объекты, связи, точки входа, факты по владельцам.

Её строит assemble.py из находок разборщиков (ярус манифестов) и codefacts.py (ярус кода),
а пишут модули output/. Отдельным модулем, чтобы сборка яруса кода не зависела от
assemble.py и не создавала цикла импортов.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from archmap_scan.model import Dockerfile, EnvVar, Loc, Table, Unit

SERVICE, DATABASE, BROKER = "service", "database", "broker"
SHAPE_ORDER = {SERVICE: 0, DATABASE: 1, BROKER: 2}


@dataclass
class Obj:
    """Объект схемы: контейнер, база или брокер (дети корня-системы)."""

    name: str
    shape: str = SERVICE
    role: str | None = None
    technology: str | None = None
    host: str | None = None
    code_dir: str | None = None  # каталог кода контейнера от корня репозитория
    path: str | None = None  # source.path после правила уникальности каталога
    repo: bool = False  # ставить ли source.repo
    locs: set[Loc] = field(default_factory=set)
    parsers: list[str] = field(default_factory=list)
    units: list[Unit] = field(default_factory=list)
    env: list[EnvVar] = field(default_factory=list)
    dockerfile: Dockerfile | None = None
    package_locs: list[Loc] = field(default_factory=list)
    language: str | None = None  # язык кода контейнера: по нему отбираются манифесты и файлы

    @property
    def is_container(self) -> bool:
        return self.shape == SERVICE


@dataclass
class Link:
    """Связь схемы. channel и sync только у связей с брокером, найденных в коде."""

    src: Obj
    dst: Obj
    label: str
    technology: str | None
    locs: set[Loc] = field(default_factory=set)
    parsers: set[str] = field(default_factory=set)
    channel: str | None = None
    sync: bool | None = None


@dataclass
class Worker:
    """Процесс-воркер или планировщик: команда запуска и очереди из её аргументов."""

    command: str
    queues: list[str]
    loc: Loc
    parser: str
    replicas: int | None = None


@dataclass
class Schedule:
    """Расписание из манифеста (CronJob): имя, расписание как написано, задача."""

    name: str
    schedule: str
    task: str | None
    loc: Loc
    parser: str


@dataclass
class Param:
    """Параметр конфигурации контейнера. Дефолт из примера окружения или из кода, только
    по инварианту 6; required — чтение в коде, которое без значения не обходится."""

    name: str
    type: str | None = None
    default: str | None = None
    required: bool | None = None
    locs: set[Loc] = field(default_factory=set)
    parsers: set[str] = field(default_factory=set)


@dataclass
class HttpEntry:
    """Маршрут HTTP контейнера для agent/entrypoints.yaml."""

    method: str
    path: str
    framework: str
    loc: Loc
    parser: str
    prefix_unresolved: bool = False


@dataclass
class Channel:
    """Канал брокера для facts/<брокер>.channels.yaml: имя дословно и вид."""

    name: str
    kind: str
    locs: set[Loc] = field(default_factory=set)
    parsers: set[str] = field(default_factory=set)


@dataclass
class Consumer:
    """Потребитель канала в контейнере для agent/entrypoints.yaml."""

    channel: str
    kind: str
    broker: str | None
    loc: Loc
    parser: str


@dataclass
class TableStats:
    found: int = 0
    unassigned: int = 0
    dropped: int = 0
    skipped: dict[str, int] = field(default_factory=dict)
    parsers: set[str] = field(default_factory=set)
    errors: list[str] = field(default_factory=list)


@dataclass
class Model:
    system: str
    system_locs: list[Loc]
    objects: list[Obj]
    links: list[Link]
    implicit: bool = False
    db_by_migrations: bool = False  # есть база, определённая по миграциям (ТЗ §7, пункт 3)
    hints: dict[str, list[dict[str, object]]] = field(default_factory=dict)
    workers: dict[str, list[Worker]] = field(default_factory=dict)
    schedules: dict[str, list[Schedule]] = field(default_factory=dict)
    # Параметры по контейнерам: имя контейнера → имя параметра → параметр.
    params: dict[str, dict[str, Param]] = field(default_factory=dict)
    # Таблицы по базам: имя базы → таблицы; счёт для покрытия — в table_stats.
    tables: dict[str, list[Table]] = field(default_factory=dict)
    table_stats: TableStats = field(default_factory=lambda: TableStats())
    # Ярус кода (ТЗ §6.2): маршруты и потребители по контейнерам, каналы по брокерам.
    http: dict[str, list[HttpEntry]] = field(default_factory=dict)
    consumers: dict[str, list[Consumer]] = field(default_factory=dict)
    channels: dict[str, dict[str, Channel]] = field(default_factory=dict)

    def obj(self, name: str) -> Obj | None:
        return next((o for o in self.objects if o.name == name), None)

    def hint(self, section: str, data: dict[str, object]) -> None:
        self.hints.setdefault(section, []).append(data)
