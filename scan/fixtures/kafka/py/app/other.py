# Файл без импорта клиента Kafka: send здесь не публикация в топик.
def notify(client):
    client.send("not-a-topic", 1)
