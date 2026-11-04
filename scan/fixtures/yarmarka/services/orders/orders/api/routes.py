from fastapi import APIRouter
from kafka import KafkaProducer

router = APIRouter(prefix="/orders")
producer = KafkaProducer(bootstrap_servers="events:9092")


@router.get("/{order_id}")
def get_order(order_id: int):
    return {"id": order_id}


@router.post("")
def create_order(payload: dict):
    producer.send("orders.created", b"{}")
    return payload


STATUS_PATH = "/{order_id}/status"


# Путь не строкой: в точки входа не попадает, место названо в подсказках.
@router.get(STATUS_PATH)
def order_status(order_id: int):
    return {"id": order_id, "status": "new"}
