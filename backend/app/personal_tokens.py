"""Личные токены доступа (docs/plan-remote-mcp.md, Р4): выпуск, опознание, отметка.

Токен — учётная запись агента или скрипта от имени пользователя на всём /api/v1 и на
/mcp. Права решает строка пользователя, как у сессии интерфейса; токен лишь сужает их:
без удалений, без управления токенами, людьми и проектом на уровне владельца
(require_session_user в app/auth.py), а «только чтение» — только безопасные методы.

Модуль без HTTP: отказы — TokenError, перевод в ответ делает роутер.
"""

import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import as_utc
from app.domain_types import TokenLifetimeDays
from app.models.personal_token import PersonalToken

# По префиксу вход отличает токен от JWT до разбора: JWT начинается с «eyJ».
TOKEN_PREFIX = "archmap_"  # noqa: S105 — метка формата, не секрет
# Сколько первых знаков токена хранится для опознания в списке: «archmap_» и ещё шесть.
SHOWN_PREFIX_LEN = len(TOKEN_PREFIX) + 6
MAX_PER_USER = 20
# Отметка «последний раз» пишется не чаще этого шага: иначе каждый запрос агента
# превращался бы в запись в БД.
USE_STEP = timedelta(minutes=1)
# Методы, которые не меняют данных: только их пропускает токен «только чтение».
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

INVALID_DETAIL = "Токен недействителен: его отозвали, истёк срок или в нём ошибка"
READ_ONLY_DETAIL = "Токен только для чтения: менять данные им нельзя"
NO_DELETE_DETAIL = "Удалять через токен нельзя: это делается в интерфейсе ArchMap"
SESSION_ONLY_DETAIL = "Это делается в интерфейсе ArchMap, не токеном"
DEMO_DETAIL = "На демо-стенде токены недоступны"
LIMIT_DETAIL = f"Токенов не больше {MAX_PER_USER}: отзовите ненужный"
NAME_TAKEN_DETAIL = "Токен с таким именем уже есть"


class TokenError(Exception):
    """Отказ в выпуске токена; текст — для пользователя как есть."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


@dataclass(frozen=True)
class Issued:
    """Выпущенный токен: строка в БД и секрет — его показывают один раз."""

    token: PersonalToken
    secret: str


def is_personal_token(raw: str) -> bool:
    return raw.startswith(TOKEN_PREFIX)


def secret_hash(secret: str) -> str:
    """sha256 секрета, hex. Без соли и «перца»: секрет случайный, 256 бит, перебор
    невозможен; привязка к SECRET_KEY сломала бы все токены при смене ключа."""
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def issue(
    db: Session,
    user_id: uuid.UUID,
    name: str,
    read_only: bool,
    lifetime_days: TokenLifetimeDays | None,
) -> Issued:
    """Выпустить токен: строка в сессии (flush, без коммита) и секрет."""
    count = db.query(func.count(PersonalToken.id)).filter(PersonalToken.user_id == user_id).scalar() or 0
    if count >= MAX_PER_USER:
        raise TokenError(LIMIT_DETAIL)
    taken = db.query(PersonalToken.id).filter(PersonalToken.user_id == user_id, PersonalToken.name == name).first()
    if taken is not None:
        raise TokenError(NAME_TAKEN_DETAIL)
    secret = TOKEN_PREFIX + secrets.token_urlsafe(32)
    now = datetime.now(UTC)
    row = PersonalToken(
        user_id=user_id,
        name=name,
        prefix=secret[:SHOWN_PREFIX_LEN],
        token_hash=secret_hash(secret),
        read_only=read_only,
        created_at=now,
        expires_at=now + timedelta(days=lifetime_days) if lifetime_days is not None else None,
    )
    db.add(row)
    db.flush()
    return Issued(token=row, secret=secret)


def find(db: Session, secret: str) -> PersonalToken | None:
    """Действующий токен по секрету: None — нет такого (отозван, опечатка) или истёк."""
    row = db.query(PersonalToken).filter(PersonalToken.token_hash == secret_hash(secret)).first()
    if row is None:
        return None
    if row.expires_at is not None and as_utc(row.expires_at) <= datetime.now(UTC):
        return None
    return row


def touch(db: Session, row: PersonalToken) -> None:
    """Отметить использование не чаще шага. Коммит отдельный и сразу (как у активности
    гостя): запрос дальше может откатиться, а использование всё равно было. Сессия в
    этот момент чистая — зависимость идёт до ручки."""
    now = datetime.now(UTC)
    last = row.last_used_at
    if last is not None and now - as_utc(last) < USE_STEP:
        return
    row.last_used_at = now
    db.commit()
