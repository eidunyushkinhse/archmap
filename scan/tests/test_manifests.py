"""Манифесты сборки: имена, зависимости, языки, стеки без разборщика."""

from __future__ import annotations

import importlib.util
import sys
import time
from pathlib import Path

import pytest
import yaml

from archmap_scan import stats
from archmap_scan.model import Package
from archmap_scan.parsers import manifests
from archmap_scan.scan import Options, run
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
    # pip-compile: «# via пакет» — транзитивная зависимость, «# via -r файл» — прямая.
    assert pkgs["loadgen/requirements.txt"].deps == ("faker", "locust", "psycopg")
    assert pkgs["pipsvc/Pipfile"].deps == ("flask", "redis")
    go = pkgs["gosvc/go.mod"]
    assert go.name == "github.com/org/shop/gosvc/v2" and go.language == "Go"
    # Зависимости с пометкой «// indirect» транзитивные: ни pgx, ни viper (ТЗ §15 п. 10 А12).
    assert go.deps == ("github.com/go-chi/chi/v5", "github.com/ibm/sarama")
    assert pkgs["rs/Cargo.toml"].deps == ("axum", "tokio")
    java = pkgs["javasvc/pom.xml"]
    assert java.name == "shop-java" and str(java.name_loc) == "javasvc/pom.xml:7"
    assert java.deps == ("spring-boot-starter-parent", "spring-kafka")
    assert pkgs["kt/build.gradle.kts"].deps == ("postgresql", "spring-boot")
    assert pkgs["rb/Gemfile"].deps == ("rails", "pg", "sidekiq", "sidekiq-scheduler")
    cart = pkgs["dotnet/Cart.csproj"]
    assert cart.language == ".NET" and cart.deps == ("microsoft.net.sdk.web", "grpc.aspnetcore", "npgsql")
    assert pkgs["dotnet/Cart.sln"].language == ".NET"
    assert pkgs["php/composer.json"].deps == ("laravel/framework",)
    ex = pkgs["ex/mix.exs"]
    assert ex.name == "shop_ex" and ex.deps == ("phoenix", "ecto_sql")
    assert "broken/package.json" not in pkgs


def test_markers_and_unparsed() -> None:
    ctx, files = files_of(FIXTURES / "manifests")
    found = manifests.parse(files, ctx)
    # crontab читает свой разборщик: в «не умею» остался только Prisma.
    assert found.unsupported == {"tables": ["Prisma"]}
    assert [h.data["name"] for h in found.hints] == ["broken/package.json"]


def test_code_unsupported_stacks() -> None:
    ctx, files = files_of(FIXTURES / "manifests")
    found = manifests.parse(files, ctx)
    stacks = stats.code_unsupported(found)
    # Маршруты FastAPI, Flask, Django и chi читает ярус кода: в «не умею» их нет. Фреймворк
    # языка, код на котором сборщик не читает, назван с языком (ТЗ §15 п. 10 А12); язык без
    # известного фреймворка назван сам (.NET), а не пропущен.
    assert stacks["http_routes"] == [
        ".NET", "Elixir: Phoenix", "Java: Spring Boot", "PHP: Laravel", "Ruby: Rails",
        "Rust: actix-web",
    ]
    # Параметры в коде Python, Node.js и Go читает ярус кода; viper только транзитивный.
    assert stacks["config"] == [".NET", "Elixir", "Java", "PHP", "Ruby", "Rust"]
    # Каналы Celery, Kafka, RabbitMQ и NATS читает ярус кода; BullMQ на Node.js и Sidekiq
    # на Ruby — нет, как и любые каналы на языках без чтения кода.
    assert stacks["channels"] == [".NET", "BullMQ", "Elixir", "Java", "PHP", "Ruby: Sidekiq", "Rust"]
    assert stacks["workers"] == [".NET", "BullMQ", "Elixir", "Java", "PHP", "Ruby: Sidekiq", "Rust"]
    # Расписания Celery beat читает разборщик celery-beat.
    assert stacks["schedules"] == [
        ".NET", "Elixir", "Java", "PHP", "Ruby: sidekiq-scheduler", "Rust: clokwerk",
    ]
    assert stacks["tables"] == ["Ecto", "Kysely"]


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
    # Ветка tomllib (3.11+) проверяется только там, где он есть: на Python 3.10 (джоба CI
    # scan) подмена версии на 3.12 привела бы к импорту модуля, которого нет.
    versions = [(3, 10, 0, "final", 0)]
    if importlib.util.find_spec("tomllib") is not None:
        versions.insert(0, (3, 12, 0, "final", 0))
    for version in versions:
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


