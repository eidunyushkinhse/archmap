from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import auth, edges, nodes

app = FastAPI(title="ArchMap API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api/v1")
app.include_router(nodes.router, prefix="/api/v1")
app.include_router(edges.router, prefix="/api/v1")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
