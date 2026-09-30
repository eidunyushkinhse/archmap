from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
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
    views,
)

# redirect_slashes=False намеренно: коллекции объявляются БЕЗ хвостового слэша
# (/api/v1/nodes, /api/v1/projects — единообразно у всех девяти), и промах формы
# пути обязан падать ГРОМКО. По умолчанию FastAPI отвечал на «неправильную» форму
# редиректом 307 с ПУСТЫМ телом — клиент без follow_redirects молча получал
# пустую выдачу: живой MCP так печатал «проектов нет» при 35 проектах (полевая
# находка эпика MCP 2026-09-04). Внешних клиентов у API нет, совместимость со
# старой формой не нужна: теперь это честный 404.
app = FastAPI(title="ArchMap API", version="1.0.0", redirect_slashes=False)

# CORS-источники задаются в Settings (cors_origins, через запятую) — не хардкод.
allowed_origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api/v1")
app.include_router(admin.router, prefix="/api/v1")
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
    return {"status": "ok"}
