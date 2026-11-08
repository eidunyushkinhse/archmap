"""Словари: образы, языки, фреймворки, клиенты, роли по команде."""

from __future__ import annotations

from archmap_scan import vocab


def test_image_name_and_kind() -> None:
    assert vocab.image_name("ghcr.io/org/thing:1.2") == "thing"
    assert vocab.image_name("postgres@sha256:abc") == "postgres"
    kafka = vocab.image_kind("confluentinc/cp-kafka:7.6")
    assert kafka is not None and kafka.shape == "broker" and kafka.technology == "Kafka"
    pg = vocab.image_kind("zulip/zulip-postgresql:14")
    assert pg is not None and pg.technology == "PostgreSQL"
    assert vocab.image_kind("prometheuscommunity/postgres-exporter") is None
    assert vocab.image_kind("unknown/thing") is None
    # Организация, тег и хвост сборки не мешают опознанию.
    for image in ("bitnami/postgresql:16", "postgres-alpine", "library/postgres:16-alpine",
                  "groonga/pgroonga:latest-alpine-14-slim", "org/postgis-bookworm:3"):
        found = vocab.image_kind(image)
        assert found is not None and found.technology == "PostgreSQL", image
    redis = vocab.image_kind("redis-bookworm")
    assert redis is not None and redis.technology == "Redis"
    assert vocab.image_kind("grafana/mimir-alpine") is None
    assert vocab.image_kind("alpine") is None
    # Программы вокруг базы или брокера со словом словаря в имени вида не получают (И3).
    for image in ("provectuslabs/kafka-ui", "supabase/postgres-meta", "strimzi/kafka-connect",
                  "cgr.dev/chainguard/minio-client", "clickhouse/clickhouse-keeper",
                  "opensearchproject/opensearch-dashboards", "natsio/nats-box"):
        assert vocab.image_kind(image) is None, image


def test_image_language() -> None:
    assert vocab.image_language("python:3.12-slim") == "Python"
    assert vocab.image_language("node:20") == "Node.js"
    assert vocab.image_language("mcr.microsoft.com/dotnet/aspnet:8.0") == ".NET"
    assert vocab.image_language("nginx") is None


def test_frameworks_and_clients() -> None:
    deps = ("fastapi", "starlette", "kafka-python", "psycopg2-binary")
    assert vocab.find_framework(deps, vocab.SERVER_FRAMEWORKS) == "FastAPI"
    assert vocab.find_framework(("github.com/go-chi/chi/v5",), vocab.SERVER_FRAMEWORKS) == "chi"
    assert vocab.find_framework(("spring-boot-starter-web",), vocab.SERVER_FRAMEWORKS) == (
        "Spring Boot"
    )
    assert vocab.find_framework(("react-dom",), vocab.FRONTEND_FRAMEWORKS) is None
    assert vocab.clients_of(deps) == [("psycopg2-binary", "PostgreSQL"), ("kafka-python", "Kafka")]
    assert vocab.technology("Python", "FastAPI") == "Python + FastAPI"
    assert vocab.technology(None, None) is None


def test_role_by_command() -> None:
    assert vocab.role_by_command("celery -A billing worker -Q q") == vocab.ROLE_WORKER
    assert vocab.role_by_command("celery -A billing beat") == vocab.ROLE_SCHEDULER
    assert vocab.role_by_command("uvicorn app:app") is None
    assert vocab.role_by_command(None) is None


def test_dev_commands_and_tools() -> None:
    """Команды и инструменты разработки (ТЗ §15 п. 12 С6а, С6б). Ловушки: bundle exec
    sidekiq, bundle exec rails server, vite build и образы наблюдаемости разработкой не
    считаются; browserless остаётся боевым (воркер PostHog рендерит им в hobby)."""
    assert vocab.dev_command("npm ci && npm run start") == "npm ci"
    assert vocab.dev_command("pnpm install --frozen-lockfile") == "pnpm install"
    assert vocab.dev_command("composer install") == "composer install"
    assert vocab.dev_command("python -m pip install -r requirements.txt") == "pip install"
    assert vocab.dev_command("npx next dev -p 3000") == "next dev"
    assert vocab.dev_command("vite --host") == "vite"
    assert vocab.dev_command("bundle exec rspec spec/system") == "rspec"
    assert vocab.dev_command("tail -f /dev/null") == "tail -f /dev/null"
    for command in ("bundle exec sidekiq", "bundle exec rails server", "vite build", None):
        assert vocab.dev_command(command) is None
    assert vocab.dev_tool("dpage/pgadmin4:8") == "pgadmin"
    assert vocab.dev_tool("selenium/standalone-chrome") == "selenium"
    assert vocab.dev_tool("provectuslabs/kafka-ui:latest") == "kafka-ui"
    for image in ("jaegertracing/all-in-one", "prom/prometheus", "grafana/grafana",
                  "minio/minio", "ghcr.io/browserless/chromium", "redis:7"):
        assert vocab.dev_tool(image) is None
