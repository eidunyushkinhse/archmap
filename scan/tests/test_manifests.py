"""Манифесты сборки: имена, зависимости, языки, стеки без разборщика."""

from __future__ import annotations

import time
from pathlib import Path

from archmap_scan import stats
from archmap_scan.model import Package
from archmap_scan.parsers import manifests
from tests.helpers import FIXTURES, files_of, tree


def _packages() -> dict[str, Package]:
    ctx, files = files_of(FIXTURES / "manifests")
    found = manifests.parse(files, ctx)
    return {p.path: p for p in found.packages}


def test_each_manifest_kind() -> None:
    pkgs = _packages()
    assert pkgs["package.json"].workspaces == ("web", "packages/*")
    web = pkgs["web/package.json"]
    assert web.name == "@shop/web" and web.deps == ("react", "react-dom", "kafkajs")
    assert str(web.name_loc) == "web/package.json:2"
    api = pkgs["api/pyproject.toml"]
    assert api.name == "shop-api" and str(api.name_loc) == "api/pyproject.toml:2"
    assert api.deps == ("fastapi", "sqlalchemy", "psycopg2-binary")
    assert pkgs["pipsvc/pyproject.toml"].deps == ("django", "celery")
    assert pkgs["pipsvc/requirements-prod.txt"].deps == ("gunicorn", "confluent-kafka")
    assert pkgs["pipsvc/Pipfile"].deps == ("flask", "redis")
    go = pkgs["gosvc/go.mod"]
    assert go.name == "github.com/org/shop/gosvc/v2" and go.language == "Go"
    assert go.deps == ("github.com/go-chi/chi/v5", "github.com/jackc/pgx/v5", "github.com/ibm/sarama")
    assert pkgs["rs/Cargo.toml"].deps == ("axum", "tokio")
    java = pkgs["javasvc/pom.xml"]
    assert java.name == "shop-java" and str(java.name_loc) == "javasvc/pom.xml:7"
    assert java.deps == ("spring-boot-starter-parent", "spring-kafka")
    assert pkgs["kt/build.gradle.kts"].deps == ("postgresql", "spring-boot")
    assert pkgs["rb/Gemfile"].deps == ("rails", "pg")
    assert pkgs["php/composer.json"].deps == ("laravel/framework",)
    ex = pkgs["ex/mix.exs"]
    assert ex.name == "shop_ex" and ex.deps == ("phoenix", "ecto_sql")
    assert "broken/package.json" not in pkgs


def test_markers_and_unparsed() -> None:
    ctx, files = files_of(FIXTURES / "manifests")
    found = manifests.parse(files, ctx)
    assert found.unsupported == {"schedules": ["crontab"], "tables": ["Prisma"]}
    assert [h.data["path"] for h in found.hints] == ["broken/package.json"]


def test_code_unsupported_stacks() -> None:
    ctx, files = files_of(FIXTURES / "manifests")
    found = manifests.parse(files, ctx)
    stacks = stats.code_unsupported(found)
    assert stacks["http_routes"] == [
        "chi", "Django", "FastAPI", "Flask", "Laravel", "Phoenix", "Rails", "Spring Boot",
    ]
    assert stacks["config"] == ["Elixir", "Go", "Java", "Node.js", "PHP", "Python", "Ruby", "Rust"]
    assert stacks["channels"] == ["celery", "confluent-kafka", "kafkajs", "sarama"]
    assert stacks["schedules"] == ["Celery beat"]
    assert stacks["tables"] == ["Ecto"]


def test_pom_with_doctype_is_refused() -> None:
    import pytest

    with pytest.raises(ValueError):
        manifests._pom("pom.xml", '<!DOCTYPE x [<!ENTITY a "b">]><project/>')


def test_oversized_manifest_is_named_not_parsed(tmp_path: Path) -> None:
    tree(tmp_path, {"pyproject.toml": '[project]\nname = "' + "a" * 600_000 + '"\n'})
    ctx, files = files_of(tmp_path)
    started = time.perf_counter()
    found = manifests.parse(files, ctx)
    assert time.perf_counter() - started < 0.1
    assert found.packages == []
    assert [h.data["reason"] for h in found.hints] == ["манифест сборки больше предела разбора"]
