from fastapi import APIRouter

# Роутер нигде не подключён: свой префикс известен, место подключения нет.
admin = APIRouter(prefix="/admin")


@admin.delete("/cache")
def drop_cache():
    return {}
