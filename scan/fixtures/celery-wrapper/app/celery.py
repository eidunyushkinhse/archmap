from datetime import timedelta

from celery import Celery
from celery.schedules import crontab
from django.conf import settings

from app.tasks import cleanup, digest, ping, report, sync

app = Celery("app")


def add_periodic_task_with_expiry(sender, schedule, sig, name, expires=None):
    # Обёртка сама зовёт add_periodic_task с параметрами: это не расписание.
    sender.add_periodic_task(schedule, sig, name=name, expires=expires)


@app.on_after_configure.connect
def setup_periodic_tasks(sender, **kwargs):
    add_periodic_task_with_expiry(sender, crontab(minute="37"), cleanup.s(), name="expire unused datasets")
    add_periodic_task_with_expiry(sender, 30.0, ping.s(), "ping every 30 seconds")
    add_periodic_task_with_expiry(sender, schedule=timedelta(hours=1), sig=report.s(), name="hourly report")
    add_periodic_task_with_expiry(sender, crontab(hour=6), digest.signature(), name="morning digest")
    add_periodic_task_with_expiry(sender, settings.SYNC_SCHEDULE, sync.s(), name="sync")
    # Прямой вызов рядом читался и раньше и не задваивается.
    sender.add_periodic_task(60, ping.s(), name="direct ping")
