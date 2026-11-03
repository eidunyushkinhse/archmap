from fastapi import APIRouter

admin = APIRouter(prefix="/admin")


@admin.delete("/cache")
def drop_cache():
    return {}
