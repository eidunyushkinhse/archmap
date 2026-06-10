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
