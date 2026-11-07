# Ловушки: слово queue не последнее (ключи метрик), значение с пробелами (описание).
from enum import Enum

DEAD_LETTER_QUEUE_METRICS = {"dlq_size": {"metric": "Total events"}}


class HelpQueue(Enum):
    SUMMARY = "events waiting for retry"
