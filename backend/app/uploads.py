"""Загрузка файла с машины агента по одноразовой ссылке (docs/plan-mcp-upload.md).

Зачем: удалённый MCP-сервер (/mcp) принимает файлы только текстом внутри вызова, и модель
перепечатывает YAML заново — на десятках килобайт с потерями, которых никто не видит.
Здесь канал для байтов как есть: владелец (по токену или сессии) просит ссылку, агент
кладёт по ней файл обычным curl без токена в команде, инструменты MCP берут содержимое по
upload_id. Что одноразово, а что нет: ССЫЛКА одноразовая (право залить), ЗАГРУЗКА живёт до
срока и читается владельцем сколько угодно — превью и применение читают одни и те же
входы. Домен без HTTP: ошибки — UploadError со статусом, роутер переводит их в ответ.
"""

import hashlib
import hmac
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy.orm import Session

from app.config import settings
from app.database import as_utc
from app.models.upload import Upload
from app.models.user import User

TTL = timedelta(minutes=10)
# Сколько незавершённых и ещё живых загрузок держит один пользователь.
MAX_LIVE_PER_USER = 16
KEY_BYTES = 32

DEMO_DETAIL = "В демо-режиме загрузка файлов недоступна"
NOT_FOUND_DETAIL = "Загрузка не найдена или ссылка неверна"
EXPIRED_DETAIL = "Срок загрузки истёк — запросите новую ссылку"
ALREADY_DETAIL = "По этой ссылке файл уже принят: ссылка одноразовая, запросите новую"
EMPTY_DETAIL = "Пустой файл"
NOT_UPLOADED_DETAIL = "Файл по этой загрузке ещё не принят — сначала положите его по ссылке"
NOT_TEXT_DETAIL = "Файл не текстовый (не UTF-8): инструменты принимают YAML и текстовые пакеты"
TOO_MANY_DETAIL = f"Больше {MAX_LIVE_PER_USER} живых загрузок не держим — дождитесь истечения прежних"


def too_large_detail() -> str:
    return f"Файл больше предела {settings.upload_max_mb} МБ (UPLOAD_MAX_MB)"


class UploadError(Exception):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def max_bytes() -> int:
    return settings.upload_max_mb * 1024 * 1024


def _hash(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def purge_expired(db: Session, now: datetime | None = None) -> int:
    """Ленивая уборка просроченных строк: при каждой новой ссылке, своя сессия не нужна."""
    moment = now or datetime.now(UTC)
    rows = db.query(Upload).filter(Upload.expires_at < moment).all()
    for row in rows:
        db.delete(row)
    return len(rows)


def create(db: Session, user: User, name: str) -> tuple[Upload, str]:
    """Новая ссылка: строка без содержимого и ключ (вернуть один раз, в БД — хэш)."""
    now = datetime.now(UTC)
    purge_expired(db, now)
    live = db.query(Upload).filter(Upload.user_id == user.id, Upload.expires_at >= now).count()
    if live >= MAX_LIVE_PER_USER:
        raise UploadError(429, TOO_MANY_DETAIL)
    key = secrets.token_urlsafe(KEY_BYTES)
    row = Upload(
        id=uuid.uuid4(),
        user_id=user.id,
        name=name,
        key_hash=_hash(key),
        created_at=now,
        expires_at=now + TTL,
    )
    db.add(row)
    db.flush()
    return row, key


def for_link(db: Session, upload_id: uuid.UUID, key: str) -> Upload:
    """Строка по ссылке — для приёма файла. Чужой id и неверный ключ отвечают одинаково
    (существование загрузок не выдаём); просрочка и повтор — своими словами."""
    row = db.get(Upload, upload_id)
    if row is None or not hmac.compare_digest(row.key_hash, _hash(key)):
        raise UploadError(404, NOT_FOUND_DETAIL)
    if as_utc(row.expires_at) < datetime.now(UTC):
        raise UploadError(410, EXPIRED_DETAIL)
    if row.uploaded_at is not None:
        raise UploadError(409, ALREADY_DETAIL)
    return row


def receive(db: Session, row: Upload, data: bytes) -> Upload:
    """Принять байты: размер и sha256 считаются здесь, их агент сверяет у себя."""
    if not data:
        raise UploadError(422, EMPTY_DETAIL)
    if len(data) > max_bytes():
        raise UploadError(413, too_large_detail())
    row.content = data
    row.size = len(data)
    row.sha256 = hashlib.sha256(data).hexdigest()
    row.uploaded_at = datetime.now(UTC)
    db.flush()
    return row


def owned(db: Session, user: User, upload_id: uuid.UUID) -> Upload:
    """Принятый файл владельца — для инструментов MCP. Чужая загрузка — 404."""
    row = db.get(Upload, upload_id)
    if row is None or row.user_id != user.id:
        raise UploadError(404, NOT_FOUND_DETAIL)
    if as_utc(row.expires_at) < datetime.now(UTC):
        raise UploadError(410, EXPIRED_DETAIL)
    if row.uploaded_at is None or row.content is None:
        raise UploadError(409, NOT_UPLOADED_DETAIL)
    return row


def text_of(row: Upload) -> str:
    """Содержимое как текст: инструменты MCP передают его бэкенду в JSON."""
    try:
        return (row.content or b"").decode("utf-8")
    except UnicodeDecodeError as exc:
        raise UploadError(422, NOT_TEXT_DETAIL) from exc
