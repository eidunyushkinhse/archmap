# Пример для правила semgrep: расписание Celery, а не код сервиса.
from celery import Celery

app = Celery("rules")
app.conf.beat_schedule = {"nightly": {"task": "rules.nightly", "schedule": 3600.0}}
