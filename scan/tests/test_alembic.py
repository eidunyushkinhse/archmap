"""Миграции Alembic: цепочка ревизий, операции op, типы, ошибки цепочки, враждебный вход."""

from __future__ import annotations

import ast
from functools import partial
from pathlib import Path

import yaml

from archmap_scan.model import Table
from archmap_scan.parsers import alembic
from archmap_scan.scan import Options, run
from tests.helpers import FIXTURES, files_of, model_of, timed, tree

Col = tuple[str, str | None, bool, bool | None, str | None]


def _cols(table: Table) -> list[Col]:
    return [(c.name, c.type, c.pk, c.required, c.references) for c in table.columns]


def _tables(root: Path) -> dict[str, Table]:
    ctx, files = files_of(root)
    found = alembic.parse(files, ctx)
    assert len(found.table_sets) == 1
    return {t.name: t for t in found.table_sets[0].tables}


def test_chain_with_merge_batch_and_execute() -> None:
    ctx, files = files_of(FIXTURES / "alembic")
    found = alembic.parse(files, ctx)
    [ts] = found.table_sets
    assert ts.dir == "services/orders/migrations" and ts.error is None
    tables = {t.name: t for t in ts.tables}
    assert sorted(tables) == ["customers", "order_audit", "order_items", "orders", "settings"]
    assert tables["customers"].schema == "shop"
    assert _cols(tables["customers"]) == [
        ("id", "uuid", True, True, None),
        ("email", "varchar(255)", False, True, None),
        ("tags", "text[]", False, False, None),
    ]
    # Ветка 3e4f удаляет created_at, ветка 2c3d переименовывает status: обе до слияния.
    assert _cols(tables["orders"]) == [
        ("id", "bigint", True, True, None),
        ("customer_id", "uuid", False, False, "shop.customers.id"),
        ("total", "numeric(12, 2)", False, True, None),
        ("state", "order_status", False, True, None),
        ("comment", "text", False, False, None),
        ("paid_at", "timestamp", False, False, None),
    ]
    assert _cols(tables["order_items"]) == [
        ("id", "integer", True, True, None),
        ("order_id", "bigint", False, True, "orders.id"),
        ("sku", "varchar(128)", False, False, "products.sku"),
        ("qty", "integer", False, True, None),
    ]
    # op.execute: DDL отдан SQL-разборщику с номерами строк файла миграции.
    assert [str(loc) for loc in tables["order_audit"].locs] == [
        "services/orders/migrations/versions/2c3d_items.py:26",
        "services/orders/migrations/versions/5a6b_merge.py:9",
    ]
    assert _cols(tables["settings"]) == [
        ("key", "text", True, True, None), ("value", "jsonb", False, False, None),
    ]
    assert ts.dropped == 1 and ts.skipped == 2
    assert [(str(loc), text) for loc, text in ts.skipped_examples] == [
        ("services/orders/migrations/versions/5a6b_merge.py:13", "if op.add_column"),
        ("services/orders/migrations/versions/5a6b_merge.py:15", "op.create_table_if_absent"),
    ]
    assert [h.data for h in found.hints] == [{
        "kind": "file", "name": "services/orders/migrations/versions/6c7d_broken.py",
        "reason": "файл миграции не разбирается как Python",
        "source": "services/orders/migrations/versions/6c7d_broken.py",
    }]


def test_owner_and_facts(tmp_path: Path) -> None:
    model = model_of(FIXTURES / "alembic")
    assert list(model.tables) == ["orders-db"]
    assert model.table_stats.skipped == {"alembic_operations": 2}
    out = tmp_path / "out"
    run(Options(path=str(FIXTURES / "alembic"), out=str(out), system="Ярмарка", use_git=False))
    text = (out / "facts" / "orders-db.tables.yaml").read_text(encoding="utf-8")
    assert text.startswith("# archmap-node: Ярмарка / orders-db\n")
    coverage = yaml.safe_load((out / "coverage.yaml").read_text(encoding="utf-8"))
    assert coverage["families"]["tables"] == {
        "status": "covered", "found": 5, "parsers": ["alembic"],
        "skipped": {"alembic_operations": 2}, "dropped": 1,
    }


