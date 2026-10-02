"""Демо-режим публичного стенда (docs/tasks/demo-mode.md).

Режим, а не форк: включается настройкой DEMO_MODE=true. На стенде нет входа по
логину и регистрации. Посетитель жмёт «Попробовать без регистрации», и для него
заводится временный гость с личной песочницей: копией демо-проекта «Ярмарка»,
владелец которой сам гость. Гость правит её как угодно и может завести ещё один
свой проект любым способом окна «Новый проект». Песочница живёт сутки
бездействия, потом уборка удаляет гостя вместе с его проектами.

Здесь собрано всё, что нужно режиму без HTTP: пределы стенда, заведение гостя,
уборка и сводка для серверных команд. Отказы в HTTP-виде — в роутерах.
"""

import asyncio
import logging
import secrets
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.auth import GUEST_CLAIM, create_access_token, hash_password
from app.demo_package import DEMO_PACKAGE, seed_package_template
from app.models.project import Project
from app.models.project_member import ProjectMember
from app.models.user import User

log = logging.getLogger(__name__)

# ── Пределы демо-стенда ─────────────────────────────────────────────────────
# Пределы ПРОЕКТА: проверяются после каждой записи (центральная проверка ниже).
MAX_NODES = 100
MAX_EDGES = 120
MAX_DOCS = 75
MAX_PROCESSES = 10
# Объём текста проекта и размер загружаемого файла: в байтах (1 КБ = 1024 байта).
MAX_TEXT_BYTES = 250 * 1024
MAX_FILE_BYTES = 250 * 1024
# Сколько проектов гость может держать своими, включая архивные.
MAX_GUEST_PROJECTS = 2

# Сколько живёт песочница без активности гостя.
SANDBOX_IDLE = timedelta(hours=24)
# Срок токена гостя: заметно дольше суток, чтобы гость возвращался в песочницу, пока
# она жива. Реально песочницу держит last_active_at, а не токен.
GUEST_TOKEN_MINUTES = 60 * 24 * 30
# Как часто приложение в демо-режиме убирает просроченные песочницы.
CLEANUP_EVERY_SECONDS = 10 * 60

# Демо-проект в песочнице гостя: имя и описание карточки.
SANDBOX_PROJECT_NAME = "Маркетплейс «Ярмарка»"
SANDBOX_PROJECT_DESCRIPTION = (
    "Демо-проект: C4, схемы логики, БД, брокеры, конфигурация, спеки и бизнес-процессы."
)

# ── Тексты отказов ──────────────────────────────────────────────────────────
TOO_MANY_DETAIL = "На демо сейчас слишком много пользователей. Попробуйте через час."
LOGIN_OFF_DETAIL = (
    "На демо-стенде вход по логину отключён. Нажмите «Попробовать без регистрации»."
)
SIGNUP_OFF_DETAIL = "На демо-стенде регистрация отключена"
GUEST_FORBIDDEN_DETAIL = "В песочнице это недоступно"
GUEST_PROJECTS_DETAIL = (
    "В демо можно создать один свой проект. Удалите его, чтобы создать другой."
)


# ── Гость и его права ───────────────────────────────────────────────────────


def deny_guest(user: User) -> None:
    """403 гостю на действие, которое в песочнице выключено (участники, видимость,
    смена пароля, список пользователей). Бэк закрывает их сам, даже если фронт
    кнопку не показал."""
    if user.is_guest:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=GUEST_FORBIDDEN_DETAIL)


def owned_projects_count(db: Session, user_id: uuid.UUID) -> int:
    """Сколько проектов пользователь держит владельцем, включая архивные."""
    return (
        db.query(func.count(ProjectMember.project_id))
        .filter(ProjectMember.user_id == user_id, ProjectMember.role == "owner")
        .scalar()
        or 0
    )


def can_create_project(db: Session, user: User) -> bool:
    """Может ли пользователь создать ещё один проект: глобальная роль architect, а
    гостю ещё и предел своих проектов."""
    if user.role != "architect":
        return False
    return not user.is_guest or owned_projects_count(db, user.id) < MAX_GUEST_PROJECTS


def check_guest_can_create(db: Session, user: User) -> None:
    """409 с подсказкой, если гость уже держит предельное число проектов. Вызывается
    в ручках, где рождается проект: пустой, копия, ввоз файлов."""
    if user.is_guest and owned_projects_count(db, user.id) >= MAX_GUEST_PROJECTS:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=GUEST_PROJECTS_DETAIL)


def live_sandboxes(db: Session) -> int:
    """Сколько песочниц живёт сейчас: каждая песочница — это гость."""
    return db.query(func.count(User.id)).filter(User.is_guest.is_(True)).scalar() or 0


def _guest_username(db: Session) -> str:
    """Логин гостя вида guest-<8 hex>. Совпадение почти невозможно, но проверяем."""
    for _ in range(10):
        name = f"guest-{secrets.token_hex(4)}"
        if db.query(User.id).filter(User.username == name).first() is None:
            return name
    raise RuntimeError("Не удалось подобрать свободный логин гостя")


