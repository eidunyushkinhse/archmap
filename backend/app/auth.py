from datetime import UTC, datetime, timedelta

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from pwdlib import PasswordHash
from pwdlib.hashers.bcrypt import BcryptHasher
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models.user import User
from app.schemas.auth import TokenData

# Строго BcryptHasher (НЕ PasswordHash.recommended() — тот даёт Argon2): в БД лежат
# bcrypt-хэши $2b$..., созданные старым passlib; новый стек обязан их верифицировать.
pwd_context = PasswordHash((BcryptHasher(),))
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")

# Текст отказа заблокированному: один на вход и на запросы с уже выданным токеном.
# Фронт узнаёт по нему блокировку и выходит на экран входа с этим же текстом.
BLOCKED_DETAIL = "Учётная запись заблокирована"

# Единственное правило пароля: длина. Других требований сложности нет намеренно.
MIN_PASSWORD_LENGTH = 8


def password_problem(password: str) -> str | None:
    """Чем новый пароль не годится, или None. Чистая функция без HTTP: её зовут и
    роутеры (отдают текст в detail), и серверная команда create-admin (печатает)."""
    if len(password) < MIN_PASSWORD_LENGTH:
        return f"Пароль должен быть не короче {MIN_PASSWORD_LENGTH} символов"
    return None


def check_new_password(password: str) -> None:
    """Проверка нового пароля для роутеров: 400 с русским текстом в detail."""
    problem = password_problem(password)
    if problem is not None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=problem)


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_access_token(data: dict) -> str:
    payload = data.copy()
    expire = datetime.now(UTC) + timedelta(minutes=settings.access_token_expire_minutes)
    payload["exp"] = expire
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)


def _get_current_user(token: str, db: Session) -> User:
    credentials_error = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Недействительный токен",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
        username: str | None = payload.get("sub")
        role: str | None = payload.get("role")
        if username is None:
            raise credentials_error
        token_data = TokenData(username=username, role=role)
    except jwt.PyJWTError:
        # Детали JWT-ошибки наружу не отдаём — это всегда 401 «не авторизован».
        raise credentials_error from None

    user = db.query(User).filter(User.username == token_data.username).first()
    if user is None:
        raise credentials_error
    # Блокировка действует сразу, в том числе на уже выданный токен: флаг сверяется
    # с БД на каждом запросе (роль берётся отсюда же, из строки БД, а не из токена).
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=BLOCKED_DETAIL,
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


def get_current_user(
    token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)
) -> User:
    return _get_current_user(token, db)


def require_architect(user: User = Depends(get_current_user)) -> User:
    if user.role != "architect":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Требуется роль architect",
        )
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    """Права администратора: управление пользователями. Признак, а не роль, —
    администратор-наблюдатель проходит сюда, но не в require_architect."""
    if not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Требуются права администратора",
        )
    return user
