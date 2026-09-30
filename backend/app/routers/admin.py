"""API администратора: пользователи (docs/tasks/admin-users.md, шаг 3).

Удаления нет намеренно: в проектах живут created_by/updated_by, поэтому вместо
удаления — блокировка (is_active=false). Защиты от потери управления:
нельзя заблокировать себя и снять права с себя, нельзя снять права или
заблокировать последнего активного администратора.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.auth import check_new_password, hash_password, require_admin
from app.database import get_db
from app.models.user import User
from app.schemas.admin import AdminUser, AdminUserCreate, AdminUserUpdate, PasswordReset

router = APIRouter(prefix="/admin", tags=["admin"])

# Логин хранится в String(64): длиннее БД не примет.
_USERNAME_MAX = 64


def _get_user(db: Session, user_id: uuid.UUID) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Пользователь не найден")
    return user


def _bad(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


def _active_admin_ids(db: Session) -> set[uuid.UUID]:
    """Активные администраторы под блокировкой строк (FOR UPDATE, в порядке id).

    Проверка «последний ли» без блокировки проигрывает гонку: два админа, снимающие
    права друг с друга одновременно, оба увидели бы «админов двое» и оставили бы
    систему без администратора. Под FOR UPDATE второй ждёт первого и пересчитывает
    уже после его коммита. На SQLite (тесты) блокировка — пустая операция."""
    rows = (
        db.query(User.id)
        .filter(User.is_admin.is_(True), User.is_active.is_(True))
        .order_by(User.id)
        .with_for_update()
        .all()
    )
    return {row.id for row in rows}


@router.get("/users", response_model=list[AdminUser])
def list_users(
    db: Session = Depends(get_db), _admin: User = Depends(require_admin)
) -> list[User]:
    return db.query(User).order_by(func.lower(User.username), User.username).all()


@router.post("/users", response_model=AdminUser, status_code=status.HTTP_201_CREATED)
def create_user(
    payload: AdminUserCreate,
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
) -> User:
    username = payload.username.strip()
    if not username:
        raise _bad("Укажите логин")
    if len(username) > _USERNAME_MAX:
        raise _bad(f"Логин должен быть не длиннее {_USERNAME_MAX} символов")
    if db.query(User).filter(User.username == username).first() is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Пользователь с таким логином уже есть",
        )
    check_new_password(payload.password)
    user = User(
        username=username,
        hashed_password=hash_password(payload.password),
        role=payload.role,
        is_admin=payload.is_admin,
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.patch("/users/{user_id}", response_model=AdminUser)
def update_user(
    user_id: uuid.UUID,
    payload: AdminUserUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
) -> User:
    user = _get_user(db, user_id)
    is_self = user.id == admin.id

    if payload.is_active is False and user.is_active:
        if is_self:
            raise _bad("Нельзя заблокировать себя")
    if payload.is_admin is False and user.is_admin:
        if is_self:
            raise _bad("Нельзя снять права администратора с себя")

    # Правка, уменьшающая число активных администраторов: снять права с активного
    # админа или заблокировать его. Последнего такого трогать нельзя.
    loses_admin = user.is_admin and user.is_active and (
        payload.is_admin is False or payload.is_active is False
    )
    if loses_admin:
        active_admins = _active_admin_ids(db)
        if active_admins <= {user.id}:
            if payload.is_active is False:
                raise _bad("Нельзя заблокировать последнего администратора")
            raise _bad("Нельзя снять права с последнего администратора")

    if payload.role is not None:
        user.role = payload.role
    if payload.is_admin is not None:
        user.is_admin = payload.is_admin
    if payload.is_active is not None:
        user.is_active = payload.is_active
    db.commit()
    db.refresh(user)
    return user


@router.post("/users/{user_id}/password", status_code=status.HTTP_204_NO_CONTENT)
def reset_password(
    user_id: uuid.UUID,
    payload: PasswordReset,
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
) -> None:
    """Сброс пароля: новый задаёт администратор и передаёт человеку сам."""
    user = _get_user(db, user_id)
    check_new_password(payload.new_password)
    user.hashed_password = hash_password(payload.new_password)
    db.commit()
