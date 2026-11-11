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


def test_stage_technology() -> None:
    """Технология по образу итоговой стадии Dockerfile (ТЗ §15 п. 18 Т1): вид сервиса из
    IMAGES или программа из PROGRAM_IMAGES. Ловушки: базы и брокеры, ОС и языки,
    подстановка и имя стадии технологии сервиса не дают; Grafana и Prometheus в IMAGES не
    попали, вид по образу у сервиса compose и зависимости Helm они не меняют."""
    assert vocab.stage_technology("envoyproxy/envoy:v1.40.2@sha256:8de9") == "Envoy"
    assert vocab.stage_technology("docker.io/nginxinc/nginx-unprivileged:1.29-alpine") == "nginx"
    assert vocab.stage_technology("grafana/grafana:11.4.0") == "Grafana"
    assert vocab.stage_technology("prom/prometheus:v3.1.0") == "Prometheus"
    assert vocab.stage_technology("apache/airflow:latest") == "Airflow"
    for image in ("postgres:16", "alpine:3.24", "ubuntu:xenial", "python:3.12",
                  "registry.access.redhat.com/ubi9-micro", "${BASE_IMAGE}", "builder",
                  "grafana/grafana-agent", "prom/node-exporter"):
        assert vocab.stage_technology(image) is None, image
    assert vocab.image_kind("grafana/grafana") is None
    assert vocab.is_stack("Grafana") and vocab.is_stack("Envoy")


def test_image_technology_one_spelling() -> None:
    """Технология по образу у сервиса compose, Helm, k8s и задачи (ТЗ §15 п. 19 Т2): вид из
    IMAGES как в словаре, программа по имени образа или по организации и имени, иначе имя
    образа строчными, как раньше. Ловушки: строчное написание программы (etcd, flagd), имена
    app, node и ui без организации из словаря, программа вокруг базы (postgres-meta)."""
    assert vocab.image_technology("grafana/grafana:11.4.0") == "Grafana"
    assert vocab.image_technology("quay.io/prometheus/alertmanager:v0.24.0") == "Alertmanager"
    assert vocab.image_technology("otel/opentelemetry-collector-contrib:0.142.0") == (
        "OpenTelemetry Collector"
    )
    assert vocab.image_technology("temporalio/ui:2.47.2") == "Temporal"
    assert vocab.image_technology("docker.io/temporalio/admin-tools:1.26") == "Temporal"
    assert vocab.image_technology("jaegertracing/all-in-one:1.76.0") == "Jaeger"
    assert vocab.image_technology("timberio/vector:0.53.0-alpine") == "Vector"
    assert vocab.image_technology("nginx:1.27") == "nginx"
    assert vocab.image_technology("envoyproxy/envoy:v1.40") == "Envoy"
    assert vocab.image_technology("vectorized/redpanda:v23.2") == "Redpanda"
    for image, tech in (
        ("quay.io/coreos/etcd:v3.6.8", "etcd"), ("ghcr.io/open-feature/flagd:v0.12", "flagd"),
        ("calico/node:v3.29.0", "node"), ("sail-8.3/app", "app"), ("example/ui:1.0", "ui"),
        ("supabase/postgres-meta:v0.84", "postgres-meta"), ("jaegertracing/example-hotrod", "example-hotrod"),
    ):
        assert vocab.image_technology(image) == tech, image
    # Итоговая стадия Dockerfile даёт то же написание (Т1), ОС и базы технологии не дают.
    assert vocab.stage_technology("grafana/loki:3.7") == "Loki"
    assert vocab.stage_technology("temporalio/ui:2.47") == "Temporal"
    assert vocab.stage_technology("quay.io/coreos/etcd:v3.6") is None
    assert vocab.program("grafana/grafana") == "Grafana" and vocab.program("example/ui") is None



def test_stage_role() -> None:
    """Роль по образу итоговой стадии (ТЗ §15 п. 19 Т3): «прокси» только у видов сервиса с этой
    ролью в IMAGES; программы, ОС, базы и языки роли не дают."""
    for image in ("envoyproxy/envoy:v1.40", "nginxinc/nginx-unprivileged:1.29", "traefik:v3",
                  "haproxy:3.0"):
        assert vocab.stage_role(image) == "прокси", image
    for image in ("grafana/grafana", "redis:7", "alpine", "python:3.12", "mailhog/mailhog"):
        assert vocab.stage_role(image) is None, image


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
