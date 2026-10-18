"""Список пользователей для выбора участника проекта: GET /api/v1/users.

Любому вошедшему: владелец проекта выбирает логин из списка активных пользователей
сервиса (почты и приглашений нет). Отдаём id, логин и can_edit — может ли человек быть
редактором или владельцем (иначе он «Пользователь» и бывает только читателем);
остальные признаки и заблокированные видны лишь администратору на /admin/users.
"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app import demo
from app.access import can_edit
from app.auth import get_current_user
from app.database import get_db
from app.models.user import User
from app.schemas.auth import UserBrief

router = APIRouter(prefix="/users", tags=["users"])


@router.get("", response_model=list[UserBrief])
def list_users(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[UserBrief]:
    """Активные пользователи по алфавиту логина. Гостю демо-стенда — 403: делиться
    песочницей ему не с кем и незачем знать чужие логины."""
    demo.deny_guest(user)
    rows = db.query(User).filter(User.is_active.is_(True)).order_by(User.username).all()
    return [UserBrief(id=u.id, username=u.username, can_edit=can_edit(u)) for u in rows]