def test_transitive_requirement_sets_no_framework(tmp_path: Path) -> None:
    """Flask с пометкой «# via locust» не делает генератор нагрузки «Python + Flask»
    (Online Boutique, ТЗ §15 п. 10 А7); requirements.txt без пометок — как прежде."""
    root = tree(tmp_path, {
        "docker-compose.yml": (
            "services:\n  loadgen:\n    build: loadgen\n  web:\n    build: web\n"
        ),
        "loadgen/Dockerfile": "FROM python:3.12\n",
        "loadgen/requirements.txt": "flask==3.1.3\n    # via locust\nlocust==2.42.0\n"
                                    "    # via -r requirements.in\n",
        "web/Dockerfile": "FROM python:3.12\n",
        "web/requirements.txt": "flask==3.1.3\ngunicorn==22.0.0\n",
    })
    model = model_of(root)
    tech = {o.name: o.technology for o in model.objects}
    assert tech == {"loadgen": "Python", "web": "Python + Flask"}


def test_unsupported_only_from_container_code(tmp_path: Path) -> None:
    """Стек в coverage называется только по манифесту кода контейнера: Gemfile и Cargo.toml
    мобильного приложения (immich: mobile/, native/) контейнеров не касаются. При опознанном
    Rust семьи кода — unsupported с именем стека, а не «стек не опознан» (ТЗ §15 п. 10 А12)."""
    root = tree(tmp_path, {
        "docker-compose.yml": "services:\n  server:\n    build: server\n  forum:\n    build: forum\n",
        "server/Dockerfile": "FROM node:22\n",
        "server/package.json": '{"name": "server", "dependencies": {"bullmq": "5", "kysely": "0.27"}}',
        "forum/Dockerfile": "FROM rust:1.85\n",
        "forum/Cargo.toml": '[package]\nname = "forum"\n[dependencies]\nactix-web = "4"\n',
        "mobile/ios/Gemfile": 'gem "fastlane"\n',
        "native/Cargo.toml": '[package]\nname = "codecs"\n[dependencies]\nrayon = "1"\n',
    })
    out = tmp_path / "out"
    run(Options(path=str(root), out=str(out), system="Ярмарка", use_git=False))
    families = yaml.safe_load((out / "coverage.yaml").read_text(encoding="utf-8"))["families"]
    assert families["http_routes"]["unsupported"] == ["Rust: actix-web"]
    assert families["config"]["unsupported"] == ["Rust"]
    assert families["channels"] == {"status": "unsupported", "parsers": [],
                                    "unsupported": ["BullMQ", "Rust"]}
    assert families["workers"]["status"] == "unsupported"
    assert families["workers"]["unsupported"] == ["BullMQ", "Rust"]
    assert families["tables"]["unsupported"] == ["Kysely"]
    summary = (out / "summary.txt").read_text(encoding="utf-8")
    assert "Rust (actix-web)" in summary and "Ruby" not in summary


def test_unbounded_containers_name_every_stack(tmp_path: Path) -> None:
    """Контейнеры по файлам сборки (Zabbix: программы Makefile.am) границу системы не задают:
    стек PHP интерфейса ui/ без своего контейнера называется в config, как до А12, а не
    прячется за «искали и не нашли». Ловушка (test_unsupported_only_from_container_code):
    при контейнерах из compose чужой Cargo.toml не называется."""
    out = tmp_path / "out"
    run(Options(path=str(FIXTURES / "buildfiles-php"), out=str(out), system="Ярмарка",
                use_git=False))
    families = yaml.safe_load((out / "coverage.yaml").read_text(encoding="utf-8"))["families"]
    assert families["containers"]["parsers"] == ["buildfiles"]
    assert "PHP" in families["config"]["unsupported"]
    assert families["config"]["status"] == "unsupported"


def test_known_language_family_is_empty_not_unknown(tmp_path: Path) -> None:
    """Контейнер на Python без брокерного клиента и веб-фреймворка: каналы и маршруты
    «пусто» (зависимости проверены), а не «стек не опознан». Без языка контейнеров (только
    образы) — по-прежнему «не опознан» (ТЗ §15 п. 10 А12)."""
    root = tree(tmp_path / "py", {
        "docker-compose.yml": "services:\n  job:\n    build: job\n",
        "job/Dockerfile": "FROM python:3.12\n",
        "job/requirements.txt": "requests\n",
    })
    out = tmp_path / "out"
    run(Options(path=str(root), out=str(out), system="Ярмарка", use_git=False))
    families = yaml.safe_load((out / "coverage.yaml").read_text(encoding="utf-8"))["families"]
    assert families["channels"]["status"] == "empty"
    assert families["channels"]["parsers"] == ["celery", "kafka", "rabbitmq", "nats"]
    assert families["http_routes"]["status"] == "empty"

    images = tree(tmp_path / "img", {"docker-compose.yml": "services:\n  cache:\n    image: redis:7\n"})
    out2 = tmp_path / "out2"
    run(Options(path=str(images), out=str(out2), system="Ярмарка", use_git=False))
    families = yaml.safe_load((out2 / "coverage.yaml").read_text(encoding="utf-8"))["families"]
    assert families["channels"]["status"] == "unknown"
