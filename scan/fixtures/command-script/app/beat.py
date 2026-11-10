from celery import Celery
from celery.schedules import crontab

app = Celery("app")
app.conf.beat_schedule = {
    "nightly": {"task": "app.tasks.nightly", "schedule": crontab(hour=3, minute=0)},
}
