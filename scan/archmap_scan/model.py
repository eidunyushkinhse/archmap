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
    # Где записано значение, если не в самой переменной: строка data ConfigMap для
    # configMapKeyRef (ТЗ §15 п. 14 Ж2). Идёт в основания связи по адресу.
    value_loc: Loc | None = None


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
    # compose: restart и entrypoint (текстом) — по ним видна разовая задача (ТЗ §15 п. 10 А8).
    restart: str | None = None
    entrypoint: str | None = None
    job: bool = False  # k8s Job: разовая задача (ТЗ §15 п. 13 Д7)
    # Признак манифеста разработки (walk.dev_sign, ТЗ §15 п. 10 Б): текстом для подсказки.
    # Объектом такой кандидат становится, только если боевых манифестов нет (ступень 2);
    # подсказки, собранные при его разборе, тогда идут в вывод вместе с ним.
    dev: str | None = None
    dev_hints: list[Hint] = field(default_factory=list)
    dev_notes: list[str] = field(default_factory=list)  # пометки семьи containers
    # Связи из файлов конфигурации прокси (ТЗ §15 п. 14 Ж3): едут с кандидатом и попадают в
    # схему, только если он стал объектом.
    links: list[ManifestLink] = field(default_factory=list)
    # Каталог Cargo workspace, членом которого кандидат является (ТЗ §15 п. 14 И1): у объекта
    # со сборкой из этого каталога каталог кода — каталог крейта (build_dir).
    workspace: str | None = None
    # Простые команды скриптов репозитория, которые запускает command (./bin/x, ТЗ §15 п. 16
    # П1): дополнительные команды единицы для владельца записей кода и роли, не записи.
    script_commands: list[str] = field(default_factory=list)


@dataclass
class ManifestLink:
    """Связь, которую манифест называет сам (ТЗ §15 п. 14 Ж1, Ж3): NetworkPolicy между подами,
    прокси к адресу своего файла конфигурации. src — имя кандидата в объект (Unit) того же
    разборщика, dst — имя такого кандидата или host (by_host). Объекты концов находит сборка;
    конец не объект — подсказка, а не связь."""

    src: str
    dst: str
    loc: Loc
    parser: str
    technology: str | None = None
    by_host: bool = False


@dataclass
class Dockerfile:
    path: str
    dir: str
    images: list[str]  # базовые образы стадий по порядку (FROM)
    from_loc: Loc
    command: str | None = None
    command_loc: Loc | None = None
    # COPY или ADD всего контекста сборки («COPY . ./»): код образа — каталог контекста, а не
    # каталог Dockerfile (ТЗ §15 п. 12 С5б).
    copies_context: bool = False
    # Простые команды скриптов репозитория, которые запускает CMD (ТЗ §15 п. 16 П1).
    script_commands: list[str] = field(default_factory=list)


@dataclass
class ImageBuild:
    """Чем собирается образ, кроме ссылки build основного манифеста (ТЗ §15 п. 10 А6):
    артефакт skaffold.yaml (image — имя образа) или build сервиса в файле compose для
    разработки (unit — имя сервиса)."""

    dockerfile: str
    loc: Loc
    build_dir: str
    image: str | None = None
    unit: str | None = None


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
    in_docs: bool = False  # файл в исключённом каталоге документации (ТЗ §15 п. 13 Д2)
    # Операции (метод, путь как в файле, строка ключа пути), info.title, адреса servers[].url
    # (у Swagger 2.0 — host и basePath) для маршрутов владельца (ТЗ §15 п. 14 З3).
    ops: list[tuple[str, str, Loc]] = field(default_factory=list)
    title: str | None = None
    servers: list[str] = field(default_factory=list)


@dataclass
class ServedRef:
    """Литерал с базовым именем файла OpenAPI в коде (ТЗ §15 п. 15 Н1: "swagger.json" в коде,
    который отдаёт файл) и файлы Go, импортирующие пакет этого файла (до трёх шагов по
    импортам; пусто — не Go, None — больше предела)."""

    name: str
    loc: Loc
    importers: tuple[str, ...] | None = ()


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

    parser: str  # sql | alembic | django | rails-schema | kysely
    dir: str
    tables: list[Table] = field(default_factory=list)
    dropped: int = 0
    skipped: int = 0
    skipped_examples: list[tuple[Loc, str]] = field(default_factory=list)
    # Таблицы из CREATE TABLE … AS (место и имя), у которых не все колонки получили имя.
    queried: list[tuple[Loc, str]] = field(default_factory=list)
    # Миграции данных (RunPython): структуру таблиц не меняют, поэтому это не пропуск, но
    # счёт в покрытии виден отдельно.
    data_migrations: int = 0
    error: str | None = None
    # Диалект базы по признакам миграций (dialect.py) и его основание: из него строится
    # объект-база, если базы в манифестах нет (ТЗ §7, пункт 3).
    dialect: str | None = None
    dialect_loc: Loc | None = None
    # SQLite из настроек — значение по умолчанию: другой модуль того же пакета настроек
    # переопределяет DATABASES без sqlite (ТЗ §15 п. 12 С9). Вида базы такой диалект не даёт.
    dialect_default: bool = False


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
    # Другие основания той же записи: место объявления константы, которой задано имя (ТЗ
    # §15 п. 14 Е1). Владельца выбирают по loc, эти места только идут в evidence.
    extra_locs: list[Loc] = field(default_factory=list)
    # Описание из кода без пересказа смысла: перечень значений схемы z.enum (ТЗ §15 п. 14 Е3).
    description: str | None = None
    # Запись файла настроек (appsettings.json, defaults.hjson; ТЗ §15 п. 16 Р1, Р2), а не
    # чтение в коде: при слиянии дефолт берётся сначала из файла, тип сначала из кода.
    from_file: bool = False


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
    # Программа процесса-потребителя (sidekiq): владелец среди контейнеров файла тот, чья
    # команда её запускает (ТЗ §15 п. 13 В3), а не любой контейнер того же каталога.
    runner: str | None = None
    # Процесс-потребитель по имени из реестра консьюмеров (KAFKA_CONSUMERS): владелец связи —
    # объект схемы с этим именем или с «consumer <имя>» в команде (ТЗ §15 п. 13 В4).
    process: str | None = None


