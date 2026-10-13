"""Резервная копия базы перед миграциями ArchMap (аудит P-3).

Установщик запускает её с окружением из archmap.env (runenv.py) от имени пользователя
службы — тем же входом в базу, что миграции. Копия нужна, только если миграции что-то
поменяют: на первой установке базы ArchMap ещё нет, при актуальной схеме менять нечего.

    python3 backup.py КАТАЛОГ_КОПИЙ ПУТЬ_К_alembic.ini ВЕРСИЯ

Копия — `pg_dump -Fc`, файл с правами 600 в каталоге 700 (в нём хэши паролей); хранятся
последние KEEP копий. Пароль базы уходит в pg_dump через окружение, не в командную
строку (её видно всем в списке процессов). Код выхода 1 останавливает установку.
"""

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import unquote, urlsplit, urlunsplit

import psycopg2
from alembic.config import Config
from alembic.script import ScriptDirectory

KEEP = 5


def fail(message: str) -> None:
    print(f"КОПИЯ БАЗЫ: {message}", file=sys.stderr)
    sys.exit(1)


def schema_state(dsn: str) -> str | None:
    """Версия схемы в базе; None — базы ArchMap ещё нет (первая установка)."""
    try:
        conn = psycopg2.connect(dsn, connect_timeout=10)
    except psycopg2.Error as e:
        fail(f"не удалось подключиться: {str(e).strip()}")
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT to_regclass('public.alembic_version') IS NOT NULL")
            if not cur.fetchone()[0]:
                return None
            cur.execute("SELECT version_num FROM alembic_version")
            row = cur.fetchone()
    finally:
        conn.close()
    return row[0] if row else ""


def dump(dsn: str, target: Path) -> None:
    """pg_dump в target через временный файл: недописанная копия не выглядит готовой."""
    pg_dump = shutil.which("pg_dump")
    if pg_dump is None:
        fail(
            "нет pg_dump. Поставьте клиент PostgreSQL той же или более новой версии, что "
            "сервер базы (пакет postgresql-client), или сделайте копию сами и запустите "
            "установку с --no-backup"
        )
    parts = urlsplit(dsn)
    env = dict(os.environ)
    if parts.password is not None:
        env["PGPASSWORD"] = unquote(parts.password)
    host = parts.hostname or ""
    if ":" in host:
        host = f"[{host}]"  # IPv6: urlsplit снимает скобки
    if parts.port:
        host = f"{host}:{parts.port}"
    user = f"{parts.username}@" if parts.username else ""
    bare = urlunsplit((parts.scheme, f"{user}{host}", parts.path, parts.query, ""))
    partial = target.with_name(target.name + ".part")
    run = subprocess.run(
        [pg_dump, "-Fc", f"--dbname={bare}", f"--file={partial}"],
        env=env,
        capture_output=True,
        text=True,
    )
    if run.returncode != 0:
        partial.unlink(missing_ok=True)
        fail(f"pg_dump не справился: {run.stderr.strip()}")
    partial.rename(target)


def prune(backup_dir: Path) -> None:
    copies = sorted(backup_dir.glob("archmap-*.dump"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in copies[KEEP:]:
        old.unlink()


def main(argv: list[str]) -> None:
    if len(argv) != 4:
        sys.exit("использование: backup.py КАТАЛОГ_КОПИЙ ПУТЬ_К_alembic.ini ВЕРСИЯ")
    backup_dir, ini, version = Path(argv[1]), argv[2], argv[3]
    url = os.environ.get("DATABASE_URL", "")
    if not url:
        fail("DATABASE_URL не задан")
    dsn = url.replace("postgresql+psycopg2://", "postgresql://", 1)

    current = schema_state(dsn)
    if current is None:
        print("КОПИЯ БАЗЫ: первая установка — копировать нечего")
        return
    head = ScriptDirectory.from_config(Config(ini)).get_current_head()
    if current == head:
        print("КОПИЯ БАЗЫ: схема актуальна, миграции ничего не изменят — копия не нужна")
        return

    os.umask(0o077)
    backup_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = backup_dir / f"archmap-{time.strftime('%Y%m%d-%H%M%S')}-before-{version}.dump"
    dump(dsn, target)
    prune(backup_dir)
    size_mb = target.stat().st_size / 1024 / 1024
    print(f"КОПИЯ БАЗЫ: {target} ({size_mb:.1f} МБ), схема {current or '—'} → {head}")


if __name__ == "__main__":
    main(sys.argv)
