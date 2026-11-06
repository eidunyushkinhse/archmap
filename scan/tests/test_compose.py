"""Разборщик compose: сервисы, слияние файлов, профили, подсказки, пределы."""

from __future__ import annotations

from pathlib import Path

from archmap_scan import texts
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
    assert sorted(u.name for u in found.units if u.dev is None) == [
        "api", "cache", "db", "legacy", "proxy", "search", "web", "worker",
    ]
    # Сервис только файла разработки — кандидат с признаком, судьбу решает сборка.
    assert [(u.name, u.dev) for u in found.units if u.dev is not None] == [
        ("mailpit", texts.dev_sign_file("docker-compose.dev.yml")),
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
    profiles = {str(h["name"]): h for h in by_section["profiles"]}
    assert profiles["adminer"]["profiles"] == ["debug"]
    assert "mailpit" not in profiles
    reasons = {(h["name"], h["reason"]) for h in by_section["unassigned"]}
    assert any(name == "legacy" and "extends" in str(r) for name, r in reasons)
    assert any(name == "worker" and "env_file" in str(r) for name, r in reasons)
    assert any(name == "compose.yaml" and "include" in str(r) for name, r in reasons)
    assert by_section["unparsed"] == [
        {
            "kind": "file", "name": "docker-compose.broken.yml",
            "reason": by_section["unparsed"][0]["reason"], "source": "docker-compose.broken.yml",
        }
    ]
    dynamic = by_section["dynamic_names"]
    assert [(h["kind"], h["object"], h["name"]) for h in dynamic] == [
        ("env", "api", "DATABASE_URL"),
    ]
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


def test_missing_build_context_is_not_code_dir(tmp_path: Path) -> None:
    """Контекст сборки, которого нет в обходе (находка фазы 1а на Grafana: путь,
    записанный относительно другого корня), каталогом кода не становится: path не
    ставится, причина — в подсказках."""
    tree(tmp_path, {
        "deploy/docker-compose.yml": (
            "services:\n"
            "  api:\n    build: ../services/api\n"
            "  ghost:\n    build:\n      context: docker/blocks/ghost\n"
        ),
        "services/api/main.py": "print('api')\n",
    })
    found = _parse(tmp_path)
    assert _unit(found, "api").build_dir == "services/api"
    ghost = _unit(found, "ghost")
    assert ghost.build_dir is None and ghost.dockerfile is None
    hints = [h.data for h in found.hints if h.section == "unassigned"]
    assert hints == [{
        "kind": "container", "name": "ghost", "reason": "каталог сборки не найден в репозитории",
        "source": "deploy/docker-compose.yml:5",
    }]


def test_files_has_dir(tmp_path: Path) -> None:
    files = Files(tmp_path, ["a/b/c.txt", "d.txt"])
    assert files.has_dir("") and files.has_dir("a") and files.has_dir("a/b")
    assert not files.has_dir("a/b/c.txt") and not files.has_dir("x")
    assert not Files(tmp_path, []).has_dir("")


def test_substitutions_with_defaults(tmp_path: Path) -> None:
    """Находка фазы 1а на Grafana: «technology: server}» из образа с подстановками.
    ${VAR:-x} и ${VAR-x} раскрываются в дефолт; оставшаяся подстановка в image —
    технологии нет, место в подсказках."""
    tree(tmp_path, {
        "docker-compose.yml": (
            "services:\n"
            "  authentik:\n"
            "    image: ${AUTHENTIK_IMAGE:-ghcr.io/goauthentik/server}:${TAG:-2024.2}\n"
            "    environment:\n"
            "      PG_URL: postgres://u:${PW-secret}@db:${PG_PORT:-5432}/x\n"
            "      OTHER: http://${HOST}:80\n"
            "    command: celery worker -Q ${QUEUES:-mail,push}\n"
            "  custom:\n    image: ${REGISTRY}/thing:1\n"
            "  bare:\n    image: $IMAGE\n"
            "  built:\n    image: ${REGISTRY}/built\n    build: .\n"
            "  nested:\n    image: ${A:-${B:-redis}}:7\n"
            "  escaped:\n    image: nginx\n    command: sh -c 'echo $$HOME ${X:?нужен}'\n"
        ),
    })
    found = _parse(tmp_path)
    auth = _unit(found, "authentik")
    assert auth.image == "ghcr.io/goauthentik/server:2024.2"
    env = {e.name: e for e in auth.env}
    assert env["PG_URL"].value == "postgres://u:secret@db:5432/x" and not env["PG_URL"].dynamic
    assert env["OTHER"].dynamic
    assert auth.command == "celery worker -Q mail,push"
    assert _unit(found, "custom").image is None and _unit(found, "bare").image is None
    assert _unit(found, "built").image is None and _unit(found, "built").build_dir == ""
    assert _unit(found, "nested").image == "redis:7"
    assert _unit(found, "escaped").command == "sh -c 'echo $$HOME ${X:?нужен}'"
    dynamic = sorted(
        (str(h.data["object"]), str(h.data["name"]))
        for h in found.hints if h.section == "dynamic_names"
    )
    assert dynamic == [("authentik", "OTHER"), ("bare", "image"), ("custom", "image")]


def test_expand_is_bounded() -> None:
    assert compose.expand("${A:-x}${B-y}${C}$D") == "xy${C}$D"
    assert compose.expand("${A:-") == "${A:-"
    assert compose.expand("${:-x}") == "${:-x}"
    deep = "${A:-" * 50 + "v" + "}" * 50
    assert "v" in compose.expand(deep)
    hostile = "${A:-" * 200_000
    assert compose.expand(hostile) == hostile


def test_expand_hostile_in_time() -> None:
    import time

    for value in ("${A}" * 60_000, "${A:-" * 60_000, "a$" * 120_000, "${A:-x" + "}" * 240_000):
        started = time.perf_counter()
        compose.expand(value)
        assert time.perf_counter() - started < 1.0