@dataclass
class CodeSchedule:
    """Расписание из кода или crontab (ТЗ §6.2): имя, расписание как написано, задача."""

    name: str
    schedule: str
    task: str | None
    loc: Loc
    parser: str
    runner: str | None = None  # программа, которая исполняет расписание (как у ChannelUse)


@dataclass
class Hint:
    """Запись hints.yaml: раздел и данные (тексты причин — из texts.py). У записи любого
    раздела один набор ключей (ТЗ §5.3): kind, name, reason, source, при необходимости
    object (имя сервиса или контейнера, к которому относится запись) и дальше ключи
    раздела; порядок ключей ставит output/agent.py."""

    section: str
    data: dict[str, object]


def hint_fields(**fields: str | None) -> dict[str, object]:
    """Поля подсказки сверх общих (ТЗ §15 п. 16 П3): method маршрута, schedule и task
    расписания. Пустые не пишутся, ANY у метода тоже: регистрация метод не назвала."""
    return {k: v for k, v in fields.items() if v and not (k == "method" and v == "ANY")}


def route_hint(name: str, reason: str, loc: Loc, method: str | None = None) -> Hint:
    """Маршрут с путём выражением: раздел dynamic_names, метод, если регистрация его называет."""
    return Hint("dynamic_names", {
        "kind": "route", "name": name, "reason": reason, "source": str(loc),
        **hint_fields(method=method),
    })


def schedule_hint(
    name: str, reason: str, loc: Loc, schedule: str | None = None, task: str | None = None,
) -> Hint:
    """Расписание с именем или выражением, известным только при запуске: раздел
    dynamic_names, выражение расписания как написано и задача, когда они известны."""
    return Hint("dynamic_names", {
        "kind": "schedule", "name": name, "reason": reason, "source": str(loc),
        **hint_fields(schedule=schedule, task=task),
    })


def unparsed_hint(rel: str, reason: str) -> Hint:
    """Файл, который разборщик не смог прочитать: раздел unparsed."""
    return Hint("unparsed", {"kind": "file", "name": rel, "reason": reason, "source": rel})


@dataclass
class Findings:
    units: list[Unit] = field(default_factory=list)
    dockerfiles: list[Dockerfile] = field(default_factory=list)
    image_builds: list[ImageBuild] = field(default_factory=list)
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
    # Связи, которые манифесты называют сами (NetworkPolicy, конфигурация прокси).
    links: list[ManifestLink] = field(default_factory=list)
    # Файлы кода в каталогах для разработки, которые разборщик не читал: имя разборщика →
    # файлы (ТЗ §4, покрытие skipped.dev_code по семьям).
    dev_code: dict[str, set[str]] = field(default_factory=dict)
    # Процессы по файлам сборки (ТЗ §13.4): сборка берёт их, только если ярус манифестов
    # не дал ни одного контейнера; тогда же в покрытии названы непрочитанные файлы сборки.
    build_units: list[Unit] = field(default_factory=list)
    build_unsupported: list[str] = field(default_factory=list)
    # Каталоги программ Go по соглашению «<каталог>/cmd/<имя>/» с файлами кода Go (ТЗ §15
    # п. 14 Ф1): по ним владелец файла под cmd/<имя>/ выбирается среди контейнеров каталога.
    go_programs: set[str] = field(default_factory=set)
    # Код, который называет файл OpenAPI литералом (ТЗ §15 п. 15 Н1): владелец файла по нему.
    served: list[ServedRef] = field(default_factory=list)
    # Стек по маркеру сборки в корне (vocab.STACK_BAZEL, STACK_CMAKE; ТЗ §15 п. 12 С12).
    root_stack: str | None = None

    def extend(self, other: Findings) -> None:
        self.units.extend(other.units)
        self.dockerfiles.extend(other.dockerfiles)
        self.image_builds.extend(other.image_builds)
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
        self.links.extend(other.links)
        for parser, rels in other.dev_code.items():
            self.dev_code.setdefault(parser, set()).update(rels)
        self.build_units.extend(other.build_units)
        for stack in other.build_unsupported:
            if stack not in self.build_unsupported:
                self.build_unsupported.append(stack)
        self.go_programs |= other.go_programs
        self.served.extend(other.served)
        self.root_stack = self.root_stack or other.root_stack
