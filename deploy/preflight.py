"""Проверка базы перед миграциями ArchMap: подключение, версия PostgreSQL, кодировка,
права пользователя. Установщик запускает её с окружением из archmap.env; код выхода
1 останавливает установку с объяснением, что поправить на стороне базы."""

import os
import sys

import psycopg2

MIN_SERVER_VERSION = 150000  # UNIQUE … NULLS NOT DISTINCT в миграциях — с PostgreSQL 15


def fail(message: str) -> None:
    print(f"БАЗА: {message}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    url = os.environ.get("DATABASE_URL", "")
    if not url:
        fail("DATABASE_URL не задан")
    # SQLAlchemy-форма с драйвером libpq не понимает
    dsn = url.replace("postgresql+psycopg2://", "postgresql://", 1)
    try:
        conn = psycopg2.connect(dsn, connect_timeout=10)
    except psycopg2.Error as e:
        fail(f"не удалось подключиться: {str(e).strip()}")
    with conn, conn.cursor() as cur:
        cur.execute("SELECT current_setting('server_version_num')::int, current_setting('server_version')")
        num, version = cur.fetchone()
        if num < MIN_SERVER_VERSION:
            fail(f"нужен PostgreSQL 15 или новее, у сервера {version}")
        cur.execute(
            "SELECT current_user, current_database(), pg_encoding_to_char(encoding),"
            " has_schema_privilege(current_user, 'public', 'CREATE')"
            " FROM pg_database WHERE datname = current_database()"
        )
        user, db, encoding, can_create = cur.fetchone()
        if encoding != "UTF8":
            fail(
                f"база {db} в кодировке {encoding}, нужна UTF8: "
                f"CREATE DATABASE {db} OWNER {user} ENCODING 'UTF8' TEMPLATE template0"
            )
        if not can_create:
            fail(
                f"у пользователя {user} нет права создавать таблицы в схеме public базы {db}: "
                f"ALTER DATABASE {db} OWNER TO {user} (или GRANT CREATE ON SCHEMA public TO {user})"
            )
        cur.execute("SELECT to_regclass('public.alembic_version') IS NOT NULL")
        if cur.fetchone()[0]:
            cur.execute("SELECT version_num FROM alembic_version")
            row = cur.fetchone()
            state = f"обновление со схемы {row[0] if row else '—'}"
        else:
            cur.execute("SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
            if cur.fetchone()[0]:
                fail(f"в схеме public базы {db} есть чужие таблицы: ArchMap нужна отдельная пустая база")
            state = "первая установка, база пуста"
    conn.close()
    print(f"БАЗА: PostgreSQL {version}, база {db}, пользователь {user}: {state}")


if __name__ == "__main__":
    main()
