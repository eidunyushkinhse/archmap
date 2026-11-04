"""Разборщик Dockerfile: стадии, ссылки на стадии, переносы, команды."""

from __future__ import annotations

from archmap_scan.parsers import dockerfile
from tests.helpers import FIXTURES, files_of


def test_fixture() -> None:
    ctx, files = files_of(FIXTURES / "dockerfile")
    found = dockerfile.parse(files, ctx)
    by_path = {d.path: d for d in found.dockerfiles}
    assert set(by_path) == {"Dockerfile-postgresql", "tools/ci/Dockerfile", "web/Dockerfile"}
    web = by_path["web/Dockerfile"]
    assert web.images == ["node:20-alpine", "nginx:1.27-alpine"]
    assert web.dir == "web" and str(web.from_loc) == "web/Dockerfile:2"
    assert web.command == "/docker-entrypoint.sh nginx -g daemon off;"
    assert str(web.command_loc) == "web/Dockerfile:8"


def test_stage_reference_and_shell_form() -> None:
    info = dockerfile.parse_text(
        "Dockerfile",
        "FROM python:3.12 AS base\nFROM base AS final\nCMD gunicorn app:wsgi\n",
    )
    assert info is not None
    assert info.images == ["python:3.12", "python:3.12"]
    assert info.command == "gunicorn app:wsgi" and str(info.command_loc) == "Dockerfile:3"


def test_entrypoint_only_and_bad_json() -> None:
    info = dockerfile.parse_text("D", "FROM go\nENTRYPOINT [not json\n")
    assert info is not None and info.command == "[not json"
    assert dockerfile.parse_text("D", "# только комментарий\nRUN x\n") is None


def test_continuation_at_end_of_file() -> None:
    info = dockerfile.parse_text("D", "FROM a\nCMD run \\")
    assert info is not None and info.command == "run"


def test_names() -> None:
    for name in ("Dockerfile", "a/Dockerfile.prod", "worker.Dockerfile", "Dockerfile-db"):
        assert dockerfile.is_dockerfile(name)
    assert not dockerfile.is_dockerfile("Dockerfiles.md")
