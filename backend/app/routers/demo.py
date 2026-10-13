"""Вход в демо-стенд: POST /api/v1/demo/start (docs/tasks/demo-mode.md).

Без авторизации и только в демо-режиме (иначе 404: ручки как будто нет). Заводит
гостя с песочницей и отдаёт токен, как логин. Отказ при переполнении стенда или
частых стартах с одного адреса — 429 с текстом для экрана входа.
"""

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app import demo
from app.config import settings
from app.database import get_db
from app.rate_limit import client_address
from app.schemas.auth import Token

router = APIRouter(prefix="/demo", tags=["demo"])


@router.post("/start", response_model=Token)
def start_sandbox(request: Request, db: Session = Depends(get_db)) -> Token:
    """Завести песочницу: гость + его копия демо-проекта.

    Адрес — последний в X-Forwarded-For (его дописывает nginx или роутер OpenShift,
    подделать его клиент не может), см. rate_limit.client_address."""
    if not settings.demo_mode:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not Found")
    ip = client_address(request.scope)
    if (
        not demo.start_limiter.allowed(ip, settings.demo_start_per_ip_per_hour)
        or demo.live_sandboxes(db) >= settings.demo_max_sandboxes
    ):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=demo.TOO_MANY_DETAIL
        )
    guest = demo.create_sandbox(db)
    # Старт засчитывается адресу только удачный: отказ стенда попытку не съедает.
    demo.start_limiter.record(ip)
    return Token(access_token=demo.guest_token(guest))