def test_cycle_and_broken_chain(tmp_path: Path) -> None:
    out = tmp_path / "out"
    run(Options(path=str(FIXTURES / "alembic-cycle"), out=str(out), system="Ярмарка",
                use_git=False))
    coverage = yaml.safe_load((out / "coverage.yaml").read_text(encoding="utf-8"))
    tables = coverage["families"]["tables"]
    assert tables["status"] == "error"
    assert tables["error"] == (
        "в каталоге broken/ обрыв цепочки Alembic: ревизия xxxx ссылается на неизвестную"
        " ревизию gone; в каталоге db/ цикл ревизий Alembic: aaaa, bbbb"
    )
    hints = yaml.safe_load((out / "agent" / "hints.yaml").read_text(encoding="utf-8"))
    assert [h["name"] for h in hints["unassigned"]] == ["broken/", "db/"]
    assert hints["unassigned"][1]["reason"] == (
        "цикл ревизий Alembic: aaaa, bbbb; таблицы из этих миграций не собраны"
    )


def _type(src: str) -> str | None:
    node = ast.parse(src, mode="eval").body
    return alembic.render_type(node)


def test_render_type() -> None:
    assert _type("sa.String(50)") == "varchar(50)"
    assert _type("sa.String()") == "varchar"
    assert _type("sa.Unicode(length=20)") == "varchar(20)"
    assert _type("sa.Integer") == "integer"
    assert _type("sa.Numeric(precision=10, scale=2)") == "numeric(10, 2)"
    assert _type("sa.DateTime()") == "timestamp"
    assert _type("sa.TIMESTAMP(timezone=True)") == "timestamp with time zone"
    assert _type("postgresql.JSONB(astext_type=sa.Text())") == "jsonb"
    assert _type("postgresql.ARRAY(postgresql.ARRAY(sa.Integer()))") == "integer[][]"
    assert _type("sa.Enum('a', 'b')") == "enum"
    assert _type("sqlalchemy_utils.types.ChoiceType(X)") == "ChoiceType"
    assert _type("sa.Text") == "text"
    assert _type("types[0]") is None


def test_order_by_path_and_merge() -> None:
    revs = [
        alembic._Revision("v/3.py", "c", ["a"], None),
        alembic._Revision("v/2.py", "b", ["a"], None),
        alembic._Revision("v/4.py", "d", ["b", "c"], None),
        alembic._Revision("v/1.py", "a", [], None),
        alembic._Revision("v/9.py", "a", [], None),  # повтор ревизии: берётся первый по пути
    ]
    ordered, error = alembic.order(revs)
    assert error is None
    assert [r.revision for r in ordered] == ["a", "b", "c", "d"]
    _, error = alembic.order([alembic._Revision("v/1.py", "a", ["a"], None)])
    assert error == "цикл ревизий Alembic: a"


def test_alembic_dirs_need_env_py(tmp_path: Path) -> None:
    tree(tmp_path, {
        "a/versions/1.py": "revision = '1'\ndown_revision = None\n",
        "b/env.py": "",
        "b/versions/1.py": "revision = '1'\ndown_revision = None\n",
        "env.py": "",
        "versions/1.py": "revision = '1'\ndown_revision = None\n",
    })
    _, files = files_of(tmp_path)
    assert alembic.alembic_dirs(files) == ["", "b"]


def test_unknown_table_and_odd_calls(tmp_path: Path) -> None:
    tree(tmp_path, {
        "m/env.py": "",
        "m/versions/1.py": (
            "revision = '1'\ndown_revision = None\n"
            "def upgrade():\n"
            "    op.add_column('elsewhere', sa.Column('x', sa.Integer()))\n"
            "    op.create_table(name_var, sa.Column('x', sa.Integer()))\n"
            "    op.create_table('t', sa.Column('a', sa.Integer()), sa.Column('a', sa.Text()))\n"
            "    op.add_column(table_var, sa.Column('y', sa.Integer()))\n"
            "    op.add_column('t', column_var)\n"
            "    op.execute(query)\n"
            "    with op.get_context().autocommit_block():\n"
            "        op.add_column('t', sa.Column('b', sa.Text(), nullable=False))\n"
            "    with op.batch_alter_table('t', schema=None) as b:\n"
            "        b.drop_column('a')\n"
            "        b.rename_everything()\n"
            "    helper(op)\n"
            "def downgrade():\n"
            "    op.drop_table('t')\n"
        ),
    })
    tables = _tables(tmp_path)
    assert _cols(tables["t"]) == [("b", "text", False, True, None)]
    ctx, files = files_of(tmp_path)
    [ts] = alembic.parse(files, ctx).table_sets
    # create_table с именем из переменной, add_column к переменной и без колонки, execute
    # без строки, неизвестный вызов batch_op и передача op в функцию.
    assert ts.skipped == 6


