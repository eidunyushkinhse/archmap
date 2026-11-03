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
