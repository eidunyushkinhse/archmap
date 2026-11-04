"""Реестры каналов, декоратор потребителя и брокер по клиенту (ТЗ §13.2): правило одно для
kafka, rabbitmq, celery и nats (pyregistry.py)."""

from __future__ import annotations

from pathlib import Path

from archmap_scan import stats, texts
from archmap_scan.model import Findings
from archmap_scan.objects import BROKER
from archmap_scan.parsers import celery, kafka, nats, rabbitmq
from tests.helpers import files_of, model_of, tree

Row = tuple[str, str, str, str | None, str]

KAFKA_TOPICS = """\
from enum import Enum


class Topic(Enum):
    EVENTS = "events"
    OUTCOMES = "outcomes"
    _HIDDEN = "hidden"


class Topics:
    name = "helper"
    DLQ = "events-dlq"
    __tablename__ = "topics"


class TopicHelper(Enum):
    OTHER = "camel-case-name-is-not-a-registry"


KAFKA_TOPIC_TO_CLUSTER: dict[str, str] = {
    "events": "default",
    "audit": "default",
}
TOPIC_LIMITS = {1: "x"}
"""
KAFKA_PRODUCER = """\
from confluent_kafka import Producer, Consumer

from app.topics import Topic
from . import topics as t

p = Producer({"bootstrap.servers": "kafka:9092"})
p.produce(Topic.EVENTS.value, b"")
p.produce(Topic["OUTCOMES"], b"")
p.produce(t.Topic.EVENTS, b"")
p.produce(Topic.MISSING, b"")
c = Consumer({})
c.subscribe([Topic.EVENTS, t.Topics.DLQ])
"""


def _rows(found: Findings) -> list[Row]:
    uses = sorted(found.channels, key=lambda u: (u.loc, u.name, u.direction or ""))
    return [(u.name, u.kind, u.client, u.direction, str(u.loc)) for u in uses]


def _kafka_tree(root: Path) -> Path:
    return tree(root, {
        "pyproject.toml": '[project]\nname = "app"\ndependencies = ["confluent-kafka"]\n',
        "app/__init__.py": "",
        "app/topics.py": KAFKA_TOPICS,
        "app/producer.py": KAFKA_PRODUCER,
    })


def test_kafka_registry_and_members(tmp_path: Path) -> None:
    ctx, files = files_of(_kafka_tree(tmp_path))
    found = kafka.parse(files, ctx)
    assert _rows(found) == [
        ("events", "topic", "Kafka", "publish", "app/producer.py:7"),
        ("outcomes", "topic", "Kafka", "publish", "app/producer.py:8"),
        ("events", "topic", "Kafka", "publish", "app/producer.py:9"),
        ("events", "topic", "Kafka", "consume", "app/producer.py:12"),
        ("events-dlq", "topic", "Kafka", "consume", "app/producer.py:12"),
        # Реестры без направления: Enum с любыми именами, класс с константами, словарь
        # с ключами-строками. Не реестры: __tablename__, _HIDDEN, словарь с ключами-числами
        # и класс без части topic в имени (TopicHelper, walk.name_tokens).
        ("events", "topic", "Kafka", None, "app/topics.py:5"),
        ("outcomes", "topic", "Kafka", None, "app/topics.py:6"),
        ("events-dlq", "topic", "Kafka", None, "app/topics.py:12"),
        ("events", "topic", "Kafka", None, "app/topics.py:21"),
        ("audit", "topic", "Kafka", None, "app/topics.py:22"),
    ]
    assert [(h.data["name"], h.data["source"]) for h in found.hints] == [
        ("Topic.MISSING", "app/producer.py:10"),
    ]


def test_registry_needs_client(tmp_path: Path) -> None:
    """Без клиента брокера в зависимостях реестр не читается: в Zulip «topic» — тема беседы."""
    tree(tmp_path, {
        "pyproject.toml": '[project]\nname = "app"\ndependencies = ["django"]\n',
        "app/topics.py": KAFKA_TOPICS,
    })
    ctx, files = files_of(tmp_path)
    assert kafka.parse(files, ctx).channels == []