def test_renames_move_references(tmp_path: Path) -> None:
    """rename_table и alter_column с new_column_name переносят ссылки других таблиц (ТЗ §15
    п. 18 М1), как ALTER TABLE … RENAME у SQL: ссылка sa.ForeignKey в create_table и
    add_column, ForeignKeyConstraint и create_foreign_key. Переименование в batch_alter_table
    тоже. В корпусе Airflow 14 файлов versions/ с rename_table или new_column_name, но цепочка
    оборвана (ee86eed19e24), таблиц в выводе три; правило проверено здесь."""
    head = '"""r"""\nimport sqlalchemy as sa\nfrom alembic import op\n\n'
    tree(tmp_path, {
        "db/env.py": "",
        "db/versions/1_init.py": head + (
            'revision = "a"\ndown_revision = None\n\n\ndef upgrade():\n'
            '    op.create_table("users", sa.Column("id", sa.Integer(), primary_key=True))\n'
            '    op.create_table("orders", sa.Column("id", sa.Integer(), primary_key=True),\n'
            '                    sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id")))\n'
            '    op.create_table("notes", sa.Column("author_id", sa.Integer()),\n'
            '                    sa.ForeignKeyConstraint(["author_id"], ["users.id"]))\n'
            '    op.add_column("orders", sa.Column("buyer_id", sa.Integer(), sa.ForeignKey("users.id")))\n'
            '    op.create_table("tags", sa.Column("owner_id", sa.Integer()))\n'
            '    op.create_foreign_key("fk", "tags", "users", ["owner_id"], ["id"])\n'
            '    op.create_table("logs", sa.Column("order_id", sa.Integer(), sa.ForeignKey("orders.id")))\n'
        ),
        "db/versions/2_rename.py": head + (
            'revision = "b"\ndown_revision = "a"\n\n\ndef upgrade():\n'
            '    op.rename_table("users", "accounts")\n'
            '    op.alter_column("accounts", "id", new_column_name="account_id")\n'
            '    with op.batch_alter_table("orders") as batch_op:\n'
            '        batch_op.alter_column("id", new_column_name="order_id")\n'
        ),
    })
    tables = _tables(tmp_path)
    refs = {
        f"{t}.{c.name}": c.references for t, table in tables.items() for c in table.columns
        if c.references
    }
    assert refs == {
        "orders.user_id": "accounts.account_id", "orders.buyer_id": "accounts.account_id",
        "notes.author_id": "accounts.account_id", "tags.owner_id": "accounts.account_id",
        "logs.order_id": "orders.order_id",
    }


def test_hostile_input_is_fast(tmp_path: Path) -> None:
    # Глубокая вложенность, длинная цепочка ревизий и строка на 2 МБ.
    files: dict[str, str | bytes] = {"m/env.py": "", "m/versions/deep.py": "x = " + "(" * 200_000}
    for i in range(3000):
        parent = f"'r{i - 1}'" if i else "None"
        files[f"m/versions/r{i:05d}.py"] = (
            f"revision = 'r{i}'\ndown_revision = {parent}\n"
            "def upgrade():\n    op.add_column('t', sa.Column('c', sa.Integer()))\n"
        )
    files["m/versions/huge.py"] = "revision = 'h'\ndown_revision = None\ns = '" + "x" * 2_000_000
    tree(tmp_path, files)
    ctx, found_files = files_of(tmp_path)
    found, took = timed(partial(alembic.parse, found_files, ctx), 1.0)
    assert took < 1.0
    assert found.table_sets[0].error is None
