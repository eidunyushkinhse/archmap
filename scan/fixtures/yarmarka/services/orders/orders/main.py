import os

from fastapi import FastAPI

from orders.api.admin import admin
from orders.api.routes import router

ADMIN_PREFIX = os.getenv("ADMIN_PREFIX", "/internal")

app = FastAPI(title="orders")
app.include_router(router, prefix="/api")
# Префикс из окружения: маршруты admin помечены prefix_unresolved.
app.include_router(admin, prefix=ADMIN_PREFIX)
