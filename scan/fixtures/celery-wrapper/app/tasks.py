from app.celery import app


@app.task
def cleanup():
    pass


@app.task
def ping():
    pass


@app.task
def report():
    pass


@app.task
def digest():
    pass


@app.task
def sync():
    pass
