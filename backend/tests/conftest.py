"""Фикстуры для бэкенд-тестов.

Тесты гоняем на in-memory SQLite (а не на Postgres) — модели используют generic
SQLAlchemy-тип Uuid, переносимый на SQLite, поэтому внешняя БД не нужна. Это
делает страховочную сетку (REFACTOR_PLAN.md, Фаза 1) самодостаточной и годной
для будущего CI-гейта (Фаза 5). Каждый тест получает свежую БД с включённым
контролем внешних ключей.
"""

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models.broker_channel import BrokerChannel  # noqa: F401
from app.models.business_process import BusinessProcess  # noqa: F401
from app.models.channel_field import ChannelField  # noqa: F401
from app.models.config_param import ConfigParam  # noqa: F401
from app.models.db_column import DbColumn  # noqa: F401
from app.models.db_table import DbTable  # noqa: F401
from app.models.edge import Edge  # noqa: F401

# Импортируем все модели, чтобы они зарегистрировались в Base.metadata до create_all.
from app.models.node import Node  # noqa: F401
from app.models.node_doc import NodeDoc  # noqa: F401
from app.models.process_fragment import ProcessFragment  # noqa: F401
from app.models.process_message import ProcessMessage  # noqa: F401
from app.models.process_participant import ProcessParticipant  # noqa: F401
from app.models.project import Project
from app.models.user import User  # noqa: F401
from app.models.view_layout import ViewLayoutItem  # noqa: F401
from app.models.view_state import ViewState  # noqa: F401


@pytest.fixture()
def db():
    # Единое соединение через StaticPool: in-memory SQLite живёт только пока открыто
    # соединение, а пул иначе раздавал бы разные пустые БД на каждый чек-аут.
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    # SQLite по умолчанию не проверяет FK — включаем, чтобы каскады/ссылки вели себя
    # как на Postgres.
    @event.listens_for(engine, "connect")
    def _fk_on(dbapi_conn, _rec):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)
        engine.dispose()


@pytest.fixture()
def project(db):
    """Проект-владелец для доменных строк теста (project_id у Node/Edge/процессов
    теперь NOT NULL). Фабрики узлов/связей в тестах берут project.id отсюда."""
    return ensure_project(db)


# ── Хелперы для тестов (импортируются как `from conftest import ...`) ──────────
def ensure_project(db) -> Project:
    """Лениво создаёт/возвращает единственный проект-владелец доменных строк.
    project_id у Node/Edge/BusinessProcess теперь NOT NULL — фабрики тестов берут
    его отсюда, не меняя сигнатуры самих тестов."""
    import uuid

    p = db.query(Project).first()
    if p is None:
        p = Project(id=uuid.uuid4(), name="Тестовый проект")
        db.add(p)
        db.flush()
    return p


def ensure_architect(db) -> User:
    """Лениво создаёт/возвращает architect-пользователя. Нужен мутациям роутеров,
    вызываемым напрямую: touch_project читает user.id (в проде это require_architect)."""
    import uuid

    u = db.query(User).filter(User.role == "architect").first()
    if u is None:
        u = User(id=uuid.uuid4(), username="arch", hashed_password="x", role="architect")
        db.add(u)
        db.flush()
    return u


def seed_project_from_yaml(db, texts: list[str], name: str = "Из репозитория") -> Project:
    """Проект со схемой из YAML-текстов — ровно то, что делал снесённый 2026-09-05
    путь start="import": parse_and_merge + seed_import (те же функции, что звал
    роутер). Живой ввоз файлов идёт единым путём (/projects/import-unified), а
    тестам синка/импорта нужна лишь дешёвая заготовка схемы без multipart."""
    import uuid

    from app.import_merge import parse_and_merge
    from app.import_yaml import seed_import

    merged, _report, errors = parse_and_merge(texts)
    assert merged is not None, errors
    p = Project(id=uuid.uuid4(), name=name)
    db.add(p)
    db.flush()
    seed_import(db, p.id, merged)
    db.commit()
    return p
