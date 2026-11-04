from celery import shared_task

from proj.celery_app import app

QUEUE = "computed"


@shared_task(queue="emails")
def send():
    return None


# Очередь не строкой: в подсказки, а не в каналы.
@app.task(bind=True, queue=QUEUE)
def dynamic(self):
    return None


def trigger():
    send.apply_async(queue="emails")
    app.send_task("proj.tasks.report", queue="reports")
    # send.apply_async(queue="commented") — строка в комментарии каналом не считается.