def create_sandbox(db: Session) -> User:
    """Завести гостя и посеять ему копию демо-проекта. Коммитит сам: песочница
    появляется целиком или не появляется вовсе."""
    now = datetime.now(UTC)
    guest = User(
        id=uuid.uuid4(),
        username=_guest_username(db),
        # Пароль случайный и нигде не показывается: войти по нему нельзя и незачем.
        hashed_password=hash_password(secrets.token_urlsafe(24)),
        role="architect",  # нужна, чтобы гость мог создавать проекты
        is_admin=False,
        is_active=True,
        is_guest=True,
        last_active_at=now,
        created_at=now,
    )
    db.add(guest)
    db.flush()
    project = seed_package_template(
        db, DEMO_PACKAGE, SANDBOX_PROJECT_NAME, SANDBOX_PROJECT_DESCRIPTION, guest.id
    )
    if project is None:  # пакет известен всегда; страховка от опечатки в id
        raise RuntimeError("Демо-пакет не найден")
    db.commit()
    return guest


def guest_token(guest: User) -> str:
    """Токен гостя: как у логина, плюс признак гостя и длинный срок."""
    return create_access_token(
        {"sub": guest.username, "role": guest.role, GUEST_CLAIM: True},
        expire_minutes=GUEST_TOKEN_MINUTES,
    )


class StartLimiter:
    """Сколько песочниц завели с одного адреса за последний час. Счётчик в памяти
    процесса: стенд один, а после перезапуска забыть историю не страшно."""

    WINDOW_SECONDS = 3600.0

    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def _fresh(self, ip: str, now: float) -> deque[float]:
        hits = self._hits.setdefault(ip, deque())
        while hits and now - hits[0] >= self.WINDOW_SECONDS:
            hits.popleft()
        return hits

    def allowed(self, ip: str, per_hour: int, now: float | None = None) -> bool:
        moment = time.monotonic() if now is None else now
        with self._lock:
            return len(self._fresh(ip, moment)) < per_hour

    def record(self, ip: str, now: float | None = None) -> None:
        moment = time.monotonic() if now is None else now
        with self._lock:
            self._fresh(ip, moment).append(moment)

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


start_limiter = StartLimiter()


# ── Уборка ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class CleanupReport:
    guests: int
    projects: int


def _expired_guests(db: Session, cutoff: datetime) -> list[User]:
    """Гости, чья последняя активность (или создание, если активности не было)
    старше cutoff."""
    last_seen = func.coalesce(User.last_active_at, User.created_at)
    return (
        db.query(User)
        .filter(User.is_guest.is_(True), last_seen < cutoff)
        .order_by(User.username)
        .all()
    )


def cleanup_sandboxes(
    db: Session, now: datetime | None = None, idle: timedelta = SANDBOX_IDLE
) -> CleanupReport:
    """Удалить просроченные песочницы: сначала проекты гостя (схема уходит БД-каскадом),
    потом саму учётку. Обычных пользователей не трогает никогда: выборка только по
    is_guest. Каждый гость — своя транзакция, сбой одного не держит остальных."""
    cutoff = (now or datetime.now(UTC)) - idle
    guests = projects = 0
    for guest in _expired_guests(db, cutoff):
        owned_ids = [
            pid
            for (pid,) in db.query(ProjectMember.project_id).filter(
                ProjectMember.user_id == guest.id, ProjectMember.role == "owner"
            )
        ]
        for project in db.query(Project).filter(Project.id.in_(owned_ids)).all():
            db.delete(project)
            projects += 1
        db.flush()
        db.delete(guest)
        db.commit()
        guests += 1
    return CleanupReport(guests=guests, projects=projects)


@dataclass(frozen=True)
class SandboxRow:
    username: str
    created_at: datetime
    last_active_at: datetime | None
    projects: int


@dataclass(frozen=True)
class SandboxStats:
    sandboxes: int
    projects: int
    oldest: list[SandboxRow]


def sandbox_stats(db: Session, top: int = 5) -> SandboxStats:
    """Сводка для серверной команды: живые песочницы, проекты гостей и те, кто дольше
    всех без активности (их уборка снимет первыми)."""
    owned: dict[uuid.UUID, int] = {
        uid: cnt
        for uid, cnt in (
            db.query(ProjectMember.user_id, func.count(ProjectMember.project_id))
            .join(User, User.id == ProjectMember.user_id)
            .filter(User.is_guest.is_(True), ProjectMember.role == "owner")
            .group_by(ProjectMember.user_id)
            .all()
        )
    }
    last_seen = func.coalesce(User.last_active_at, User.created_at)
    oldest = (
        db.query(User).filter(User.is_guest.is_(True)).order_by(last_seen, User.username).limit(top)
    )
    return SandboxStats(
        sandboxes=live_sandboxes(db),
        projects=sum(owned.values()),
        oldest=[
            SandboxRow(
                username=g.username,
                created_at=g.created_at,
                last_active_at=g.last_active_at,
                projects=owned.get(g.id, 0),
            )
            for g in oldest
        ],
    )


def _cleanup_once() -> None:
    """Один прогон уборки в своей сессии БД (для фоновой задачи)."""
    from app.database import SessionLocal

    with SessionLocal() as db:
        report = cleanup_sandboxes(db)
    if report.guests:
        log.info("Демо: убрано песочниц %d, проектов %d", report.guests, report.projects)


async def cleanup_loop(every_seconds: float = CLEANUP_EVERY_SECONDS) -> None:
    """Фоновая уборка песочниц раз в every_seconds, пока живо приложение. Ошибка
    прогона пишется в лог и не останавливает цикл."""
    while True:
        try:
            await asyncio.to_thread(_cleanup_once)
        except Exception:  # фоновая задача не должна умирать от одного сбоя
            log.exception("Демо: уборка песочниц не удалась")
        await asyncio.sleep(every_seconds)
