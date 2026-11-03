"""Каналы брокеров из кода (ТЗ §6.2, §7): Celery, Kafka, RabbitMQ, NATS по фикстурам;
брокер-владелец, связи с каналом и потребители."""

from __future__ import annotations

from pathlib import Path

from archmap_scan import texts
from archmap_scan.parsers import celery, kafka, nats, rabbitmq
from tests.helpers import FIXTURES, files_of, model_of, tree

Row = tuple[str, str, str | None, str | None, str]


def _uses(parser: object, root: Path) -> tuple[list[Row], list[tuple[object, object]]]:
    ctx, files = files_of(root)
    found = parser.parse(files, ctx)  # type: ignore[attr-defined]
    uses = sorted(found.channels, key=lambda u: (u.loc, u.name, u.direction or ""))
    rows = [(u.name, u.kind, u.direction, u.broker_host, str(u.loc)) for u in uses]
    return rows, [(h.data["name"], h.data["source"]) for h in found.hints]


def test_celery_fixture() -> None:
    rows, hints = _uses(celery, FIXTURES / "celery")
    assert rows == [
        ("default", "queue", None, "rabbit", "proj/celery_app.py:5"),
        ("default", "queue", None, "rabbit", "proj/celery_app.py:6"),
        ("emails", "queue", None, "rabbit", "proj/celery_app.py:6"),
        ("emails", "queue", None, "rabbit", "proj/celery_app.py:7"),
        ("reports", "queue", None, "rabbit", "proj/celery_app.py:7"),
        ("default", "queue", None, "rabbit", "proj/celery_app.py:8"),
        ("emails", "queue", None, None, "proj/tasks.py:8"),
        ("emails", "queue", "publish", None, "proj/tasks.py:20"),
        ("reports", "queue", "publish", None, "proj/tasks.py:21"),
    ]
    assert hints == [("QUEUE", "proj/tasks.py:14")]


def test_kafka_fixture() -> None:
    rows, hints = _uses(kafka, FIXTURES / "kafka")
    assert rows == [
        ("orders.created", "topic", "publish", "kafka", "go/main.go:9"),
        ("payments", "topic", "consume", "kafka", "go/main.go:10"),
        ("audit", "topic", "publish", "kafka", "go/main.go:11"),
        ("refunds", "topic", "consume", "kafka", "go/main.go:12"),
        ("payments", "topic", "consume", "kafka", "go/main.go:13"),
        ("refunds", "topic", "consume", "kafka", "go/main.go:13"),
        ("orders.created", "topic", "publish", "kafka", "js/src/kafka.js:6"),
        ("payments", "topic", "consume", "kafka", "js/src/kafka.js:7"),
        ("refunds", "topic", "consume", "kafka", "js/src/kafka.js:7"),
        ("audit", "topic", None, "kafka", "js/src/kafka.js:9"),
        ("orders.created", "topic", "publish", "kafka", "py/app/producer.py:6"),
        ("payments", "topic", "consume", "kafka", "py/app/producer.py:7"),
        ("refunds", "topic", "consume", "kafka", "py/app/producer.py:7"),
        ("audit", "topic", "consume", "kafka", "py/app/producer.py:8"),
        ("orders.created", "topic", None, "kafka", "py/app/producer.py:9"),
    ]
    # Файл без импорта клиента Kafka и строка в комментарии каналов не дали.
    assert not any(r[0] in ("not-a-topic", "commented") for r in rows)
    assert hints == [("topic_name", "py/app/producer.py:11"), ("`dyn.${env}`", "js/src/kafka.js:8")]


def test_rabbitmq_fixture() -> None:
    rows, hints = _uses(rabbitmq, FIXTURES / "rabbitmq")
    assert rows == [
        ("tasks", "queue", None, "rabbitmq", "js/src/amqp.js:6"),
        ("logs", "exchange", None, "rabbitmq", "js/src/amqp.js:7"),
        ("logs", "exchange", None, "rabbitmq", "js/src/amqp.js:8"),
        ("tasks", "queue", None, "rabbitmq", "js/src/amqp.js:8"),
        ("tasks", "queue", "publish", "rabbitmq", "js/src/amqp.js:9"),
        ("logs", "exchange", "publish", "rabbitmq", "js/src/amqp.js:10"),
        ("tasks", "queue", "publish", "rabbitmq", "js/src/amqp.js:11"),
        ("tasks", "queue", "consume", "rabbitmq", "js/src/amqp.js:12"),
        ("events", "exchange", None, "rabbitmq", "py/worker.py:5"),
        ("emails", "queue", None, "rabbitmq", "py/worker.py:6"),
        ("emails", "queue", None, "rabbitmq", "py/worker.py:7"),
        ("events", "exchange", None, "rabbitmq", "py/worker.py:7"),
        ("events", "exchange", "publish", "rabbitmq", "py/worker.py:8"),
        ("emails", "queue", "publish", "rabbitmq", "py/worker.py:9"),
        ("emails", "queue", "consume", "rabbitmq", "py/worker.py:10"),
    ]
    assert hints == [("name", "py/worker.py:12"), ("queueName", "js/src/amqp.js:13")]


