"""Враждебный вход (ТЗ §9): строка в 2 МБ, глубокая вложенность и бомба YAML у каждого
разборщика. Каждый укладывается в секунду и не падает."""

from __future__ import annotations

from functools import partial
from pathlib import Path

import pytest
import yaml

from archmap_scan import registry
from archmap_scan.scan import Options, run
from tests.helpers import files_of, timed, tree

PAYLOAD = 2_000_000
A = "a" * PAYLOAD

# Файлы, которые читает хотя бы один разборщик: имя → (префикс, суффикс) правдоподобного
# начала, чтобы разбор дошёл до содержимого, а не отсеялся по первой строке.
CANDIDATES: dict[str, tuple[str, str]] = {
    "docker-compose.yml": ("services:\n  web:\n    image: ", "\n"),
    "Dockerfile": ("FROM ", "\n"),
    "Procfile": ("web: ", "\n"),
    "deploy/supervisord.conf": ("[program:x]\ncommand=", "\n"),
    "deploy/app.service": ("[Service]\nExecStart=", "\n"),
    "k8s/app.yaml": ("apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ", "\n"),
    "chart/Chart.yaml": ("apiVersion: v2\nname: ", "\n"),
    "chart/values.yaml": ("image:\n  repository: ", "\n"),
    "package.json": ('{"name": "', '"}'),
    "pyproject.toml": ('[project]\nname = "', '"\n'),
    "requirements.txt": ("", "\n"),
    "Pipfile": ("[packages]\n", " = '*'\n"),
    "go.mod": ("module ", "\n"),
    "Cargo.toml": ('[package]\nname = "', '"\n'),
    "pom.xml": ("<project><artifactId>", "</artifactId></project>"),
    "build.gradle": ("implementation '", "'\n"),
    "Gemfile": ("gem '", "'\n"),
    "composer.json": ('{"require": {"', '": "*"}}'),
    "mix.exs": ("{:", ", \"~> 1.0\"}\n"),
    "services/web/.env.example": ("A=", "\n"),
    "db/migrations/V1__init.sql": ("CREATE TABLE t (", ")\n"),
    "alembic/env.py": ("", ""),
    "alembic/versions/a.py": ("revision = 'a'\ndown_revision = None\ndef upgrade():\n    op.execute('", "')\n"),
    "app/migrations/0001_init.py": ("class Migration:\n    operations = ['", "']\n"),
    "api/openapi.yaml": ("openapi: 3.0.0\npaths:\n  /p: ", "\n"),
    "ops/crontab": ("* * * * * ", "\n"),
    # Схема Rails, патч kustomize, NetworkPolicy и конфигурация прокси (ТЗ §15 п. 14).
    "db/schema.rb": (
        'ActiveRecord::Schema[8.0].define(version: 1) do\n  create_table "t", force: :cascade'
        ' do |t|\n    t.string "', '"\n  end\nend\n',
    ),
    "k8s/kustomization.yaml": (
        "patches:\n- patch: |-\n    apiVersion: apps/v1\n    kind: Deployment\n    metadata:\n"
        "      name: ", "\n",
    ),
    "k8s/policy.yaml": (
        "apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: p\nspec:\n"
        "  podSelector:\n    matchLabels:\n      app: ", "\n",
    ),
    "proxy/compose.yaml": (
        "services:\n  proxy:\n    image: nginx\n    volumes:\n      - ./nginx.conf:/etc/n.conf\n"
        "    environment:\n      CADDYFILE: |\n        reverse_proxy ", "\n",
    ),
    "proxy/nginx.conf": ("upstream a {\n    server ", ";\n}\n"),
}


def _variant(kind: str) -> dict[str, str | bytes]:
    files: dict[str, str | bytes] = {}
    for name, (head, tail) in CANDIDATES.items():
        if kind == "line":
            files[name] = A
        elif kind == "prefixed":
            files[name] = head + A + tail
        else:  # глубокая вложенность скобок: JSON, YAML-поток, Python, TOML, SQL
            files[name] = head + "[" * (PAYLOAD // 2) + tail
    return files


@pytest.mark.parametrize("kind", ["line", "prefixed", "nested"])
def test_every_parser_survives_in_a_second(tmp_path: Path, kind: str) -> None:
    tree(tmp_path, _variant(kind))
    ctx, files = files_of(tmp_path)
    for spec in registry.PARSERS:
        _found, took = timed(partial(spec.parse, files, ctx), 1.0)
        assert took < 1.0, f"{spec.name}: {took:.2f} с"


def test_yaml_bomb_and_whole_run(tmp_path: Path) -> None:
    bomb = "a: &a [x, x, x, x, x, x, x, x, x]\n" + "".join(
        f"{c}: &{c} [*{p}, *{p}, *{p}, *{p}, *{p}, *{p}, *{p}, *{p}, *{p}]\n"
        for p, c in zip("abcdefgh", "bcdefghi", strict=True)
    )
    indented = "".join("  " + line + "\n" for line in bomb.splitlines())
    tree(tmp_path / "repo", {
        "docker-compose.yml": bomb,
        "docker-compose.prod.yml": (
            "x-bomb:\n" + indented + "services:\n  web:\n    image: nginx\n"
            "    environment: *i\n    command: *i\n    depends_on: *i\n"
        ),
        "k8s/bomb.yaml": "apiVersion: v1\nkind: ConfigMap\n" + bomb,
        "chart/Chart.yaml": "apiVersion: v2\nname: x\n",
        "chart/values.yaml": bomb,
        "api/openapi.yaml": "openapi: 3.0.0\n" + bomb,
        "package.json": "[" * 1_000_000,
    })
    options = Options(path=str(tmp_path / "repo"), out=str(tmp_path / "out"), use_git=False)
    assert timed(partial(run, options), 2.0)[1] < 2.0
    coverage = yaml.safe_load((tmp_path / "out" / "coverage.yaml").read_text(encoding="utf-8"))
    assert all(f["status"] != "error" for f in coverage["families"].values())
    hints = yaml.safe_load((tmp_path / "out" / "agent" / "hints.yaml").read_text(encoding="utf-8"))
    # Бомба отвергается пределом раскрытых псевдонимов: файл назван, разбор не начат.
    assert sorted(h["name"] for h in hints["unparsed"]) == [
        "api/openapi.yaml", "chart/values.yaml", "docker-compose.prod.yml",
        "docker-compose.yml", "k8s/bomb.yaml", "package.json",
    ]
