import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app import demo
from app.column_limits import ValueTooLong
from app.config import settings
from app.database import get_db
from app.demo_limits import DEMO_LIMIT_CODE, DemoLimitExceeded
from app.routers import (
    admin,
    auth,
    broker_channels,
    channels_import,
    config_import,
    config_params,
    data_import,
    data_refs,
    db_docs,
    docs_import,
    edges,
    export,
    node_docs,
    nodes,
    processes,
    projects,
    recon,
    search,
    users,
    views,
)
from app.routers import demo as demo_router


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Фоновая уборка песочниц — только в демо-режиме (docs/tasks/demo-mode.md):
    asyncio-задача раз в 10 минут, своя сессия БД на прогон."""
    task = asyncio.create_task(demo.cleanup_loop()) if settings.demo_mode else None
    yield
    if task is not None:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task

# redirect_slashes=False намеренно: коллекции объявляются БЕЗ хвостового слэша
# (/api/v1/nodes, /api/v1/projects — единообразно у всех девяти), и промах формы
# пути обязан падать ГРОМКО. По умолчанию FastAPI отвечал на «неправильную» форму
# редиректом 307 с ПУСТЫМ телом — клиент без follow_redirects молча получал
# пустую выдачу: живой MCP так печатал «проектов нет» при 35 проектах (полевая
# находка эпика MCP 2026-09-04). Внешних клиентов у API нет, совместимость со
# старой формой не нужна: теперь это честный 404.
app = FastAPI(
    title="ArchMap API", version="1.0.0", redirect_slashes=False, lifespan=lifespan
)

# CORS-источники задаются в Settings (cors_origins, через запятую) — не хардкод.
allowed_origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]



@app.exception_handler(ValueTooLong)
async def value_too_long(_request: Request, exc: ValueTooLong) -> JSONResponse:
    """Значение не помещается в колонку (проверка перед записью, app/column_limits.py)."""
    return JSONResponse(status_code=422, content={"detail": exc.detail})


@app.exception_handler(DemoLimitExceeded)
async def demo_limit_exceeded(_request: Request, exc: DemoLimitExceeded) -> JSONResponse:
    """Запись вывела проект за предел демо-стенда (центральная проверка в
    app/demo_limits.py): 409 с текстом по прототипу. code отличает отказ по
    пределу от конфликта версий, который тоже 409."""
    return JSONResponse(
        status_code=409, content={"detail": exc.detail, "code": DEMO_LIMIT_CODE}
    )


app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api/v1")
app.include_router(demo_router.router, prefix="/api/v1")
app.include_router(admin.router, prefix="/api/v1")
app.include_router(users.router, prefix="/api/v1")
app.include_router(projects.router, prefix="/api/v1")
app.include_router(nodes.router, prefix="/api/v1")
app.include_router(node_docs.router, prefix="/api/v1")
app.include_router(data_import.router, prefix="/api/v1")
app.include_router(data_refs.router, prefix="/api/v1")
app.include_router(db_docs.tables_router, prefix="/api/v1")
app.include_router(broker_channels.router, prefix="/api/v1")
app.include_router(channels_import.router, prefix="/api/v1")
app.include_router(config_params.router, prefix="/api/v1")
app.include_router(config_import.router, prefix="/api/v1")
app.include_router(docs_import.router, prefix="/api/v1")
app.include_router(recon.router, prefix="/api/v1")
app.include_router(edges.router, prefix="/api/v1")
app.include_router(views.router, prefix="/api/v1")
app.include_router(export.router, prefix="/api/v1")
app.include_router(processes.router, prefix="/api/v1")
app.include_router(search.router, prefix="/api/v1")


@app.get("/health")
def health() -> dict:
    """Процесс жив (liveness). Базу не трогает намеренно: недоступная база — повод не
    слать запросы (/ready), а не перезапускать процесс по кругу."""
    return {"status": "ok"}


@app.get("/ready", response_model=None)
def ready(db: Session = Depends(get_db)) -> dict | JSONResponse:
    """Готов принимать запросы (readiness, ожидание установщика): база отвечает.
    /health отвечал «ок» и при лежащей базе (аудит P-16)."""
    try:
        db.execute(text("SELECT 1"))
    except SQLAlchemyError:
        return JSONResponse(status_code=503, content={"detail": "База данных недоступна"})
    return {"status": "ok"}
