"""Загрузка файла с машины агента по одноразовой ссылке: /api/v1/uploads
(app/uploads.py, docs/plan-mcp-upload.md).

POST — ссылка (владелец: токен или сессия); PUT по ссылке — без аутентификации, право
даёт сам ключ в пути (случайный, 256 бит, в БД хэш), ссылка одноразовая, срок 10 минут;
GET — принятый файл владельцу (инструменты MCP). Тело PUT читается потоком с потолком
UPLOAD_MAX_MB: сверх него — 413 до того, как файл окажется в памяти целиком.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app import demo, uploads
from app.auth import get_current_user
from app.config import settings
from app.database import get_db
from app.models.user import User
from app.rate_limit import AddressLimiter, client_address
from app.schemas.upload import UploadCreate, UploadOut, UploadReceivedOut, UploadSlotOut

router = APIRouter(prefix="/uploads", tags=["uploads"])

# Неудачные PUT с адреса в минуту: ключ не подобрать, но и шуметь незачем.
PUT_FAILURES_PER_MINUTE = 30
LIMITED_DETAIL = "Слишком много неудачных попыток — подождите минуту"
put_failures = AddressLimiter(window_seconds=60)


def _deny_demo() -> None:
    if settings.demo_mode:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=uploads.DEMO_DETAIL)


def _http(exc: uploads.UploadError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=exc.detail)


async def _read_body(request: Request, limit: int) -> bytes:
    """Тело потоком с потолком: объявленная длина сверх предела — отказ сразу, иначе
    по кускам до первого превышения."""
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > limit:
        raise HTTPException(status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail=uploads.too_large_detail())
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail=uploads.too_large_detail()
            )
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("", response_model=UploadSlotOut, status_code=status.HTTP_201_CREATED)
def create_upload(
    payload: UploadCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> UploadSlotOut:
    """Одноразовая ссылка на загрузку одного файла. Ключ в пути — один раз, здесь."""
    _deny_demo()
    demo.deny_guest(user)
    try:
        row, key = uploads.create(db, user, payload.name)
    except uploads.UploadError as exc:
        raise _http(exc) from exc
    db.commit()
    return UploadSlotOut(
        id=row.id,
        name=row.name,
        path=f"/api/v1/uploads/{row.id}/{key}",
        expires_at=row.expires_at,
        max_bytes=uploads.max_bytes(),
    )


@router.put("/{upload_id}/{key}", response_model=UploadReceivedOut)
async def receive_upload(
    upload_id: uuid.UUID,
    key: str,
    request: Request,
    db: Session = Depends(get_db),
) -> UploadReceivedOut:
    """Приём файла по ссылке: тело запроса — файл как есть (curl -T файл ссылка)."""
    _deny_demo()
    address = client_address(request.scope)
    if not put_failures.allowed(address, PUT_FAILURES_PER_MINUTE):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=LIMITED_DETAIL)
    try:
        row = uploads.for_link(db, upload_id, key)
    except uploads.UploadError as exc:
        put_failures.record(address)
        raise _http(exc) from exc
    data = await _read_body(request, uploads.max_bytes())
    try:
        uploads.receive(db, row, data)
    except uploads.UploadError as exc:
        raise _http(exc) from exc
    db.commit()
    return UploadReceivedOut(upload_id=row.id, name=row.name, size=row.size, sha256=row.sha256 or "")


@router.get("/{upload_id}", response_model=UploadOut)
def read_upload(
    upload_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> UploadOut:
    """Принятый файл владельцу — текстом, для инструментов MCP. Читается, пока жив."""
    _deny_demo()
    try:
        row = uploads.owned(db, user, upload_id)
        text = uploads.text_of(row)
    except uploads.UploadError as exc:
        raise _http(exc) from exc
    return UploadOut(id=row.id, name=row.name, size=row.size, sha256=row.sha256 or "", content=text)
