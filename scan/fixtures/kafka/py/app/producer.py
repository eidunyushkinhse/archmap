from confluent_kafka import Producer
from kafka import KafkaConsumer
from kafka.admin import NewTopic

producer = Producer({"bootstrap.servers": "kafka:9092"})
producer.produce("orders.created", b"{}")
consumer = KafkaConsumer("payments", "refunds", bootstrap_servers="kafka:9092")
consumer.subscribe(["audit"])
NewTopic("orders.created", 3, 1)
topic_name = "computed"
producer.produce(topic_name, b"")
# producer.produce("commented") — строка в комментарии каналом не считается.
