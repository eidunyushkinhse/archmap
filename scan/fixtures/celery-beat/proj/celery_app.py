from datetime import timedelta

from celery import Celery
from celery.schedules import crontab

PREFIX = "tenant"
app = Celery("proj")
app.conf.beat_schedule = {
    "nightly-report": {"task": "proj.tasks.report", "schedule": crontab(hour=3, minute=0)},
    "ping": {"task": "proj.tasks.ping", "schedule": 30.0},
    # "commented": {"task": "proj.tasks.nothing", "schedule": 1},
    PREFIX + "-sync": {"task": "proj.tasks.sync", "schedule": timedelta(minutes=5)},
    "no-schedule": {"task": "proj.tasks.none"},
}
app.conf.update(
    CELERYBEAT_SCHEDULE={"weekly": {"task": "proj.tasks.weekly", "schedule": crontab(day_of_week="mon")}},
)
