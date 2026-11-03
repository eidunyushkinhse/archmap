from celery.decorators import periodic_task
from celery.schedules import crontab

from proj.celery_app import app


@periodic_task(run_every=crontab(minute="*/15"))
def refresh():
    return None


@app.on_after_configure.connect
def setup(sender, **kwargs):
    sender.add_periodic_task(60.0, ping.s(), name="ping-every-minute")
    sender.add_periodic_task(crontab(hour=7), report.s())


@app.task
def ping():
    return "pong"


@app.task
def report():
    return None
