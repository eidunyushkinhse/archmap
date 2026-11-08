from enum import Enum


class Topic(Enum):
    INGEST_EVENTS = "ingest-events"
    INGEST_EVENTS_DLQ = "ingest-events-dlq"
    EVENTS = "events"
    SNUBA_METRICS = "snuba-metrics"
