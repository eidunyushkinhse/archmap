from fastapi import FastAPI

from shop import api
from shop.api import items
from shop.sub import subapp

app = FastAPI(title="shop")
# Роутер из shop/api/users.py через реэкспорт в shop/api/__init__.py.
app.include_router(api.router, prefix="/v1")
app.include_router(items.router, prefix="/v1/items")
app.mount("/sub", subapp)


@app.get("/health")
async def health():
    return {"ok": True}


@app.api_route("/ping", methods=["GET", "HEAD"])
def ping():
    return "pong"


def legacy(request):
    return {}


app.add_api_route("/legacy", legacy, methods=["POST"])
