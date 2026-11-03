"""Манифесты сборки: имена, зависимости, языки, стеки без разборщика."""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest

from archmap_scan import stats
from archmap_scan.model import Package
from archmap_scan.parsers import manifests
from tests.helpers import FIXTURES, files_of, model_of, tree


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
    # FastAPI, Flask и Django читает ярус кода: в «не умею» их нет.
    assert stacks["http_routes"] == ["chi", "Laravel", "Phoenix", "Rails", "Spring Boot"]
    assert stacks["config"] == ["Elixir", "Go", "Java", "Node.js", "PHP", "Python", "Ruby", "Rust"]
    assert stacks["channels"] == ["celery", "confluent-kafka", "kafkajs", "sarama"]
    assert stacks["schedules"] == ["Celery beat"]
    assert stacks["tables"] == ["Ecto"]


def test_pom_with_doctype_is_refused() -> None:
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


ZULIP_LIKE: dict[str, str | bytes] = {
    "pyproject.toml": (
        '[project]\nname = "zulip-server"\n\n'
        "[dependency-groups]\n"
        "prod = [\n  # Django itself\n  \"django[argon2]==5.2.*\",\n"
        "  \"ipython<9\",  # \"9.0\" requires a newer Python\n]\n"
        'dev = [{include-group = "prod"}, "pytest"]\n\n'
        "[project.optional-dependencies]\n"
        'mail = ["aiosmtpd>=1.4"]\n'
    ),
    "package.json": (
        '{"name": "zulip", "dependencies": {"koa": "3", "react": "19"},'
        ' "devDependencies": {"express": "5"}}'
    ),
    "requirements/prod.txt": "Django==5.2 \\\n    --hash=sha256:abc\ncelery[redis]\n",
}


def test_dependency_groups_and_requirements_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Находка фазы 1а на Zulip: Django не опознан, потому что живёт в [dependency-groups]
    (PEP 735). Читаются все группы и [project.optional-dependencies]; requirements/*.txt —
    манифест каталога выше; devDependencies стек не задают."""
    tree(tmp_path, ZULIP_LIKE)
    for version in ((3, 12, 0, "final", 0), (3, 10, 0, "final", 0)):
        monkeypatch.setattr(sys, "version_info", version)
        ctx, files = files_of(tmp_path)
        pkgs = {p.path: p for p in manifests.parse(files, ctx).packages}
        assert pkgs["pyproject.toml"].deps == ("django", "ipython", "pytest", "aiosmtpd"), version
        req = pkgs["requirements/prod.txt"]
        assert (req.dir, req.deps) == ("", ("django", "celery"))
        assert pkgs["package.json"].deps == ("koa", "react")


def test_root_stack_pairs_framework_with_its_language(tmp_path: Path) -> None:
    tree(tmp_path, {**ZULIP_LIKE, "Dockerfile": "FROM python:3.12\n"})
    # Имя корня — из package.json (первый по старшинству манифест), стек — по Django.
    zulip = model_of(tmp_path, system=None).obj("zulip")
    assert zulip is not None and zulip.technology == "Python + Django"
    assert zulip.role == "сервис"


def test_express_only_in_dev_dependencies_sets_no_stack(tmp_path: Path) -> None:
    tree(tmp_path, {
        "package.json": '{"name": "tools", "devDependencies": {"express": "5"}}',
        "Dockerfile": "FROM node:20\n",
    })
    tools = model_of(tmp_path, system=None).obj("tools")
    assert tools is not None and tools.technology == "Node.js"


def test_backend_with_frontend_framework_is_a_service(tmp_path: Path) -> None:
    tree(tmp_path, {
        "go.mod": "module github.com/grafana/grafana\n",
        "package.json": '{"name": "grafana", "dependencies": {"react": "18"}}',
        "Dockerfile": "FROM golang:1.22\n",
    })
    grafana = model_of(tmp_path, system=None).obj("grafana")
    assert grafana is not None
    assert (grafana.technology, grafana.role) == ("Go + React", "сервис")
