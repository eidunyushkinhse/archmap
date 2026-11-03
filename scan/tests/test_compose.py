"""Разборщик compose: сервисы, слияние файлов, профили, подсказки, пределы."""

from __future__ import annotations

from pathlib import Path

from archmap_scan.model import Findings, Unit
from archmap_scan.parsers import compose
from archmap_scan.walk import Files
from archmap_scan.yamlload import MAX_YAML_BYTES
from tests.helpers import FIXTURES, files_of, tree


def _parse(root: Path) -> Findings:
    ctx, files = files_of(root)
    return compose.parse(files, ctx)


def _unit(found: Findings, name: str) -> Unit:
    return next(u for u in found.units if u.name == name)


def test_fixture_services() -> None:
    found = _parse(FIXTURES / "compose")
    assert sorted(u.name for u in found.units) == [
        "api", "cache", "db", "legacy", "proxy", "search", "web", "worker",
    ]
    api = _unit(found, "api")
    assert api.build_dir == "services/api"
    assert api.dockerfile == "services/api/Dockerfile.prod"
    assert api.command == "gunicorn api.wsgi --workers 4"
    assert api.host == "api"
    env = {e.name: e for e in api.env}
    # Якорь «<<: *env» раскрыт, поздний файл (override) добавил свою переменную.
    assert set(env) == {
        "LOG_LEVEL", "DATABASE_URL", "CACHE_URL", "SEARCH_HOST", "METRICS_PORT", "FEATURE_X",
    }
    assert env["DATABASE_URL"].dynamic and not env["CACHE_URL"].dynamic
    assert env["METRICS_PORT"].value == "9100"
    assert [d for d, _ in api.depends_on] == ["db", "worker"]
    assert str(api.loc) == "docker-compose.yml:7"
    assert [str(loc) for loc in api.extra_locs] == ["docker-compose.override.yml:2"]

    worker = _unit(found, "worker")
    assert worker.build_dir == "services/api" and worker.dockerfile == "services/api/Dockerfile"
    assert {e.name: e.value for e in worker.env} == {
        "CELERY_BROKER_URL": "redis://cache:6379/1", "DEBUG": None,
    }
    assert _unit(found, "search").image == "docker.elastic.co/elasticsearch/elasticsearch:8.13.0"


def test_fixture_hints() -> None:
    found = _parse(FIXTURES / "compose")
    by_section: dict[str, list[dict[str, object]]] = {}
    for h in found.hints:
        by_section.setdefault(h.section, []).append(h.data)
    profiles = {str(h["service"]): h for h in by_section["profiles"]}
    assert profiles["adminer"]["profiles"] == ["debug"]
    assert profiles["mailpit"]["profiles"] == []
    reasons = {(h["name"], h["reason"]) for h in by_section["unassigned"]}
    assert any(name == "legacy" and "extends" in str(r) for name, r in reasons)
    assert any(name == "worker" and "env_file" in str(r) for name, r in reasons)
    assert any(name == "compose.yaml" and "include" in str(r) for name, r in reasons)
    assert by_section["unparsed"] == [
        {"path": "docker-compose.broken.yml", "reason": by_section["unparsed"][0]["reason"]}
    ]
    dynamic = by_section["dynamic_names"]
    assert [(h["object"], h["name"]) for h in dynamic] == [("api", "DATABASE_URL")]
    # Значение подстановки в подсказки не попадает.
    assert "API_DB_PASSWORD" not in repr(by_section)


def test_compose_v1_and_lists(tmp_path: Path) -> None:
    tree(tmp_path, {
        "docker-compose.yml": (
            "web:\n  image: nginx\n  command: [nginx, -g, daemon off;]\n"
            "  environment: [A=1, B]\n  depends_on: {db: {condition: x}}\n"
            "db:\n  image: mysql:8\n"
        ),
    })
    found = _parse(tmp_path)
    web = _unit(found, "web")
    assert web.command == "nginx -g daemon off;"
    assert [(e.name, e.value) for e in web.env] == [("A", "1"), ("B", None)]
    assert [d for d, _ in web.depends_on] == ["db"]


def test_build_outside_root_and_remote(tmp_path: Path) -> None:
    tree(tmp_path, {
        "docker-compose.yml": (
            "services:\n  a:\n    build: ../elsewhere\n"
            "  b:\n    build: https://github.com/org/b.git\n"
            "  c:\n    build:\n      context: .\n"
        ),
    })
    found = _parse(tmp_path)
    assert _unit(found, "a").build_dir is None
    assert _unit(found, "b").build_dir is None
    assert _unit(found, "c").build_dir == "" and _unit(found, "c").dockerfile == "Dockerfile"
    assert any("вне области" in str(h.data["reason"]) for h in found.hints)


def test_too_large_yaml_is_refused(tmp_path: Path) -> None:
    tree(tmp_path, {"docker-compose.yml": "services: {}\n# " + "x" * MAX_YAML_BYTES + "\n"})
    ctx, files = files_of(tmp_path)
    found = compose.parse(files, ctx)
    assert found.units == [] and files.too_large == {"docker-compose.yml"}


def test_not_a_mapping(tmp_path: Path) -> None:
    tree(tmp_path, {"compose.yaml": "- a\n- b\n", "compose.dev.yaml": "services: [x]\n"})
    assert _parse(tmp_path).units == []


def test_unreadable_listed_file_is_skipped(tmp_path: Path) -> None:
    files = Files(tmp_path, ["docker-compose.yml"])
    ctx, _ = files_of(tmp_path)
    assert compose.parse(files, ctx).units == []
