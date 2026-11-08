# Обёртка проекта вместо клиента (posthog/api/metalytics.py:41): в счёт только имена реестра.
from app.client import get_producer
from app.kafka_topics import KAFKA_INGESTION
from app.mail import mailer

get_producer().produce(topic=KAFKA_INGESTION, data={})
mailer.send("welcome")
