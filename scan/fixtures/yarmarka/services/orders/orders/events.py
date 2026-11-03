from kafka import KafkaConsumer, KafkaProducer

TOPIC = "orders." + "audit"

consumer = KafkaConsumer("payments.completed", bootstrap_servers="events:9092", group_id="orders")


def audit(producer: KafkaProducer, payload: bytes) -> None:
    # Имя топика собирается выражением: в подсказки, а не в каналы.
    producer.send(TOPIC, payload)
