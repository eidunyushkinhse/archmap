# Реестр топиков константами модуля (в духе posthog/kafka_client/topics.py).
import os

from app.settings import KAFKA_PREFIX, SUFFIX
from app.utils import get_from_env

KAFKA_EVENTS_JSON = f"{KAFKA_PREFIX}clickhouse_events_json{SUFFIX}"
KAFKA_INGESTION = get_from_env("KAFKA_INGESTION_TOPIC", f"{KAFKA_PREFIX}events_ingestion{SUFFIX}")
KAFKA_AUDIT: str = os.environ.get("KAFKA_AUDIT_TOPIC", "audit_log")
KAFKA_DYNAMIC = f"{KAFKA_PREFIX}{SUFFIX}"
PARTITIONS = 12
kafka_lowercase = "not-a-topic"
DESCRIPTION = "events of the day"
