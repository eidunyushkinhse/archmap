import click

from app import settings
from app.kafka_definition import Topic

KAFKA_CONSUMERS = {
    "ingest-events": {
        "topic": Topic.INGEST_EVENTS,
        "dlq_topic": Topic.INGEST_EVENTS_DLQ,
        "stale_topic": None,
    },
    "post-process-forwarder-errors": {
        "topic": Topic.EVENTS,
        "synchronize_commit_log_topic_default": "snuba-commit-log",
    },
    "metrics-last-seen-updater": {"topic": Topic.SNUBA_METRICS},
    "dynamic-consumer": {"topic": settings.CONSUMER_TOPIC},
}
# Ловушки: ключи сопоставления топиков и реестр без ключа topic не консьюмеры.
KAFKA_TOPIC_TO_CLUSTER = {"events": "default"}
LEGACY_CONSUMERS = {"old-consumer": {"group": "legacy"}}
