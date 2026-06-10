"""Тесты auth-стека после миграции python-jose→PyJWT и passlib→pwdlib.

Ключевой — характеризационный: новый verify ОБЯЗАН принимать bcrypt-хэши,
сгенерированные старым passlib, иначе существующие пользователи не войдут.
Референс-хэш ниже сгенерирован старым стеком (passlib CryptContext bcrypt) для
пароля LEGACY_PASSWORD и зашит константой намеренно — он фиксирует контракт.
"""

import datetime as dt

import jwt
import pytest
from fastapi import HTTPException

from app.auth import (
    _get_current_user,
    create_access_token,
    hash_password,
    verify_password,
)
from app.config import settings
from app.models.user import User

# Сгенерировано старым passlib (CryptContext schemes=["bcrypt"]) — НЕ менять.
LEGACY_PASSWORD = "archmap-legacy-pass-2026"
LEGACY_PASSLIB_HASH = "$2b$12$raPr/iqngxk7/iEyRWDHMOPVzOmUZqw6qPJSu2QAeyz2.Fk7mwXay"


def test_hash_verify_roundtrip():
    h = hash_password("s3cret-pw")
    assert h != "s3cret-pw"
    assert verify_password("s3cret-pw", h)
    assert not verify_password("wrong-pw", h)


def test_verify_legacy_passlib_hash():
    # Новый pwdlib-стек принимает старый passlib-хэш — иначе все юзеры залочены.
    assert verify_password(LEGACY_PASSWORD, LEGACY_PASSLIB_HASH)
    assert not verify_password("wrong-pw", LEGACY_PASSLIB_HASH)


def test_access_token_roundtrip():
    token = create_access_token({"sub": "alice", "role": "architect"})
    payload = jwt.decode(
        token, settings.secret_key, algorithms=[settings.algorithm]
    )
    assert payload["sub"] == "alice"
    assert payload["role"] == "architect"
    assert "exp" in payload


def test_expired_token_rejected(db):
    # Токен с exp в прошлом → _get_current_user отвергает 401 (ловит PyJWTError).
    expired = jwt.encode(
        {
            "sub": "alice",
            "role": "architect",
            "exp": dt.datetime.now(dt.UTC) - dt.timedelta(minutes=1),
        },
        settings.secret_key,
        algorithm=settings.algorithm,
    )
    with pytest.raises(HTTPException) as exc:
        _get_current_user(expired, db)
    assert exc.value.status_code == 401


def test_valid_token_resolves_user(db):
    # Сквозной путь: создаём юзера, токен на его username, _get_current_user находит.
    user = User(
        username="alice",
        hashed_password=hash_password("pw"),
        role="architect",
    )
    db.add(user)
    db.commit()

    token = create_access_token({"sub": "alice", "role": "architect"})
    resolved = _get_current_user(token, db)
    assert resolved.username == "alice"
    assert resolved.role == "architect"
