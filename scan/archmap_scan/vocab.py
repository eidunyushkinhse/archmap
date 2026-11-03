"""Словари сборщика (ТЗ §6.5): образ → вид и технология, манифест → язык и фреймворк,
клиентские библиотеки → вид зависимости, роли из короткого словаря (§5.1).

Словари стартовые и пополняются по находкам; сборщик не пишет технологию и роль, которых
здесь нет, кроме имени неизвестного образа (его технология и есть это имя).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Роли объектов (ТЗ §5.1): других сборщик не пишет.
ROLE_SERVICE = "сервис"
ROLE_FRONTEND = "фронтенд"
ROLE_WORKER = "воркер"
ROLE_DB = "БД"
ROLE_CACHE = "кэш"
ROLE_BROKER = "брокер"
ROLE_PROXY = "прокси"
ROLE_STORAGE = "хранилище"
ROLE_SCHEDULER = "планировщик"
ROLES = frozenset({
    ROLE_SERVICE, ROLE_FRONTEND, ROLE_WORKER, ROLE_DB, ROLE_CACHE, ROLE_BROKER, ROLE_PROXY,
    ROLE_STORAGE, ROLE_SCHEDULER,
})


@dataclass(frozen=True)
class ImageKind:
    shape: str  # service | database | broker
    technology: str
    role: str


_DB = "database"
_BROKER = "broker"
_SERVICE = "service"

# Последний сегмент имени образа (без реестра, тега и дайджеста) → вид объекта.
IMAGES: dict[str, ImageKind] = {}


def _images(names: str, kind: ImageKind) -> None:
    for name in names.split():
        IMAGES[name] = kind


_images("postgres postgresql postgis timescaledb pgvector pgroonga",
        ImageKind(_DB, "PostgreSQL", ROLE_DB))
_images("mysql mysql-server", ImageKind(_DB, "MySQL", ROLE_DB))
_images("mariadb", ImageKind(_DB, "MariaDB", ROLE_DB))
_images("mongo mongodb mongodb-community-server", ImageKind(_DB, "MongoDB", ROLE_DB))
_images("clickhouse clickhouse-server", ImageKind(_DB, "ClickHouse", ROLE_DB))
_images("elasticsearch", ImageKind(_DB, "Elasticsearch", ROLE_DB))
_images("opensearch", ImageKind(_DB, "OpenSearch", ROLE_DB))
_images("redis redis-stack redis-stack-server valkey", ImageKind(_DB, "Redis", ROLE_CACHE))
_images("memcached", ImageKind(_DB, "Memcached", ROLE_CACHE))
_images("minio", ImageKind(_DB, "MinIO", ROLE_STORAGE))
_images("rabbitmq", ImageKind(_BROKER, "RabbitMQ", ROLE_BROKER))
_images("kafka cp-kafka cp-server", ImageKind(_BROKER, "Kafka", ROLE_BROKER))
_images("redpanda", ImageKind(_BROKER, "Redpanda", ROLE_BROKER))
_images("nats nats-streaming", ImageKind(_BROKER, "NATS", ROLE_BROKER))
_images("pulsar pulsar-all", ImageKind(_BROKER, "Pulsar", ROLE_BROKER))
_images("zookeeper cp-zookeeper", ImageKind(_SERVICE, "ZooKeeper", ROLE_SERVICE))
_images("nginx nginx-unprivileged", ImageKind(_SERVICE, "nginx", ROLE_PROXY))
_images("traefik", ImageKind(_SERVICE, "Traefik", ROLE_PROXY))
_images("haproxy", ImageKind(_SERVICE, "HAProxy", ROLE_PROXY))
_images("envoy", ImageKind(_SERVICE, "Envoy", ROLE_PROXY))
_images("mailhog", ImageKind(_SERVICE, "MailHog", ROLE_SERVICE))
_images("mailpit", ImageKind(_SERVICE, "Mailpit", ROLE_SERVICE))
# Не образ, а программа, которую процесс supervisor или systemd запускает вне репозитория.
_images("cron crond", ImageKind(_SERVICE, "cron", ROLE_SCHEDULER))

# Реляционные базы: им принадлежат миграции (ТЗ §7).
RELATIONAL = frozenset({"PostgreSQL", "MySQL", "MariaDB"})

# Переменные, адрес в которых делает Redis брокером (очередь задач), а не кэшем.
REDIS_BROKER_VARS = frozenset({"CELERY_BROKER_URL", "BROKER_URL"})
REDIS_BROKER_PREFIX = "RQ_"


def image_name(image: str) -> str:
    """Имя образа без реестра, тега и дайджеста: ghcr.io/org/thing:1.2 → thing."""
    ref = image.strip().split("@", 1)[0]
    last = ref.rsplit("/", 1)[-1]
    return last.split(":", 1)[0].lower()


def image_path(image: str) -> str:
    """Путь образа без тега и дайджеста (для .NET: mcr.microsoft.com/dotnet/aspnet)."""
    ref = image.strip().split("@", 1)[0]
    head, _, last = ref.rpartition("/")
    return (head + "/" if head else "") + last.split(":", 1)[0].lower()


# Хвостовые части имени образа, которые называют сборку, а не программу: postgres-alpine
# и redis-bookworm — те же PostgreSQL и Redis.
_IMAGE_VARIANTS = frozenset({
    "alpine", "slim", "bullseye", "bookworm", "buster", "trixie", "jammy", "focal", "noble",
    "debian", "ubuntu", "distroless", "latest",
})


def image_kind(image: str) -> ImageKind | None:
    """Вид по образу: точное имя, имя без хвоста сборки (postgres-alpine → PostgreSQL) или
    последняя часть имени через дефис (zulip-postgresql → PostgreSQL), но не первая:
    postgres-exporter базой не считается. Реестр и организация не важны:
    bitnami/postgresql и groonga/pgroonga:14-alpine — PostgreSQL."""
    name = image_name(image)
    kind = IMAGES.get(name)
    if kind is not None:
        return kind
    parts = name.split("-")
    while len(parts) > 1 and parts[-1] in _IMAGE_VARIANTS:
        parts.pop()
    kind = IMAGES.get("-".join(parts))
    if kind is None and len(parts) > 1:
        kind = IMAGES.get(parts[-1])
    return kind


# Базовый образ Dockerfile → язык: по началу последнего сегмента имени.
_LANG_PREFIXES: tuple[tuple[str, str], ...] = (
    ("python", "Python"), ("pypy", "Python"), ("node", "Node.js"), ("golang", "Go"),
    ("openjdk", "Java"), ("eclipse-temurin", "Java"), ("amazoncorretto", "Java"),
    ("maven", "Java"), ("gradle", "Java"), ("ibm-semeru-runtimes", "Java"),
    ("ruby", "Ruby"), ("php", "PHP"), ("rust", "Rust"), ("elixir", "Elixir"),
)


def image_language(image: str) -> str | None:
    if "/dotnet/" in image_path(image) + "/":
        return ".NET"
    name = image_name(image)
    for prefix, lang in _LANG_PREFIXES:
        if name.startswith(prefix):
            return lang
    return None


# Манифест сборки → язык.
MANIFEST_LANGUAGE: dict[str, str] = {
    "package.json": "Node.js",
    "pyproject.toml": "Python",
    "requirements.txt": "Python",
    "Pipfile": "Python",
    "go.mod": "Go",
    "Cargo.toml": "Rust",
    "pom.xml": "Java",
    "build.gradle": "Java",
    "Gemfile": "Ruby",
    "composer.json": "PHP",
    "mix.exs": "Elixir",
}

# Серверные фреймворки по имени зависимости, в порядке старшинства (FastAPI раньше
# Starlette: первый тянет второго за собой).
SERVER_FRAMEWORKS: tuple[tuple[str, str], ...] = (
    ("fastapi", "FastAPI"),
    ("django", "Django"),
    ("flask", "Flask"),
    ("starlette", "Starlette"),
    ("@nestjs/core", "NestJS"),
    ("next", "Next.js"),
    ("express", "Express"),
    ("fastify", "Fastify"),
    ("koa", "Koa"),
    ("github.com/gin-gonic/gin", "Gin"),
    ("github.com/labstack/echo", "Echo"),
    ("github.com/go-chi/chi", "chi"),
    ("github.com/gofiber/fiber", "Fiber"),
    ("spring-boot", "Spring Boot"),
    ("rails", "Rails"),
    ("laravel/framework", "Laravel"),
    ("phoenix", "Phoenix"),
)

# Фреймворки интерфейса: роль «фронтенд», если серверного фреймворка нет.
FRONTEND_FRAMEWORKS: tuple[tuple[str, str], ...] = (
    ("react", "React"),
    ("vue", "Vue"),
    ("@angular/core", "Angular"),
    ("svelte", "Svelte"),
)

# Клиентские библиотеки → вид зависимости (подсказка агенту и опознание стека каналов).
CLIENTS: tuple[tuple[str, str], ...] = (
    ("psycopg", "PostgreSQL"), ("psycopg2", "PostgreSQL"), ("psycopg2-binary", "PostgreSQL"),
    ("asyncpg", "PostgreSQL"), ("pg", "PostgreSQL"), ("github.com/jackc/pgx", "PostgreSQL"),
    ("mysqlclient", "MySQL"), ("pymysql", "MySQL"), ("mysql2", "MySQL"),
    ("redis", "Redis"), ("ioredis", "Redis"),
    ("kafka-python", "Kafka"), ("confluent-kafka", "Kafka"), ("aiokafka", "Kafka"),
    ("kafkajs", "Kafka"), ("github.com/ibm/sarama", "Kafka"),
    ("github.com/shopify/sarama", "Kafka"), ("github.com/segmentio/kafka-go", "Kafka"),
    ("pika", "RabbitMQ"), ("aio-pika", "RabbitMQ"), ("amqplib", "RabbitMQ"),
    ("celery", "Celery"),
    ("nats", "NATS"), ("nats-py", "NATS"), ("github.com/nats-io/nats.go", "NATS"),
)

# Клиенты брокеров, каналы которых ярус кода не читает (ТЗ §6.4: SQS, Pub/Sub). Каналы
# Kafka, RabbitMQ, NATS и очереди Celery читаются разборщиками kafka, rabbitmq, nats, celery.
UNSUPPORTED_CHANNEL_DEPS: tuple[tuple[str, str], ...] = (
    ("google-cloud-pubsub", "Pub/Sub"), ("@google-cloud/pubsub", "Pub/Sub"),
    ("cloud.google.com/go/pubsub", "Pub/Sub"), ("@aws-sdk/client-sqs", "SQS"),
)

# Фреймворки, маршруты которых читает ярус кода (ТЗ §6.2); остальные серверные фреймворки
# из SERVER_FRAMEWORKS опознаются, но в coverage названы стеком без разборщика.
# Языки, параметры конфигурации в коде которых читает ярус кода, и библиотеки
# конфигурации, которые он не читает (ТЗ §6.4: ключи viper).
CONFIG_LANGUAGES = frozenset({"Python", "Node.js", "Go"})
UNSUPPORTED_CONFIG_DEPS: tuple[tuple[str, str], ...] = (("github.com/spf13/viper", "viper"),)
ROUTE_FRAMEWORKS = frozenset({
    "FastAPI", "Starlette", "Flask", "Django", "Express", "Fastify", "Koa", "NestJS", "Gin",
    "Echo", "chi", "Fiber",
})

# ORM и описания схем, которые сборщик пока не разбирает (ТЗ §6.4) → имя стека.
UNSUPPORTED_SCHEMA_DEPS: tuple[tuple[str, str], ...] = (
    ("prisma", "Prisma"), ("@prisma/client", "Prisma"), ("typeorm", "TypeORM"),
    ("sequelize", "Sequelize"), ("gorm.io/gorm", "GORM"), ("ecto_sql", "Ecto"),
)


def _dep_match(dep: str, key: str) -> bool:
    """Зависимость совпадает с ключом словаря: точно или модуль Go с версией (/v5)."""
    if dep == key:
        return True
    if key.startswith("github.com/"):
        return dep.startswith(key + "/v")
    # spring-boot-starter-web и прочие стартеры Spring Boot.
    return key == "spring-boot" and dep.startswith("spring-boot")


def find_framework(deps: tuple[str, ...], table: tuple[tuple[str, str], ...]) -> str | None:
    low = tuple(d.lower() for d in deps)
    for key, name in table:
        if any(_dep_match(d, key) for d in low):
            return name
    return None


def frameworks_in(deps: tuple[str, ...], table: tuple[tuple[str, str], ...]) -> list[str]:
    """Все фреймворки словаря среди зависимостей, в порядке словаря."""
    low = tuple(d.lower() for d in deps)
    out: list[str] = []
    for key, name in table:
        if name not in out and any(_dep_match(d, key) for d in low):
            out.append(name)
    return out


def clients_of(deps: tuple[str, ...]) -> list[tuple[str, str]]:
    """(библиотека, вид зависимости) в порядке словаря, без повторов."""
    low = {d.lower() for d in deps}
    out: list[tuple[str, str]] = []
    for key, kind in CLIENTS:
        if any(_dep_match(d, key) for d in low) and (key, kind) not in out:
            out.append((key, kind))
    return out


# Слова в команде запуска процесса → роль (Procfile, compose, supervisor, systemd).
_WORKER_WORDS = frozenset({"worker", "consumer"})
_SCHEDULER_WORDS = frozenset({"beat", "scheduler", "cron"})
_WORDS = re.compile(r"[a-z]+")


def role_by_command(command: str | None) -> str | None:
    if not command:
        return None
    words = set(_WORDS.findall(command.lower()))
    if words & _WORKER_WORDS:
        return ROLE_WORKER
    if words & _SCHEDULER_WORDS:
        return ROLE_SCHEDULER
    return None


# Команда запуска процесса → язык: программа, которая исполняет код репозитория
# (ТЗ §7, находка фазы 1а на Zulip: программы supervisor без технологии). Имя бинаря Go
# берётся из module в go.mod и передаётся отдельно.
COMMAND_LANGUAGE: dict[str, str] = {
    "python": "Python", "python2": "Python", "python3": "Python", "manage.py": "Python",
    "uwsgi": "Python", "gunicorn": "Python", "uvicorn": "Python", "celery": "Python",
    "tornado": "Python",
    "node": "Node.js", "npm": "Node.js", "npx": "Node.js",
    "ruby": "Ruby", "bundle": "Ruby", "rails": "Ruby", "puma": "Ruby", "sidekiq": "Ruby",
    "php": "PHP", "php-fpm": "PHP", "artisan": "PHP",
    "java": "Java",
}
# Обёртки запуска: сами программой процесса не являются.
_WRAPPERS = frozenset({
    "nice", "ionice", "exec", "env", "sudo", "su", "timeout", "stdbuf", "chpst", "setsid",
    "nohup", "dumb-init", "tini", "uv", "run", "poetry", "pipenv", "--", "bash", "sh",
    "-c", "time",
})
_TEMPLATE = ("<%", "%>", "{{", "}}", "$")
_MAX_COMMAND_TOKENS = 64


def _command_tokens(command: str) -> list[str]:
    return [t.strip("'\"") for t in command.split()[:_MAX_COMMAND_TOKENS]]


def _base(token: str) -> str:
    return token.rsplit("/", 1)[-1]


def command_language(command: str | None, go_binaries: frozenset[str] = frozenset()) -> str | None:
    """Язык кода, который запускает команда: python3, manage.py, uwsgi → Python, node →
    Node.js, имя бинаря модуля Go → Go. Программа может стоять за обёрткой (nice, uv run,
    secret-env-wrapper ИМЯ=значение), поэтому просматриваются все слова команды."""
    if not command:
        return None
    for token in _command_tokens(command):
        if any(mark in token for mark in _TEMPLATE):
            continue
        base = _base(token)
        if base in COMMAND_LANGUAGE:
            return COMMAND_LANGUAGE[base]
        if base.startswith("python") and base[6:].replace(".", "").isdigit():
            return "Python"
        if base.endswith(".py") and len(base) > 3:
            return "Python"
        if base in go_binaries:
            return "Go"
    return None


def command_program(command: str | None) -> str | None:
    """Имя программы процесса: первое слово команды после обёрток, переменных и ключей.
    Шаблонная вставка вместо программы (<%= @bin %>) — программа неизвестна."""
    if not command:
        return None
    for token in _command_tokens(command):
        if any(mark in token for mark in _TEMPLATE):
            return None
        if token in _WRAPPERS or token.startswith("-") or token.isdigit():
            continue
        name, eq, _value = token.partition("=")
        if eq and name and "/" not in name:
            continue
        return _base(token) or None
    return None


def technology(language: str | None, framework: str | None) -> str | None:
    """Запись технологии контейнера: «Python + FastAPI», «Node.js», «React»."""
    if language and framework:
        return f"{language} + {framework}"
    return language or framework


_QUEUE_OPTS = frozenset({"-Q", "--queues", "--queue", "--queue_name", "--queue-name"})


def queues_in(command: str | None) -> list[str]:
    """Очереди из аргументов команды воркера: celery -Q a,b, --queues=a,b, --queue x,
    --queue_name=x, rq worker a b. Шаблонные вставки (<%= q %>, {{ q }}) не берутся."""
    if not command:
        return []
    tokens = command.split()
    out: list[str] = []

    def add(raw: str) -> None:
        for q in raw.split(","):
            q = q.strip().strip("'\"")
            if q and not any(m in q for m in ("<%", "%>", "{{", "}}", "$")) and q not in out:
                out.append(q)

    i = 0
    while i < len(tokens):
        tok = tokens[i]
        name, eq, value = tok.partition("=")
        if name in _QUEUE_OPTS and eq:
            add(value)
        elif tok in _QUEUE_OPTS and i + 1 < len(tokens):
            add(tokens[i + 1])
            i += 1
        elif tok.startswith("-Q") and len(tok) > 2:
            add(tok[2:])
        i += 1
    if len(tokens) >= 2 and tokens[0].endswith("rq") and tokens[1] == "worker":
        for tok in tokens[2:]:
            if tok.startswith("-"):
                break
            add(tok)
    return out
