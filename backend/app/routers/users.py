"""Список пользователей для выбора участника проекта: GET /api/v1/users.

Любому вошедшему: владелец проекта выбирает логин из списка активных пользователей
сервиса (почты и приглашений нет). Отдаём только id и логин активных учёток;
роли, признаки и заблокированные видны лишь администратору на /admin/users.
"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.database import get_db
from app.models.user import User
from app.schemas.auth import UserBrief

router = APIRouter(prefix="/users", tags=["users"])


@router.get("", response_model=list[UserBrief])
def list_users(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> list[User]:
    """Активные пользователи по алфавиту логина."""
    return db.query(User).filter(User.is_active.is_(True)).order_by(User.username).all()
