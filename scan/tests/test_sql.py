"""SQL DDL: грамматика, цепочка миграций, владельцы баз, файлы таблиц."""

from __future__ import annotations

import time
from pathlib import Path

import yaml

from archmap_scan import sqlddl, texts
from archmap_scan.model import Loc, Table
from archmap_scan.parsers import sql
from archmap_scan.scan import Options, run
from tests.helpers import FIXTURES, files_of, model_of, tree


def _cols(table: Table) -> list[tuple[str, str | None, bool, bool | None, str | None]]:
    return [(c.name, c.type, c.pk, c.required, c.references) for c in table.columns]


def _sets() -> dict[str, dict[str, Table]]:
    ctx, files = files_of(FIXTURES / "sql")
    found = sql.parse(files, ctx)
    return {ts.dir: {t.name: t for t in ts.tables} for ts in found.table_sets}


def test_postgres_chain() -> None:
    ctx, files = files_of(FIXTURES / "sql")
    found = sql.parse(files, ctx)
    billing = next(ts for ts in found.table_sets if ts.dir == "services/billing/migrations")
    tables = {t.name: t for t in billing.tables}
    assert set(tables) == {"accounts", "invoices", "invoice_payments"}
    accounts = tables["accounts"]
    assert accounts.schema == "billing"
    assert _cols(accounts) == [
        ("id", "uuid", True, True, None),
        ("Email", "varchar(255)", False, True, None),
        ("created_at", "timestamp with time zone", False, True, None),
        ("comment", "text", False, False, None),
        ("phone", "varchar(32)", False, False, None),
    ]
    assert _cols(tables["invoices"]) == [
        ("id", "bigserial", True, True, None),
        ("account_id", "uuid", False, True, "accounts.id"),
        ("amount", "numeric(14, 2)", False, True, None),
        ("status", "varchar(16)", False, False, None),
        ("due_date", "date", False, False, None),
    ]
    assert _cols(tables["invoice_payments"]) == [
        ("id", "bigint", True, True, None),
        ("invoice_id", "bigint", False, False, "invoices.id"),
    ]
    # tmp_import создана и удалена по ходу цепочки: в выводе её нет, в счёте есть.
    assert billing.dropped == 1
    assert billing.skipped == 2
    assert [text for _, text in billing.skipped_examples] == [
        "ALTER DOMAIN money_amount", "CREATE AGGREGATE sum_amount",
    ]
    assert str(billing.skipped_examples[0][0]) == "services/billing/migrations/V2__accounts.sql:9"


def test_mysql_and_other_dialects() -> None:
    sets = _sets()
    events = sets["services/analytics/db/migrations"]["raw_events"]
    assert _cols(events) == [
        ("id", "INT UNSIGNED", True, True, None),
        ("event_kind", "VARCHAR(80)", False, True, None),
        ("payload", "JSON", False, True, None),
    ]
    posts = sets["tools/diesel/migrations"]["posts"]
    assert _cols(posts)[0] == ("id", "SERIAL", True, True, None)
    users = sets["schema"]["Users"]
    assert users.schema == "dbo"
    assert _cols(users) == [("Id", "INT", True, True, None), ("Name", "NVARCHAR(100)", False, False, None)]


def test_owners_and_facts(tmp_path: Path) -> None:
    model = model_of(FIXTURES / "sql")
    assert sorted(model.tables) == ["analytics-db", "billing-db"]
    unassigned = {h["name"]: h["reason"] for h in model.hints["unassigned"] if h["kind"] == "table"}
    assert set(unassigned) == {"posts", "Users"}
    assert all("несколько баз" in str(r) for r in unassigned.values())
    assert model.table_stats.skipped == {"sql_statements": 2}
    assert model.table_stats.found == 6 and model.table_stats.dropped == 1

    out = tmp_path / "out"
    run(Options(path=str(FIXTURES / "sql"), out=str(out), system="Ярмарка", use_git=False))
    text = (out / "facts" / "billing-db.tables.yaml").read_text(encoding="utf-8")
    assert text.startswith("# archmap-node: Ярмарка / billing-db\n")
    doc = yaml.safe_load(text)
    assert [t["name"] for t in doc["tables"]] == ["invoice_payments", "invoices", "accounts"]
    accounts = doc["tables"][2]
    assert accounts["schema"] == "billing"
    assert accounts["columns"][0] == {"name": "id", "type": "uuid", "pk": True, "required": True}
    evidence = yaml.safe_load((out / "agent" / "evidence.yaml").read_text(encoding="utf-8"))
    assert evidence["tables/billing-db/billing.accounts"] == [
        "services/billing/migrations/V1__init.sql:5",
        "services/billing/migrations/V2__accounts.sql:1",
        "services/billing/migrations/V2__accounts.sql:2",
    ]
    coverage = yaml.safe_load((out / "coverage.yaml").read_text(encoding="utf-8"))
    # Найдено — только записанное в facts/; две таблицы без владельца названы отдельно.
    assert coverage["families"]["tables"] == {
        "status": "covered", "found": 4, "parsers": ["sql"],
        "skipped": {"sql_statements": 2}, "dropped": 1, "unassigned": 2,
    }


def test_statement_splitting() -> None:
    text = "a 'x;y' \"q;\" `b;` [c;d];\n-- x;\nb $tag$ ; $tag$ ; /* ; */ c;"
    stmts = sqlddl.split_statements(text)
    assert [s for _, s in stmts] == ["a 'x;y' \"q;\" `b;` [c;d]", "b $tag$ ; $tag$", "c"]
    assert [line for line, _ in stmts] == [1, 3, 3]


