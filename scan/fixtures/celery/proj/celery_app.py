from celery import Celery
from kombu import Queue

app = Celery("proj", broker="amqp://guest@rabbit//")
app.conf.task_default_queue = "default"
app.conf.task_queues = (Queue("default"), Queue("emails"))
app.conf.task_routes = {"proj.tasks.send": {"queue": "emails"}, "proj.tasks.report": "reports"}
app.conf.update(task_default_queue="default")
