from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routers import (
    auth,
    data_import,
    db_docs,
    docs_import,
    edges,
    export,
    node_docs,
    nodes,
    processes,
    projects,
    views,
)

app = FastAPI(title="ArchMap API", version="1.0.0")

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
app.include_router(projects.router, prefix="/api/v1")
app.include_router(nodes.router, prefix="/api/v1")
app.include_router(node_docs.router, prefix="/api/v1")
app.include_router(data_import.router, prefix="/api/v1")
app.include_router(db_docs.catalog_router, prefix="/api/v1")
app.include_router(db_docs.tables_router, prefix="/api/v1")
app.include_router(db_docs.access_router, prefix="/api/v1")
app.include_router(docs_import.router, prefix="/api/v1")
app.include_router(edges.router, prefix="/api/v1")
app.include_router(views.router, prefix="/api/v1")
app.include_router(export.router, prefix="/api/v1")
app.include_router(processes.router, prefix="/api/v1")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
