"""Миграции Django: порядок по dependencies, squash, операции, типы полей, ошибки цепочки."""

from __future__ import annotations

import ast
from functools import partial
from pathlib import Path

import yaml

from archmap_scan.model import Table
from archmap_scan.parsers import django
from archmap_scan.scan import Options, run
from tests.helpers import FIXTURES, files_of, model_of, timed, tree

Col = tuple[str, str | None, bool, bool | None, str | None]


def _cols(table: Table) -> list[Col]:
    return [(c.name, c.type, c.pk, c.required, c.references) for c in table.columns]


def _sets(root: Path) -> dict[str, dict[str, Table]]:
    ctx, files = files_of(root)
    found = django.parse(files, ctx)
    return {ts.dir: {t.name: t for t in ts.tables} for ts in found.table_sets}


def test_fixture_tables() -> None:
    ctx, files = files_of(FIXTURES / "django")
    found = django.parse(files, ctx)
    sets = {ts.dir: ts for ts in found.table_sets}
    assert sorted(sets) == ["accounts", "billing", "shop"]
    shop = {t.name: t for t in sets["shop"].tables}
    # label из apps.py, AlterModelTable, RenameModel, proxy и managed=False без таблиц.
    # shop_audit создан литеральным RunSQL: его разобрал SQL-разборщик.
    assert sorted(shop) == ["customers", "shop_audit", "store_purchase"]
    assert _cols(shop["shop_audit"]) == [
        ("id", "bigserial", True, True, None), ("note", "text", False, True, None),
    ]
    assert _cols(shop["customers"]) == [
        ("id", "serial", True, True, None),
        ("full_name", "varchar(100)", False, True, None),
        ("tags", "varchar(20)[]", False, True, None),
        ("owner_id", "bigint", False, True, "accounts_user.id"),
    ]
    assert _cols(shop["store_purchase"]) == [
        ("id", "bigserial", True, True, None),
        ("buyer_id", "integer", False, True, "customers.id"),
        ("total", "numeric(10, 2)", False, True, None),
        ("note", "text", False, True, None),
        ("parent_id", "bigint", False, False, "store_purchase.id"),
        ("order_code", "varchar(50)", False, True, None),
        ("status", "varchar(16)", False, True, None),
        ("weight", "double precision", False, False, None),
        ("_order", "integer", False, True, None),
    ]
    # RunPython — миграция данных, а не пропуск; RunSQL с переменной — пропуск.
    assert sets["shop"].dropped == 1 and sets["shop"].skipped == 2
    assert sets["shop"].data_migrations == 1
    assert [(str(loc), text) for loc, text in sets["shop"].skipped_examples] == [
        ("shop/migrations/0002_rename.py:36", "CustomOperation"),
        ("shop/migrations/0002_rename.py:45", "RunSQL"),
    ]
    # Squash заменил 0001 и 0002, 0003 зависит от заменённой и идёт после squash.
    [invoice] = sets["billing"].tables
    assert _cols(invoice) == [
        ("id", "serial", True, True, None),
        ("amount", "integer", False, True, None),
        ("purchase_id", "bigint", False, True, "store_purchase.id"),
        ("uploaded", "varchar(100)", False, True, None),
        ("ref", "uuid", False, False, None),
    ]
    [user] = sets["accounts"].tables
    assert _cols(user) == [
        ("id", "bigserial", True, True, None), ("email", "varchar(254)", False, True, None),
    ]
    assert [h.data["name"] for h in found.hints] == ["billing/migrations/0004_broken.py"]


def test_owner_and_facts(tmp_path: Path) -> None:
    model = model_of(FIXTURES / "django")
    assert list(model.tables) == ["db"]
    assert model.table_stats.skipped == {"django_operations": 2, "data_migrations": 1}
    out = tmp_path / "out"
    run(Options(path=str(FIXTURES / "django"), out=str(out), system="Ярмарка", use_git=False))
    coverage = yaml.safe_load((out / "coverage.yaml").read_text(encoding="utf-8"))
    assert coverage["families"]["tables"] == {
        "status": "covered", "found": 5, "parsers": ["django"],
        "skipped": {"data_migrations": 1, "django_operations": 2}, "dropped": 1,
    }
    doc = yaml.safe_load((out / "facts" / "db.tables.yaml").read_text(encoding="utf-8"))
    assert [t["name"] for t in doc["tables"]] == [
        "accounts_user", "billing_invoice", "customers", "shop_audit", "store_purchase",
    ]
    # Миграция данных в подсказки не идёт: это не пропуск.
    hints = yaml.safe_load((out / "agent" / "hints.yaml").read_text(encoding="utf-8"))
    assert all(h["name"] != "RunPython" for h in hints["unassigned"])


def _migration(deps: str, ops: str = "") -> str:
    return (
        "from django.db import migrations, models\n\n"
        "class Migration(migrations.Migration):\n"
        f"    dependencies = {deps}\n"
        f"    operations = [{ops}]\n"
    )


def test_cycle_and_broken(tmp_path: Path) -> None:
    tree(tmp_path / "cycle", {
        "a/migrations/0001_x.py": _migration('[("a", "0002_y")]'),
        "a/migrations/0002_y.py": _migration('[("a", "0001_x")]'),
    })
    ctx, files = files_of(tmp_path / "cycle")
    [ts] = django.parse(files, ctx).table_sets
    assert ts.error == "цикл миграций Django: a.0001_x, a.0002_y" and ts.dir == "a"
    tree(tmp_path / "broken", {
        "a/migrations/0001_x.py": _migration("[]"),
        "b/migrations/0001_x.py": _migration('[("a", "0009_gone")]'),
    })
    ctx, files = files_of(tmp_path / "broken")
    [ts] = django.parse(files, ctx).table_sets
    assert ts.error == (
        "обрыв цепочки Django: миграция b.0001_x ссылается на неизвестную миграцию a.0009_gone"
    )
    assert ts.dir == ""


