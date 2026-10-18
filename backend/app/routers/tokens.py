"""Личные токены доступа: /api/v1/tokens (docs/plan-remote-mcp.md, Р4).

Выпустить, посмотреть свои и отозвать можно только из сессии интерфейса
(require_session_user): утёкшим токеном нельзя выпустить себе новый. /current —
наоборот, только по токену: по нему эндпоинт /mcp узнаёт владельца и вид токена.
«Только чтение» в ответах — действующее (personal_tokens.read_only_for): у «Пользователя»
оно у любого токена.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app import demo, personal_tokens
from app.auth import get_current_user, personal_token_of, require_session_user
from app.config import settings
from app.database import get_db
from app.models.personal_token import PersonalToken
from app.models.user import User
from app.schemas.personal_token import (
    PersonalTokenCreate,
    PersonalTokenCreated,
    PersonalTokenCurrent,
    PersonalTokenOut,
)

router = APIRouter(prefix="/tokens", tags=["tokens"])

NOT_FOUND_DETAIL = "Токен не найден"
SESSION_REQUEST_DETAIL = "Запрос пришёл не по личному токену"


def _deny_demo(user: User) -> None:
    """На демо-стенде токенов нет (Р8): ни выпуска, ни списка."""
    if settings.demo_mode:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=personal_tokens.DEMO_DETAIL)
    demo.deny_guest(user)


def _out(row: PersonalToken, user: User) -> PersonalTokenOut:
    out = PersonalTokenOut.model_validate(row)
    return out.model_copy(update={"read_only": personal_tokens.read_only_for(row, user)})


@router.get("", response_model=list[PersonalTokenOut])
def list_tokens(
    db: Session = Depends(get_db),
    user: User = Depends(require_session_user),
) -> list[PersonalTokenOut]:
    """Свои токены, новые сверху. Секретов здесь нет: их показывают один раз."""
    _deny_demo(user)
    rows = (
        db.query(PersonalToken)
        .filter(PersonalToken.user_id == user.id)
        .order_by(PersonalToken.created_at.desc())
        .all()
    )
    return [_out(row, user) for row in rows]


@router.post("", response_model=PersonalTokenCreated, status_code=status.HTTP_201_CREATED)
def create_token(
    payload: PersonalTokenCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_session_user),
) -> PersonalTokenCreated:
    """Выпустить токен. 409 — имя уже занято или токенов слишком много; 403 —
    «Пользователь» просит токен не только для чтения."""
    _deny_demo(user)
    try:
        issued = personal_tokens.issue(db, user, payload.name, payload.read_only, payload.lifetime_days)
    except personal_tokens.TokenForbidden as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=exc.detail) from None
    except personal_tokens.TokenError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=exc.detail) from None
    db.commit()
    db.refresh(issued.token)
    return PersonalTokenCreated(token=_out(issued.token, user), secret=issued.secret)


@router.get("/current", response_model=PersonalTokenCurrent)
def current_token(request: Request, user: User = Depends(get_current_user)) -> PersonalTokenCurrent:
    """Кто владелец токена, которым пришёл запрос. По сессии интерфейса — 404."""
    row = personal_token_of(request)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=SESSION_REQUEST_DETAIL)
    return PersonalTokenCurrent(
        id=row.id,
        name=row.name,
        prefix=row.prefix,
        read_only=personal_tokens.read_only_for(row, user),
        username=user.username,
    )


@router.delete("/{token_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_token(
    token_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(require_session_user),
) -> None:
    """Отозвать свой токен: строка удаляется, следующий запрос им — 401. Чужой — 404:
    существование чужих токенов не выдаём."""
    _deny_demo(user)
    row = db.get(PersonalToken, token_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND_DETAIL)
    db.delete(row)
    db.commit()
