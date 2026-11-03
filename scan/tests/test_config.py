"""Примеры окружения, правила секретов и параметры конфигурации контейнеров."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from archmap_scan import secrets
from archmap_scan.parsers import envexample
from archmap_scan.scan import Options, run
from tests.helpers import FIXTURES, files_of, model_of, tree

# Значения из примера, которых в выводе быть не должно ни в каком файле.
SECRET_VALUES = (
    "orders-pass", "change-me-please", "sk_live_51Habcdefghijklmnop",
    "AbCdEf0123456789XyZ0123456789", "never-open-me",
)


def test_env_example_lines() -> None:
    ctx, files = files_of(FIXTURES / "envexample")
    found = envexample.parse(files, ctx)
    by_path = {e.path: e for e in found.env_files}
    assert set(by_path) == {"services/orders/.env.example", "lib/.env.sample"}
    orders = {v.name: v for v in by_path["services/orders/.env.example"].vars}
    assert orders["LOG_LEVEL"].value == "info" and str(orders["LOG_LEVEL"].loc).endswith(":2")
    assert orders["FEATURE_NEW_CHECKOUT"].value == "false"
    assert orders["GREETING"].value == "привет мир"
    assert orders["TEMPLATE"].dynamic
    # Повтор имени не перекрывает первое значение.
    assert orders["WORKERS"].value == "4"


@pytest.mark.parametrize(
    ("name", "value", "expected"),
    [
        ("LOG_LEVEL", "info", "info"),
        ("ORDER_TIMEOUT", "30s", "30s"),
        ("JWT_SECRET", "change-me", None),
        ("PARTITION_KEY", "order_id", None),
        ("API_URL", "http://orders:8080", None),
        ("CACHE", "redis:6379", None),
        ("SALT", "AbCdEf0123456789XyZ0123456789", None),
        ("STRIPE", "sk_test_x", None),
        ("EMPTY", "", None),
        ("LONG", "x" * 300, None),
        ("NONE", None, None),
    ],
)
def test_safe_default(name: str, value: str | None, expected: str | None) -> None:
    assert secrets.safe_default(name, value) == expected


@pytest.mark.parametrize(
    ("value", "kind"),
    [("true", "bool"), ("Off", "bool"), ("42", "int"), ("-1", "int"), ("1h30m", "duration"),
     ("250ms", "duration"), ("info", "string"), ("", None), (None, None), ("9" * 80, "string")],
)
def test_value_type(value: str | None, kind: str | None) -> None:
    assert secrets.value_type(value) == kind


def test_params_owners_and_redis_broker() -> None:
    model = model_of(FIXTURES / "envexample")
    params = model.params["orders"]
    assert params["LOG_LEVEL"].default == "info" and params["LOG_LEVEL"].type == "string"
    assert {str(loc) for loc in params["LOG_LEVEL"].locs} == {
        "docker-compose.yml:5", "services/orders/.env.example:2",
    }
    assert params["ORDER_TIMEOUT"].type == "duration"
    assert params["WORKERS"].default == "4" and params["WORKERS"].type == "int"
    assert params["FEATURE_NEW_CHECKOUT"].type == "bool"
    assert params["DATABASE_URL"].default is None
    assert params["JWT_SECRET"].default is None and params["JWT_SECRET"].type == "string"
    assert params["EMPTY"].type is None and params["TEMPLATE"].default is None
    # Пример вне каталога кода контейнеров — общий код.
    unassigned = [h for h in model.hints["unassigned"] if h["kind"] == "config"]
    assert [(h["name"], h["source"]) for h in unassigned] == [("SHARED_FLAG", "lib/.env.sample:1")]
    queue = model.obj("queue")
    assert queue is not None and queue.shape == "broker"
    links = {(lk.src.name, lk.dst.name): lk.parsers for lk in model.links}
    assert links == {("orders", "orders-db"): {"env-example"}, ("orders", "queue"): {"env-example"}}


def test_config_facts_and_no_secrets(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    # Настоящие файлы окружения кладутся во время теста: в репозиторий ArchMap они не
    # попадают (.gitignore), а сборщик не должен их даже открыть.
    import shutil

    shutil.copytree(FIXTURES / "envexample", repo)
    tree(repo, {
        "services/orders/.env": "REAL_ENV_VALUE=never-open-me\n",
        "services/orders/.env.local": "LOCAL_VALUE=never-open-me\n",
        ".env.production": "PROD=never-open-me\n",
    })
    out = tmp_path / "out"
    run(Options(path=str(repo), out=str(out), system="Ярмарка", use_git=False))
    text = (out / "facts" / "orders.config.yaml").read_text(encoding="utf-8")
    assert text.startswith("# archmap-node: Ярмарка / orders\n# archmap-scan 0.1.0\n")
    doc = yaml.safe_load(text)
    items = {i["name"]: i for i in doc["config"]}
    assert items["LOG_LEVEL"] == {"name": "LOG_LEVEL", "type": "string", "default": "info"}
    assert items["FEATURE_NEW_CHECKOUT"] == {
        "name": "FEATURE_NEW_CHECKOUT", "type": "bool", "default": "false",
    }
    assert items["GREETING"]["default"] == "привет мир"
    assert "REAL_ENV_VALUE" not in items and "LOCAL_VALUE" not in items
    everything = "".join(
        p.read_text(encoding="utf-8") for p in out.rglob("*") if p.is_file()
    )
    for value in SECRET_VALUES:
        assert value not in everything, value
    evidence = yaml.safe_load((out / "agent" / "evidence.yaml").read_text(encoding="utf-8"))
    assert evidence["config/orders/WORKERS"] == ["services/orders/.env.example:4"]