def test_nats_fixture() -> None:
    rows, hints = _uses(nats, FIXTURES / "nats")
    assert rows == [
        ("updates", "subject", "consume", "nats", "go/main.go:7"),
        ("jobs", "subject", "consume", "nats", "go/main.go:8"),
        ("jobs.done", "subject", "publish", "nats", "go/main.go:9"),
        ("updates", "subject", "consume", None, "js/src/n.js:6"),
        ("updates.done", "subject", "publish", None, "js/src/n.js:7"),
        ("orders.*", "subject", "consume", "nats", "py/svc.py:6"),
        ("orders.created", "subject", "publish", "nats", "py/svc.py:7"),
    ]
    # Своя шина в Go и подписка RxJS без подключения клиента NATS не дали ни каналов, ни
    # подсказок.
    assert hints == [("subject", "py/svc.py:8"), ("subj", "go/main.go:10")]


KAFKA_APP = (
    "from kafka import KafkaConsumer, KafkaProducer\n"
    'p = KafkaProducer()\np.send("orders", b"")\nc = KafkaConsumer("payments")\n'
)


def _compose(brokers: str, env: str = "") -> str:
    return (
        "services:\n  api:\n    build: ./api\n    command: gunicorn app:app\n"
        f"{env}{brokers}"
    )


def test_channel_edges_replace_uses_link(tmp_path: Path) -> None:
    tree(tmp_path, {
        "docker-compose.yml": _compose(
            "  bus:\n    image: bitnami/kafka\n",
            "    environment:\n      KAFKA_BOOTSTRAP: bus:9092\n",
        ),
        "api/requirements.txt": "kafka-python\n",
        "api/app.py": KAFKA_APP,
    })
    model = model_of(tmp_path)
    links = [(lk.src.name, lk.dst.name, lk.label, lk.channel, lk.sync) for lk in model.links]
    assert links == [
        ("api", "bus", "публикует", "orders", False),
        ("bus", "api", "потребляет", "payments", False),
    ]
    assert sorted(model.channels["bus"]) == ["orders", "payments"]
    assert [c.channel for c in model.consumers["api"]] == ["payments"]


def test_broker_chain(tmp_path: Path) -> None:
    # Два брокера Kafka и адрес ни на один не указывает: владелец не определим.
    tree(tmp_path / "many", {
        "docker-compose.yml": _compose(
            "  a:\n    image: bitnami/kafka\n  b:\n    image: bitnami/kafka\n",
        ),
        "api/requirements.txt": "kafka-python\n",
        "api/app.py": KAFKA_APP,
    })
    model = model_of(tmp_path / "many")
    assert model.channels == {}
    reasons = {h["reason"] for h in model.hints["unassigned"] if h["kind"] == "channel"}
    assert reasons == {texts.REASON_MANY_BROKERS}
    # Брокера в манифестах нет: каналы в подсказки, брокер не создаётся.
    tree(tmp_path / "none", {
        "docker-compose.yml": _compose(""),
        "api/requirements.txt": "celery\n",
        "api/tasks.py": "from celery import shared_task\n\n"
        '@shared_task(queue="mail")\ndef send():\n    return None\n',
    })
    model = model_of(tmp_path / "none")
    assert [o.name for o in model.objects] == ["api"]
    assert [(h["name"], h["reason"]) for h in model.hints["unassigned"]] == [
        ("mail", texts.REASON_NO_BROKER),
    ]


def test_celery_broker_by_code_address_turns_cache_into_broker(tmp_path: Path) -> None:
    tree(tmp_path, {
        "docker-compose.yml": _compose("  redis:\n    image: redis:7\n  cache:\n    image: redis:7\n"),
        "api/requirements.txt": "celery\n",
        "api/tasks.py": "from celery import Celery\n"
        'app = Celery("x", broker="redis://redis:6379/0")\n'
        'app.send_task("t", queue="mail")\n',
    })
    model = model_of(tmp_path)
    redis = model.obj("redis")
    assert redis is not None and redis.shape == "broker"
    cache = model.obj("cache")
    assert cache is not None and cache.shape == "database"
    assert [(lk.src.name, lk.dst.name, lk.channel) for lk in model.links] == [
        ("api", "redis", "mail"),
    ]


def test_unsupported_channel_library_is_named(tmp_path: Path) -> None:
    from archmap_scan.scan import Options, run

    tree(tmp_path / "repo", {"requirements.txt": "google-cloud-pubsub\n", "app.py": "x = 1\n"})
    result = run(Options(path=str(tmp_path / "repo"), out=str(tmp_path / "out"), use_git=False))
    stat = result.coverage.families["channels"]
    assert stat.status == "unsupported" and stat.unsupported == ["Pub/Sub"]


def test_client_import_check() -> None:
    from archmap_scan import codetext

    sarama = frozenset({"github.com/ibm/sarama"})
    assert codetext.imports('import "github.com/IBM/sarama"\n', sarama, codetext.GO)
    assert not codetext.imports('import "github.com/x/y"\n', sarama, codetext.GO)
    nats_js = frozenset({"nats"})
    assert codetext.imports("import { connect } from 'nats/lib/x';\n", nats_js, codetext.JS)
    assert codetext.imports('const n = require("nats");\n', nats_js, codetext.JS)
    assert not codetext.imports("require('natsx'); // 'nats", nats_js, codetext.JS)
