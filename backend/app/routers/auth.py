from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session

from app import demo
from app.auth import (
    BLOCKED_DETAIL,
    check_new_password,
    create_access_token,
    get_current_user,
    hash_password,
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
    UserCreate,
    UserResponse,
)
from app.schemas.demo import DemoLimits

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/config", response_model=AuthConfig)
def auth_config() -> AuthConfig:
    """Публичные настройки входа — без авторизации (их читают до логина).

    В демо-режиме регистрации нет при любом ALLOW_SIGNUP, а фронт получает пределы
    стенда: по ним он проверяет файлы до загрузки."""
    if not settings.demo_mode:
        return AuthConfig(allow_signup=settings.allow_signup)
    return AuthConfig(
        allow_signup=False,
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


@router.post("/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def register(payload: UserCreate, db: Session = Depends(get_db)) -> User:
    # Демо-стенд: учётки заводит только кнопка «Попробовать без регистрации».
    if settings.demo_mode:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=demo.SIGNUP_OFF_DETAIL)
    # Закрытый контур: учётки заводит администратор, открытая регистрация выключена.
    if not settings.allow_signup:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Регистрация отключена: учётную запись заводит администратор",
        )
    if db.query(User).filter(User.username == payload.username).first():
        raise HTTPException(status_code=400, detail="Пользователь уже существует")
    if payload.role not in ("architect", "viewer"):
        raise HTTPException(status_code=400, detail="Недопустимая роль")
    check_new_password(payload.password)
    user = User(
        username=payload.username,
        hashed_password=hash_password(payload.password),
        role=payload.role,
        # Регистрация НИКОГДА не даёт прав администратора: первый админ — командой
        # на сервере, остальных назначает админ на экране «Пользователи».
        is_admin=False,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


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
    token = create_access_token({"sub": user.username, "role": user.role})
    return Token(access_token=token)


@router.get("/me", response_model=MeResponse)
def me(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> MeResponse:
    """Кто я: роль и признак администратора из БД (токен несёт роль на момент входа),
    признак гостя демо-стенда и можно ли создать ещё один проект."""
    return MeResponse(
        id=user.id,
        username=user.username,
        role=user.role,  # type: ignore[arg-type]  # Enum в БД держит тот же набор
        is_admin=user.is_admin,
        is_guest=user.is_guest,
        can_create_project=demo.can_create_project(db, user),
    )


@router.post("/password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(
    payload: PasswordChange,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """Смена своего пароля. Выданные токены остаются в силе: пароль в них не входит.
    Гостю демо-стенда пароль не нужен и не известен: 403."""
    demo.deny_guest(user)
    if not verify_password(payload.old_password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Неверный текущий пароль"
        )
    check_new_password(payload.new_password)
    user.hashed_password = hash_password(payload.new_password)
    db.commit()
