"""База для миграций без базы в манифестах (ТЗ §7, пункт 3; находка фазы 1а: Sentry 311 и
Zulip 93 таблицы ушли в hints.unassigned без колонок)."""

from __future__ import annotations

from pathlib import Path

import yaml

from archmap_scan import dialect, texts
from archmap_scan.scan import Options, run
from tests.helpers import FIXTURES, model_of, tree

DJANGO_MIGRATION = (
    "from django.db import migrations, models\n\n\n"
    "class Migration(migrations.Migration):\n"
    "    dependencies = []\n"
    "    operations = [\n"
    "        migrations.CreateModel(\n"
    '            name="Project",\n'
    '            fields=[("id", models.BigAutoField(primary_key=True))],\n'
    "        ),\n"
    "    ]\n"
)
ALEMBIC_REVISION = (
    "import sqlalchemy as sa\nfrom alembic import op\n\n"
    'revision = "a1"\ndown_revision = None\n\n\n'
    "def upgrade():\n"
    '    op.create_table("notes", sa.Column("id", sa.Integer(), primary_key=True))\n'
)


def test_django_engine_gives_postgresql(tmp_path: Path) -> None:
    tree(tmp_path, {
        "src/sentry/conf/server.py": (
            'DATABASES = {\n    "default": {\n        "ENGINE": "sentry.db.postgres",\n    }\n}\n'
        ),
        "src/sentry/conf/dev_settings.py": 'DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3"}}\n',
        "src/sentry/migrations/0001_initial.py": DJANGO_MIGRATION,
        "src/sentry/migrations/__init__.py": "",
        "Dockerfile": "FROM python:3.12\n",
        "pyproject.toml": '[project]\nname = "sentry"\ndependencies = ["django"]\n',
    })
    out = tmp_path / "out"
    run(Options(path=str(tmp_path), out=str(out), use_git=False))
    schema = yaml.safe_load((out / "schema.yaml").read_text(encoding="utf-8"))
    db = next(c for c in schema["nodes"][0]["children"] if c["shape"] == "database")
    assert db == {
        "name": "PostgreSQL", "shape": "database", "status": "existing", "role": "БД",
        "technology": "PostgreSQL",
    }
    # Владелец каталога миграций — единственный контейнер корня: связь «использует».
    # Контейнер — тёзка системы, поэтому назван путём.
    assert schema["edges"] == [{
        "from": "sentry / sentry", "to": "PostgreSQL", "label": "использует", "technology": "PostgreSQL",
    }]
    tables = yaml.safe_load((out / "facts" / "postgresql.tables.yaml").read_text(encoding="utf-8"))
    assert [t["name"] for t in tables["tables"]] == ["sentry_project"]
    hints = yaml.safe_load((out / "agent" / "hints.yaml").read_text(encoding="utf-8"))
    assert [h for h in hints["unassigned"] if h["kind"] == "table"] == []
    evidence = yaml.safe_load((out / "agent" / "evidence.yaml").read_text(encoding="utf-8"))
    assert evidence["nodes/sentry / PostgreSQL"] == ["src/sentry/conf/server.py:3"]
    coverage = yaml.safe_load((out / "coverage.yaml").read_text(encoding="utf-8"))
    assert coverage["families"]["databases"] == {
        "status": "covered", "found": 1, "parsers": ["django"],
        "notes": ["база определена по миграциям, не по манифесту"],
    }
    summary = (out / "summary.txt").read_text(encoding="utf-8")
    assert "1 таблица" in summary and "facts/*.tables.yaml" in summary


def test_alembic_dialects_and_unknown_sql(tmp_path: Path) -> None:
    tree(tmp_path, {
        "notes/alembic.ini": "[alembic]\nscript_location = db\nsqlalchemy.url = mysql+pymysql://u@h/x\n",
        "notes/db/env.py": "from alembic import context\n",
        "notes/db/versions/a1.py": ALEMBIC_REVISION,
        "tasks/db/env.py": 'URL = "postgresql+asyncpg://u@h/x"\n',
        "tasks/db/versions/a1.py": ALEMBIC_REVISION,
        "legacy/migrations/001.sql": "CREATE TABLE plain (id int);\n",
        "serial/migrations/001.sql": "CREATE TABLE s (id SERIAL PRIMARY KEY);\n",
    })
    model = model_of(tmp_path)
    dbs = {o.name: (o.technology, sorted(str(loc) for loc in o.locs)) for o in model.objects}
    assert dbs == {
        "MySQL": ("MySQL", ["notes/alembic.ini:3"]),
        "PostgreSQL": ("PostgreSQL", ["serial/migrations/001.sql:1", "tasks/db/env.py:1"]),
        "База данных": (None, ["legacy/migrations/001.sql:1"]),
    }
    assert sorted(t.name for t in model.tables["PostgreSQL"]) == ["notes", "s"]
    assert model.db_by_migrations and model.links == []
    assert model.hints.get("unassigned", []) == []


