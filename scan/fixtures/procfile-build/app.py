import os

from flask import Flask

app = Flask(__name__)
DATABASE_URL = os.environ["DATABASE_URL"]


@app.get("/orders")
def orders():
    return []
