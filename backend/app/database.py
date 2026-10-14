from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app import column_limits
from app.config import settings

# pool_pre_ping: соединение из пула проверяется перед выдачей — после простоя или
# рестарта базы первый запрос на каждом протухшем соединении иначе был бы 500 (аудит S6).
# pool_recycle: соединения старше получаса пересоздаются, не дожидаясь, пока их оборвёт
# сеть или балансировщик.
engine = create_engine(settings.database_url, pool_pre_ping=True, pool_recycle=1800)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Значение длиннее String(n) — 422 до записи, а не DataError (500) на Postgres.
column_limits.install()


class Base(DeclarativeBase):
    pass


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
