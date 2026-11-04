"""Диалект базы по признакам миграций (ТЗ §7, пункт 3 цепочки «база для миграций»).

Когда базы в манифестах нет (Sentry, Zulip: база живёт в другом репозитории), объект-база
строится по тому, что видно рядом с миграциями: ENGINE в настройках Django, адрес в
alembic.ini или env.py, типы колонок в SQL. Регулярные выражения начинаются с литерала или
границы слова и не перебирают с возвратами: файлы чужие и бывают враждебными.
"""

from __future__ import annotations

import re

POSTGRESQL = "PostgreSQL"
MYSQL = "MySQL"
MARIADB = "MariaDB"
SQLITE = "SQLite"
ORACLE = "Oracle"
SQLSERVER = "SQL Server"

# Подстрока в ENGINE Django или схема адреса SQLAlchemy → диалект. Порядок важен:
# postgis раньше postgres, mariadb раньше mysql.
_NAMES: tuple[tuple[str, str], ...] = (
    ("postgis", POSTGRESQL), ("postgres", POSTGRESQL), ("psycopg", POSTGRESQL),
    ("mariadb", MARIADB), ("mysql", MYSQL), ("sqlite", SQLITE), ("oracle", ORACLE),
    ("mssql", SQLSERVER),
)

_ENGINE = re.compile(r"[\"']ENGINE[\"']\s*:\s*[\"']([^\"'\n]{1,200})[\"']")
_URL = re.compile(
    r"\b(postgresql|postgres|mysql|mariadb|sqlite|oracle|mssql)(?:\+[A-Za-z0-9_]{1,40})?://",
    re.IGNORECASE,
)
_INI_URL = re.compile(r"^[ \t]*sqlalchemy\.url[ \t]*=[ \t]*([^\s#;]{1,500})", re.MULTILINE)
_SQL_PG = re.compile(r"\b(BIGSERIAL|SMALLSERIAL|SERIAL|JSONB|TIMESTAMPTZ)\b", re.IGNORECASE)
_SQL_MY = re.compile(r"\bAUTO_INCREMENT\b|\bENGINE[ \t]*=[ \t]*InnoDB\b", re.IGNORECASE)


def by_name(text: str) -> str | None:
    """Диалект по имени движка или схеме адреса: «django.db.backends.postgresql»,
    «sentry.db.postgres», «mysql+pymysql» → PostgreSQL, PostgreSQL, MySQL."""
    low = text.lower()
    for key, dialect in _NAMES:
        if key in low:
            return dialect
    return None


def _line(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


def django_engine(text: str) -> tuple[str, int] | None:
    """Диалект и строка «ENGINE» в файле настроек Django. SQLite уступает другим движкам
    того же файла: обычно это настройки разработки и тестов."""
    found: list[tuple[str, int]] = []
    for m in _ENGINE.finditer(text):
        dialect = by_name(m.group(1))
        if dialect is not None:
            found.append((dialect, _line(text, m.start())))
    real = [f for f in found if f[0] != SQLITE]
    best = real or found
    return best[0] if best else None


def alembic_url(ini: str) -> tuple[str, int] | None:
    """Диалект и строка sqlalchemy.url в alembic.ini (подстановка %(…)s диалекта не даёт)."""
    for m in _INI_URL.finditer(ini):
        hit = _URL.match(m.group(1))
        if hit is not None:
            dialect = by_name(hit.group(1))
            if dialect is not None:
                return dialect, _line(ini, m.start())
    return None


def url_literal(text: str) -> tuple[str, int] | None:
    """Диалект первого адреса базы в тексте (env.py Alembic): «postgresql://…»."""
    m = _URL.search(text)
    if m is None:
        return None
    dialect = by_name(m.group(1))
    return (dialect, _line(text, m.start())) if dialect else None


def sql_types(text: str) -> tuple[str, int] | None:
    """Диалект по типам и опциям DDL: SERIAL, JSONB, TIMESTAMPTZ — PostgreSQL;
    AUTO_INCREMENT, ENGINE=InnoDB — MySQL. Побеждает признак, что встретился раньше."""
    pg = _SQL_PG.search(text)
    my = _SQL_MY.search(text)
    if pg is None and my is None:
        return None
    if my is None or (pg is not None and pg.start() < my.start()):
        assert pg is not None
        return POSTGRESQL, _line(text, pg.start())
    return MYSQL, _line(text, my.start())
