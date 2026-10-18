from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session

from app import demo
from app.auth import (
    BLOCKED_DETAIL,
    check_new_password,
    end_sessions,
    get_current_user,
    hash_password,
    require_session_user,
    session_token,
    verify_password,
)
from app.config import settings
from app.database import get_db
from app.models.user import User
from app.schemas.auth import (
    AuthConfig,
    MeResponse,
    PasswordChange,
    Token,
)
from app.schemas.demo import DemoLimits

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/config", response_model=AuthConfig)
def auth_config() -> AuthConfig:
    """Публичные настройки входа — без авторизации (их читают до логина).

    В демо-режиме фронт получает пределы стенда: по ним он проверяет файлы до загрузки.
    Самостоятельной регистрации нет: первого администратора создаёт серверная команда
    create-admin, остальные учётки — администратор на экране «Пользователи»."""
    if not settings.demo_mode:
        return AuthConfig()
    return AuthConfig(
        demo_mode=True,
        demo_limits=DemoLimits(
            nodes=demo.MAX_NODES,
            edges=demo.MAX_EDGES,
            docs=demo.MAX_DOCS,
            processes=demo.MAX_PROCESSES,
            text_bytes=demo.MAX_TEXT_BYTES,
            file_bytes=demo.MAX_FILE_BYTES,
        ),
    )


@router.post("/login", response_model=Token)
def login(
    form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)
) -> Token:
    # Демо-стенд: входа по логину нет, администрирование — серверными командами.
    if settings.demo_mode:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=demo.LOGIN_OFF_DETAIL)
    user = db.query(User).filter(User.username == form.username).first()
    if not user or not verify_password(form.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Неверный логин или пароль",
        )
    # О блокировке говорим только после верного пароля: иначе ответ выдавал бы
    # постороннему, что такая учётка существует.
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=BLOCKED_DETAIL)
    return Token(access_token=session_token(user))


@router.get("/me", response_model=MeResponse)
def me(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> MeResponse:
    """Кто я: роль и признак администратора из БД (токен несёт роль на момент входа),
    признак гостя демо-стенда и можно ли создать ещё один проект."""
    return MeResponse(
        id=user.id,
        username=user.username,
        role=user.role,
        is_admin=user.is_admin,
        is_guest=user.is_guest,
        can_create_project=demo.can_create_project(db, user),
    )


@router.post("/password", response_model=Token)
def change_password(
    payload: PasswordChange,
    user: User = Depends(require_session_user),  # токеном нельзя (Р4)
    db: Session = Depends(get_db),
) -> Token:
    """Смена своего пароля. Все прежние входы закрываются (их мог открыть тот, кто
    узнал старый пароль), а этой сессии отдаётся новый токен — из неё не выкидывает.
    Личные токены для MCP остаются в силе. Гостю демо-стенда пароль не нужен и не
    известен: 403."""
    demo.deny_guest(user)
    if not verify_password(payload.old_password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Неверный текущий пароль"
        )
    check_new_password(payload.new_password)
    user.hashed_password = hash_password(payload.new_password)
    end_sessions(user)
    db.commit()
    return Token(access_token=session_token(user))
