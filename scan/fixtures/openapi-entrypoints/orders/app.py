from flask import Flask

app = Flask(__name__)


@app.get("/orders/<int:order_id>")
def order(order_id: int) -> dict:
    return {}