QUEUE_WORKERS = """\
from app.base import assign_queue

NAME = "computed"


@assign_queue("deferred_work")
class DeferredWorker:
    pass


@assign_queue("noop", is_test_queue=True)
class NoopWorker:
    pass


@assign_queue(NAME)
class Dynamic:
    pass


@other("not_a_queue")
def f():
    pass
"""
CHANNELS = 'CHANNEL_SYNONYMS = {"stream": "channel", "streams": "channels"}\n'


def _queue_tree(root: Path, deps: str) -> Path:
    return tree(root, {
        "pyproject.toml": f'[project]\nname = "app"\ndependencies = [{deps}]\n',
        "app/base.py": "def assign_queue(name, is_test_queue=False):\n    return lambda c: c\n",
        "app/workers.py": QUEUE_WORKERS,
        "app/url_decoding.py": CHANNELS,
        "app/queue.py": "import pika\n\nCHANNELS = {\"events\": 1}\n",
    })


def test_queue_decorator_rabbitmq(tmp_path: Path) -> None:
    ctx, files = files_of(_queue_tree(tmp_path, '"pika"'))
    found = rabbitmq.parse(files, ctx)
    # Часть channel вид брокера не называет: реестром она делает словарь только в файле,
    # который сам подключает клиент (CHANNEL_SYNONYMS со словами интерфейса — не реестр).
    assert _rows(found) == [
        ("events", "queue", "RabbitMQ", None, "app/queue.py:3"),
        ("deferred_work", "queue", "RabbitMQ", "consume", "app/workers.py:6"),
    ]
    assert [(h.data["name"], h.data["source"]) for h in found.hints] == [
        ("NAME", "app/workers.py:16"),
    ]


def test_queue_decorator_celery(tmp_path: Path) -> None:
    """Без клиента RabbitMQ очереди реестров и декораторов объявляет Celery; рядом с ним —
    только RabbitMQ, иначе одна очередь была бы записана дважды."""
    ctx, files = files_of(_queue_tree(tmp_path, '"celery"'))
    assert [r[:4] for r in _rows(celery.parse(files, ctx))] == [
        ("deferred_work", "queue", "Celery", "consume"),
    ]
    ctx, files = files_of(_queue_tree(tmp_path / "both", '"celery", "pika"'))
    assert celery.parse(files, ctx).channels == []
    assert [r[:4] for r in _rows(rabbitmq.parse(files, ctx))] == [
        ("events", "queue", "RabbitMQ", None), ("deferred_work", "queue", "RabbitMQ", "consume"),
    ]


def test_celery_member_and_nats_registry(tmp_path: Path) -> None:
    tree(tmp_path, {
        "requirements.txt": "celery\nnats-py\n",
        "proj/queues.py": 'class Queues:\n    EMAILS = "emails"\n',
        "proj/tasks.py": (
            "from proj.queues import Queues\n\n"
            "def run(task):\n    task.apply_async(queue=Queues.EMAILS)\n"
        ),
        "proj/subjects.py": 'SUBJECTS = {"orders.created": 1}\n',
        "proj/bus.py": (
            "import nats\nfrom proj.subjects import SUBJECTS\n\n"
            "async def go(nc):\n    await nc.publish(SUBJECTS['orders.created'], b'')\n"
        ),
    })
    ctx, files = files_of(tmp_path)
    assert _rows(celery.parse(files, ctx)) == [
        ("emails", "queue", "Celery", None, "proj/queues.py:2"),
        ("emails", "queue", "Celery", "publish", "proj/tasks.py:4"),
    ]
    assert _rows(nats.parse(files, ctx)) == [
        ("orders.created", "subject", "NATS", "publish", "proj/bus.py:5"),
        ("orders.created", "subject", "NATS", None, "proj/subjects.py:1"),
    ]


def test_broker_by_client(tmp_path: Path) -> None:
    _kafka_tree(tmp_path)
    tree(tmp_path, {"Dockerfile": "FROM python:3.12\n"})
    model = model_of(tmp_path)
    broker = model.obj("Kafka")
    assert broker is not None and broker.shape == BROKER and broker.host is None
    assert broker.technology == "Kafka" and broker.role == "брокер"
    assert sorted(model.channels["Kafka"]) == ["audit", "events", "events-dlq", "outcomes"]
    # Единственный контейнер владеет кодом: публикация и подписка дают связи с каналом.
    edges = sorted((lk.src.name, lk.dst.name, lk.label, lk.channel) for lk in model.links)
    assert edges == [
        ("Kafka", "Ярмарка", texts.LABEL_DELIVERS, "events"),
        ("Kafka", "Ярмарка", texts.LABEL_DELIVERS, "events-dlq"),
        ("Ярмарка", "Kafka", texts.LABEL_PUBLISHES, "events"),
        ("Ярмарка", "Kafka", texts.LABEL_PUBLISHES, "outcomes"),
    ]
    fams = stats.families(model, Findings(), {})
    assert fams["brokers"].notes == [texts.NOTE_BROKER_BY_CLIENT]


