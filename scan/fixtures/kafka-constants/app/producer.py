from confluent_kafka import Consumer, Producer

from app.kafka_topics import KAFKA_AUDIT as AUDIT
from app.kafka_topics import KAFKA_EVENTS_JSON, KAFKA_INGESTION
from app.settings import KAFKA_PREFIX

p = Producer({"bootstrap.servers": "kafka:9092"})
p.produce(KAFKA_EVENTS_JSON, b"")
p.produce(topic=AUDIT, value=b"")
p.produce(KAFKA_PREFIX, b"")
c = Consumer({})
c.subscribe([KAFKA_INGESTION])
