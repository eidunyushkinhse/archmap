"""Разборщик Dockerfile: стадии, ссылки на стадии, переносы, команды."""

from __future__ import annotations

from archmap_scan import texts
from archmap_scan.parsers import dockerfile
from archmap_scan.walk import Excluded, list_files, template_rule
from tests.helpers import FIXTURES, ctx_of, files_of, model_of


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


def test_templates_and_name_forms() -> None:
    """Шаблон Dockerfile не Dockerfile (ТЗ §15 п. 12 С2): Dockerfile.j2 роли Ansible AWX
    (tools/ansible/roles/dockerfile/templates/Dockerfile.j2) стал объектом «j2». Такой файл
    не читается, в покрытии причина «template». Форма «<имя>.Dockerfile» равна
    «Dockerfile.<имя>»: debug.Dockerfile рядом с Dockerfile — тот же вариант разработки, что
    Dockerfile.debug. Ловушка: Dockerfile-fpm Monica (дефис) остаётся Dockerfile варианта fpm."""
    root = FIXTURES / "dockerfile-forms"
    listing = list_files(ctx_of(root))
    assert set(listing.excluded) == {
        Excluded("php/Dockerfile.template", 1, "template"),
        Excluded("roles/dockerfile/templates/Dockerfile.j2", 1, "template"),
    }
    model = model_of(root)
    assert sorted(o.name for o in model.objects) == ["api", "fpm", "worker"]
    merged = {h["name"]: (h["object"], h["reason"]) for h in model.hints["merged"]}
    assert merged == {
        "api/Dockerfile.debug": ("api", texts.REASON_DOCKERFILE_VARIANT),
        "worker/debug.Dockerfile": ("worker", texts.REASON_DOCKERFILE_VARIANT),
    }
    assert template_rule("Dockerfile.in") == "Dockerfile.in"
    assert template_rule("a/app.Dockerfile.tpl") == "a/app.Dockerfile.tpl"
    assert template_rule("supervisor.conf.template") is None
    assert template_rule("Dockerfile-fpm") is None


def test_language_by_last_stage() -> None:
    """Язык по образу у последней стадии (ТЗ §15 п. 12 С4): scripts/docker/Dockerfile-fpm
    Monica собирает ресурсы на node:22 (стадия yarn), а итоговый образ php:8.3-fpm, и
    объект fpm получил Node.js. Стадии сборки язык не задают. Ловушки: одностадийный
    node:22 остаётся Node.js; последняя стадия scratch или alpine языка не задаёт, тогда язык
    у предыдущей стадии с языком (Go-бинарь из builder)."""
    model = model_of(FIXTURES / "dockerfile-stages")
    kinds = {o.name: o.technology for o in model.objects}
    assert kinds == {"fpm": "PHP", "web": "Node.js", "gosvc": "Go", "edge": "Go"}
