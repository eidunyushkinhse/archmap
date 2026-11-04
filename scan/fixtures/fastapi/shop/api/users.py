from fastapi import APIRouter

router = APIRouter(prefix="/users")
PREFIX = "/x"


@router.get("/")
def list_users():
    return []


@router.post("/{user_id}/block")
def block(user_id: int):
    return {"id": user_id}


# Путь не строкой: маршрут уходит в подсказки, а не в точки входа.
@router.get(PREFIX + "/dyn")
def dynamic():
    return {}


# @router.get("/commented") — строка в комментарии маршрутом не считается.