def test_order_first_and_run_before(tmp_path: Path) -> None:
    create = 'migrations.CreateModel(name="T", fields=[("id", models.AutoField(primary_key=True))])'
    tree(tmp_path, {
        # b.0001 создаёт таблицу, a.0001 должна идти до неё (run_before), а c.0001 — после
        # первой миграции b (__first__).
        "a/migrations/0001_init.py": (
            _migration("[]") + '    run_before = [("b", "0001_init")]\n'
        ),
        "b/migrations/0001_init.py": _migration("[]", create),
        "b/migrations/0002_more.py": _migration(
            '[("b", "0001_init")]',
            'migrations.AddField(model_name="t", name="x", field=models.IntegerField())',
        ),
        "c/migrations/0001_init.py": _migration(
            '[("b", "__first__")]',
            'migrations.AddField(model_name="t", name="y", field=models.IntegerField())',
        ),
    })
    ctx, files = files_of(tmp_path)
    found = django.parse(files, ctx)
    migrations = [
        django._migration(rel, rel.split("/")[0], ast.parse((tmp_path / rel).read_text()),
                          django._State(user_model=("auth", "user")))
        for rel in files.paths
    ]
    ordered, error = django.order([m for m in migrations if m is not None])
    assert error is None
    names = [f"{m.app}.{m.name}" for m in ordered]
    assert names.index("a.0001_init") < names.index("b.0001_init") < names.index("c.0001_init")
    # c добавляет поле в модель другого приложения: такой модели у c нет, вызов понят.
    [ts] = [ts for ts in found.table_sets if ts.dir == "b"]
    assert [c.name for c in ts.tables[0].columns] == ["id", "x"]


def _type(src: str) -> str | None:
    node = ast.parse(src, mode="eval").body
    assert isinstance(node, ast.Call)
    return django.column_type(node)


def test_column_types() -> None:
    assert _type("models.CharField(max_length=40)") == "varchar(40)"
    assert _type("models.CharField()") == "varchar"
    assert _type("models.EmailField()") == "varchar(254)"
    assert _type("models.DecimalField(max_digits=5, decimal_places=1)") == "numeric(5, 1)"
    assert _type("models.DecimalField()") == "numeric"
    assert _type("BoundedBigIntegerField()") == "bigint"
    assert _type("BoundedPositiveIntegerField()") == "integer"
    assert _type("models.JSONField(default=dict)") == "jsonb"
    assert _type("ArrayField(models.TextField())") == "text[]"
    assert _type("ArrayField(base)") == "array"
    assert _type("BitField(flags=[])") == "BitField"


def test_user_model_default_and_hybrid_key(tmp_path: Path) -> None:
    tree(tmp_path, {
        "a/migrations/0001_init.py": _migration("[]", (
            'migrations.CreateModel(name="T", fields=['
            '("id", models.BigAutoField(primary_key=True)),'
            '("user", models.ForeignKey(on_delete=models.CASCADE, to=settings.AUTH_USER_MODEL)),'
            '("org_id", HybridCloudForeignKey("a.Org", on_delete="CASCADE")),'
            '("tags", models.ManyToManyField(to="a.Tag")),'
            '("name", models.CharField(max_length=10, null=True, db_column="title")),'
            "])"
        )),
    })
    tables = _sets(tmp_path)["a"]
    assert _cols(tables["a_t"]) == [
        ("id", "bigserial", True, True, None),
        ("user_id", None, False, True, "auth_user.id"),
        ("org_id", "bigint", False, True, None),
        ("title", "varchar(10)", False, False, None),
    ]


def test_not_django_and_odd_operations(tmp_path: Path) -> None:
    tree(tmp_path, {
        "tools/migrations/001_steps.py": "STEPS = ['create table x']\n",
        "a/migrations/0001_init.py": (
            "from django.db import migrations\n\n"
            "class Migration(migrations.Migration):\n"
            "    dependencies = []\n"
            "    operations = make_operations()\n"
        ),
        "a/migrations/0002_more.py": _migration(
            '[("a", "0001_init")]',
            "op_var, migrations.AddField(model_name=name_var, name='x', field=f()),"
            " migrations.CreateModel(name=name_var, fields=[]),"
            " migrations.AddField(model_name='missing', name='x', field=models.IntegerField()),"
            " migrations.RemoveField(model_name='missing', name='x'),"
            " migrations.AlterModelTable(name='t', table=table_var)",
        ),
    })
    ctx, files = files_of(tmp_path)
    [ts] = django.parse(files, ctx).table_sets
    assert ts.tables == []
    # operations не списком, op_var, AddField и CreateModel с именем-переменной,
    # AlterModelTable с таблицей-переменной.
    assert ts.skipped == 5


def test_hostile_input_is_fast(tmp_path: Path) -> None:
    files: dict[str, str | bytes] = {
        "a/migrations/0000_deep.py": "x = " + "[" * 200_000,
        "a/migrations/0000_huge.py": "s = '" + "x" * 2_000_000,
    }
    for i in range(1, 2000):
        files[f"a/migrations/{i:04d}_m.py"] = _migration(
            f'[("a", "{i - 1:04d}_m")]' if i > 1 else "[]",
            "migrations.AddField(model_name='t', name='c', field=models.IntegerField())",
        )
    tree(tmp_path, files)
    ctx, found_files = files_of(tmp_path)
    found, took = timed(partial(django.parse, found_files, ctx), 1.0)
    assert took < 1.0
    assert found.table_sets == []
