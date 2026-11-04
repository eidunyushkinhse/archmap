import pika

conn = pika.BlockingConnection(pika.URLParameters("amqp://guest:guest@rabbitmq:5672/"))
ch = conn.channel()
ch.exchange_declare(exchange="events", exchange_type="topic")
ch.queue_declare(queue="emails", durable=True)
ch.queue_bind(queue="emails", exchange="events")
ch.basic_publish(exchange="events", routing_key="user.created", body=b"")
ch.basic_publish(exchange="", routing_key="emails", body=b"")
ch.basic_consume(queue="emails", on_message_callback=print)
name = "computed"
ch.basic_publish(exchange="", routing_key=name, body=b"")
