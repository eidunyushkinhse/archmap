from celery import Celery
from celery.schedules import crontab

app = Celery("billing", broker="redis://redis:6379/0")
app.conf.task_routes = {"billing.tasks.*": {"queue": "billing"}}
app.conf.beat_schedule = {
    "close-day": {"task": "billing.tasks.close_day", "schedule": crontab(hour=0, minute=5)},
}


@app.task(queue="invoices")
def send_invoice(order_id):
    close_day.apply_async(args=[order_id], queue="billing")


@app.task
def close_day(order_id=None):
    return order_id