def test_unterminated_and_hostile_input_is_fast() -> None:
    started = time.perf_counter()
    schema = sqlddl.Schema()
    sqlddl.apply_text("CREATE TABLE t (" + "a int, " * 280_000 + ")", "x.sql", schema)
    sqlddl.apply_text("'" + "x" * 2_000_000, "y.sql", schema)
    sqlddl.apply_text("/*" + "*" * 2_000_000, "z.sql", schema)
    sqlddl.apply_text("$a$" + "$" * 1_000_000, "w.sql", schema)
    assert time.perf_counter() - started < 1.0
    assert schema.skipped == 3


def test_alter_unknown_table_and_rename() -> None:
    schema = sqlddl.Schema()
    loc = Loc("m.sql", 1)
    sqlddl.apply("ALTER TABLE elsewhere ADD COLUMN x int", loc, schema)
    sqlddl.apply("CREATE TABLE a (x int)", loc, schema)
    sqlddl.apply("ALTER TABLE a RENAME TO b, ADD COLUMN y text", loc, schema)
    sqlddl.apply("ALTER TABLE b OWNER TO app", loc, schema)
    sqlddl.apply("DROP TABLE missing", loc, schema)
    assert list(schema.tables) == [("", "b")]
    assert [c.name for c in schema.tables[("", "b")].columns] == ["x", "y"]
    assert schema.skipped == 0 and schema.dropped == 0


def test_is_migration() -> None:
    assert sql.is_migration("db/V1__init.sql")
    assert sql.is_migration("x/V1_2__a.sql")
    assert not sql.is_migration("x/U1__undo.sql")
    assert not sql.is_migration("migrations/1.down.sql")
    assert not sql.is_migration("reports/query.sql")
    assert sql.natural_key("V2__a.sql") < sql.natural_key("V10__a.sql")


def test_columns_named_like_keywords() -> None:
    schema = sqlddl.Schema()
    sqlddl.apply_text(
        "CREATE TABLE settings (key text PRIMARY KEY, index integer, check boolean NOT NULL,"
        " KEY idx_index (index), CHECK (index > 0), UNIQUE (key));"
        "ALTER TABLE settings ADD key varchar(10), ADD KEY idx_check (check);",
        "s.sql", schema,
    )
    table = schema.tables[("", "settings")]
    assert _cols(table) == [
        ("key", "text", True, True, None),
        ("index", "integer", False, False, None),
        ("check", "boolean", False, True, None),
    ]
    assert schema.skipped == 0


def test_statistics_are_not_table_structure() -> None:
    schema = sqlddl.Schema()
    sqlddl.apply_text(
        "CREATE STATISTICS IF NOT EXISTS s (dependencies) ON a, b FROM t;\n"
        "DROP STATISTICS s;\n", "x.sql", schema,
    )
    assert schema.skipped == 0


def test_create_as_case_and_skip_examples() -> None:
    """CREATE TABLE … AS даёт таблицу без колонок и подсказку «колонки из запроса»; имя без
    кавычек в нижнем регистре; примеры пропусков сначала о живых таблицах (ТЗ §15 п. 10 А3)."""
    ctx, files = files_of(FIXTURES / "sql-chain")
    (chain,) = sql.parse(files, ctx).table_sets
    assert chain.dialect == "PostgreSQL"
    tables = {t.name: t for t in chain.tables}
    # scratch (TEMP) и gone (удалена) в схему не попали, «Audit» в кавычках как написано.
    assert set(tables) == {"language", "post", "Audit", "post_actions", "post_saved_combined"}
    assert _cols(tables["language"])[0] == ("id", "serial", True, True, None)
    assert _cols(tables["post"])[1] == ("language_id", "int", False, False, "language.id")
    assert _cols(tables["Audit"]) == [("Id", "int", False, False, None)]
    assert tables["post_actions"].columns == [] and tables["post_saved_combined"].columns == []
    assert [(str(loc), name) for loc, name in chain.queried] == [
        ("migrations/0003_smoosh.sql:2", "post_actions"),
        ("migrations/0003_smoosh.sql:7", "post_saved_combined"),
    ]
    # RENAME CONSTRAINT понят и в счёт не идёт; ADD (…) не понят четыре раза.
    assert chain.dropped == 4 and chain.skipped == 4
    assert [(str(loc), text) for loc, text in chain.skipped_examples] == [
        ("migrations/0003_smoosh.sql:14", "ALTER TABLE post"),
        ("migrations/0002_fast.sql:3", "ALTER TABLE post_fast"),
        ("migrations/0002_fast.sql:4", "ALTER TABLE post_fast"),
    ]
    model = model_of(FIXTURES / "sql-chain")
    assert sorted(t.name for t in model.tables["forum-db"]) == [
        "Audit", "language", "post", "post_actions", "post_saved_combined",
    ]
    queried = [h["name"] for h in model.hints["unassigned"]
               if h["reason"] == texts.REASON_COLUMNS_FROM_QUERY]
    assert queried == ["post_actions", "post_saved_combined"]


def test_mysql_keeps_unquoted_case(tmp_path: Path) -> None:
    """У MySQL имя без кавычек хранится как написано: складывать его некому."""
    root = tree(tmp_path, {
        "db/migrations/V1__init.sql": (
            "CREATE TABLE Users (Id INT AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB;\n"
            "CREATE TABLE Orders (UserId INT REFERENCES Users (Id));\n"
        ),
    })
    ctx, files = files_of(root)
    (chain,) = sql.parse(files, ctx).table_sets
    assert chain.dialect == "MySQL"
    tables = {t.name: t for t in chain.tables}
    assert set(tables) == {"Users", "Orders"}
    assert _cols(tables["Orders"]) == [("UserId", "INT", False, False, "Users.Id")]
