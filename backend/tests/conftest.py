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

# Импортируем все модели, чтобы они зарегистрировались в Base.metadata до create_all.
from app.models.node import Node  # noqa: F401
from app.models.edge import Edge  # noqa: F401
from app.models.ghost_position import GhostPosition  # noqa: F401
from app.models.ghost_edge_handle import GhostEdgeHandle  # noqa: F401
from app.models.user import User  # noqa: F401


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