def test_broker_by_client_not_over_manifest(tmp_path: Path) -> None:
    """Брокер того же вида в манифестах есть: по клиенту ничего не создаётся."""
    _kafka_tree(tmp_path)
    tree(tmp_path, {
        "Dockerfile": "FROM python:3.12\n",
        "docker-compose.yml": "services:\n  bus:\n    image: redpanda/redpanda\n",
    })
    model = model_of(tmp_path)
    assert model.obj("Kafka") is None and not model.broker_by_client
    assert sorted(model.channels["bus"]) == ["audit", "events", "events-dlq", "outcomes"]


def test_celery_broker_by_scheme(tmp_path: Path) -> None:
    files: dict[str, str | bytes] = {
        "requirements.txt": "celery\n",
        "Dockerfile": "FROM python:3.12\n",
        "proj/app.py": (
            "from celery import Celery\n\napp = Celery('p', broker='redis://cache:6379/0')\n\n"
            "@app.task(queue='emails')\ndef send():\n    pass\n"
        ),
    }
    model = model_of(tree(tmp_path / "redis", files))
    redis = model.obj("Redis")
    assert redis is not None and redis.shape == BROKER and model.broker_by_client
    assert list(model.channels["Redis"]) == ["emails"]
    # Адрес брокера в окружении контейнера файла называет схему так же.
    files["proj/app.py"] = "from celery import shared_task\n\n@shared_task(queue='emails')\ndef f():\n    pass\n"
    files["docker-compose.yml"] = (
        "services:\n  worker:\n    build: .\n    environment:\n"
        "      CELERY_BROKER_URL: amqp://guest@mq-outside:5672//\n"
    )
    model = model_of(tree(tmp_path / "env", files))
    rabbit = model.obj("RabbitMQ")
    assert rabbit is not None and rabbit.shape == BROKER
    assert list(model.channels["RabbitMQ"]) == ["emails"]
    del files["docker-compose.yml"]
    # Без адреса брокера схему не узнать: брокер не создаётся (ТЗ §7).
    files["proj/app.py"] = "from celery import Celery\n\n@app.task(queue='emails')\ndef f():\n    pass\n"
    model = model_of(tree(tmp_path / "none", files))
    assert not any(o.shape == BROKER for o in model.objects)
    assert [(h["name"], h["reason"]) for h in model.hints["unassigned"]] == [
        ("emails", texts.REASON_NO_BROKER),
    ]


def test_edge_without_owner_goes_to_hints(tmp_path: Path) -> None:
    """Потребитель в каталоге двух контейнеров без воркера: канал записан брокеру, а связь
    ушла в подсказки (ТЗ §13.2)."""
    tree(tmp_path, {
        "pyproject.toml": '[project]\nname = "app"\ndependencies = ["pika"]\n',
        "docker-compose.yml": (
            "services:\n  web:\n    build: .\n  mail:\n    build: .\n"
            "  mq:\n    image: rabbitmq:3\n"
        ),
        "app/workers.py": '@assign_queue("emails")\nclass W:\n    pass\n',
    })
    model = model_of(tmp_path)
    assert list(model.channels["mq"]) == ["emails"]
    assert not any(lk.channel for lk in model.links)
    edge = [h for h in model.hints["unassigned"] if h["kind"] == "edge"]
    assert edge == [{
        "kind": "edge", "name": "emails", "object": "mq", "reason": texts.REASON_MANY_OWNERS,
        "source": "app/workers.py:1",
    }]
    fams = stats.families(model, Findings(), {})
    assert fams["edges"].unassigned == 1
    # Разборщик, давший связь без владельца, назван в покрытии связей.
    assert "rabbitmq" in fams["edges"].contributed