def test_dialect_helpers() -> None:
    assert dialect.by_name("django.contrib.gis.db.backends.postgis") == "PostgreSQL"
    assert dialect.by_name("mariadb") == "MariaDB" and dialect.by_name("x") is None
    assert dialect.django_engine('"ENGINE": "x.sqlite3"\n"ENGINE": "y.mysql"\n') == ("MySQL", 2)
    assert dialect.django_engine('"ENGINE": "x.sqlite3"\n') == ("SQLite", 1)
    assert dialect.django_engine("ENGINE = 1\n") is None
    assert dialect.alembic_url("sqlalchemy.url = %(DB_URL)s\n") is None
    assert dialect.url_literal("no url") is None
    assert dialect.sql_types("CREATE TABLE t (id int AUTO_INCREMENT) ENGINE=InnoDB;") == ("MySQL", 1)
    assert dialect.sql_types("a JSONB\nb AUTO_INCREMENT") == ("PostgreSQL", 1)
    assert dialect.sql_types("int") is None


def test_dialect_hostile_in_time() -> None:
    import time

    payloads = ("SERIA" * 400_000, '"ENGINE": "' + "a" * 2_000_000, "postgresql+" * 200_000,
                "sqlalchemy.url = " + "x" * 2_000_000)
    for text in payloads:
        started = time.perf_counter()
        dialect.sql_types(text)
        dialect.django_engine(text)
        dialect.url_literal(text)
        dialect.alembic_url(text)
        assert time.perf_counter() - started < 1.0


def test_sqlite_as_settings_default(tmp_path: Path) -> None:
    """SQLite из настроек Django как значение по умолчанию (ТЗ §15 п. 12 С9). AWX:
    awx/settings/defaults.py:24 задаёт ENGINE sqlite3 и давал базу SQLite, хотя AWX живёт на
    PostgreSQL: awx/settings/production_defaults.py сбрасывает DATABASES = {}, боевая база
    задаётся при запуске. Тогда вид базы не берётся («База данных») и пишется подсказка.
    Ловушка django-sqlite-only: модуль рядом DATABASES не трогает, sqlite единственный и
    остаётся базой SQLite. Случай судьи «база другого вида задана манифестом»: таблицы у
    PostgreSQL из compose, sqlite3 только подсказкой."""
    model = model_of(FIXTURES / "django-sqlite-default")
    dbs = {o.name: o.technology for o in model.objects if o.shape == "database"}
    assert dbs == {"База данных": None}
    assert [t.name for t in model.tables["База данных"]] == ["main_job"]
    hint = {
        "kind": "database", "name": "SQLite", "reason": texts.REASON_SQLITE_DEFAULT,
        "source": "awx/settings/defaults.py:7",
    }
    assert [h for h in model.hints["unassigned"] if h["kind"] == "database"] == [hint]
    model = model_of(FIXTURES / "django-sqlite-only")
    assert {o.name: o.technology for o in model.objects if o.shape == "database"} == {
        "SQLite": "SQLite",
    }
    assert [h for h in model.hints.get("unassigned", []) if h["kind"] == "database"] == []
    tree(tmp_path, {
        "app/settings.py": 'DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3"}}\n',
        "app/main/migrations/0001_initial.py": DJANGO_MIGRATION,
        "app/main/migrations/__init__.py": "",
        "docker-compose.yml": "services:\n  web:\n    build: .\n  db:\n    image: postgres:16\n",
        "Dockerfile": "FROM python:3.12\n",
    })
    model = model_of(tmp_path)
    assert {o.name: o.technology for o in model.objects if o.shape == "database"} == {
        "db": "PostgreSQL",
    }
    assert [t.name for t in model.tables["db"]] == ["main_project"]
    assert [h["source"] for h in model.hints["unassigned"] if h["kind"] == "database"] == [
        "app/settings.py:1",
    ]


def test_database_from_owner_manifest(tmp_path: Path) -> None:
    """Владелец таблиц при нескольких базах (ТЗ §15 п. 15 Н2). Найдено в Forem: 133 таблицы
    db/schema.rb в подсказках «несколько баз», базы db и postgres из двух файлов compose.
    Владелец каталога миграций (web с кодом из каталога) без адреса базы в окружении, а в его
    файле compose ровно одна реляционная база: таблицы у неё (postgres), а не у db из файла
    готового образа. Ловушка: тот же web ещё в третьем файле рядом с mysql — подсказка, как
    раньше."""
    model = model_of(FIXTURES / "two-compose-dbs")
    assert {k: [t.name for t in v] for k, v in model.tables.items()} == {
        "postgres": ["articles", "users"],
    }
    assert not [h for h in model.hints.get("unassigned", []) if h["kind"] == "table"]
    src = FIXTURES / "two-compose-dbs"
    files: dict[str, str | bytes] = {
        str(p.relative_to(src)): p.read_text(encoding="utf-8") for p in src.rglob("*") if p.is_file()
    }
    files["docker-compose.mysql.yml"] = (
        "services:\n  web:\n    build: .\n    command: bundle exec rails server\n"
        "  mysql:\n    image: mysql:8\n"
    )
    model = model_of(tree(tmp_path, files))
    assert model.tables == {}
    assert [
        (h["name"], h["reason"]) for h in model.hints["unassigned"] if h["kind"] == "table"
    ] == [("articles", texts.REASON_MANY_DATABASES), ("users", texts.REASON_MANY_DATABASES)]
