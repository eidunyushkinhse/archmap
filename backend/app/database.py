from sqlalchemy import create_engine
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings

engine = create_engine(settings.database_url)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def upsert(db: Session, model, keys: dict, values: dict) -> None:
    """INSERT … ON CONFLICT(keys) DO UPDATE SET values — одним стейтментом.

    keys должны точно совпадать с колонками UniqueConstraint модели. Атомарно
    (нет гонки select-then-write) и за один round-trip. Прод — Postgres, тесты —
    SQLite, поэтому диалект выбираем по подключению.

    NB: Core-insert минует identity map ORM — после него не читать те же строки
    той же сессией без expire (вызывающие эндпоинты отдают 204, чтений нет).
    """
    dialect = db.get_bind().dialect.name
    if dialect == "postgresql":
        ins = postgresql.insert(model)
    elif dialect == "sqlite":
        ins = sqlite.insert(model)
    else:
        raise NotImplementedError(f"upsert: диалект {dialect} не поддержан")
    db.execute(
        ins.values(**keys, **values).on_conflict_do_update(
            index_elements=list(keys), set_=values
        )
    )
