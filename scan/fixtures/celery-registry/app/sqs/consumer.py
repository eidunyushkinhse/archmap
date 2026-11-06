# Ловушка: модуль клиента AWS, его очереди не очереди Celery.
import boto3

QUEUES = {"billing": "https://sqs.example/billing"}
client = boto3.client("sqs")
