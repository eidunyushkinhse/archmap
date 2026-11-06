"""Compose по содержимому и сервисы других репозиториев (ТЗ §13.3)."""

from __future__ import annotations

import time
from pathlib import Path

from archmap_scan import texts
from archmap_scan.model import Findings
from archmap_scan.parsers import compose
from tests.helpers import files_of, model_of, time_limit, tree

DEVSERVICES = """\
# Ignored by docker compose, used by devservices
x-service-config:
  dependencies:
    snuba:
      description: Aggregation service
      remote:
        repo_name: snuba
        branch: master
        repo_link: https://github.com/example/snuba.git
    relay:
      remote:
        repo_name: relay
    bigtable:
      description: Emulator
services:
  memcached:
    image: memcached:1.6-alpine
  spotlight:
    image: ghcr.io/example/spotlight:abc
    environment:
      - PYTHONUNBUFFERED=1
"""


def _parse(root: Path) -> Findings:
    ctx, files = files_of(root)
    return compose.parse(files, ctx)


def test_stack_file_is_compose(tmp_path: Path) -> None:
    found = _parse(tree(tmp_path, {"devservices/config.yml": DEVSERVICES}))
    assert sorted(u.name for u in found.units) == ["memcached", "spotlight"]
    assert found.notes == {"containers": [texts.compose_by_content("devservices/config.yml")]}
    repos = [h.data for h in found.hints if h.section == "external_repos"]
    assert sorted(repos, key=lambda d: str(d["name"])) == [
        {"kind": "repo", "name": "relay", "reason": texts.REASON_EXTERNAL_REPO,
         "source": "devservices/config.yml:12", "repo": "relay"},
        {"kind": "repo", "name": "snuba", "reason": texts.REASON_EXTERNAL_REPO,
         "source": "devservices/config.yml:9", "repo": "https://github.com/example/snuba.git"},
    ]


def test_services_without_image_or_build_is_not_compose(tmp_path: Path) -> None:
    found = _parse(tree(tmp_path, {
        # Перечень сервисов приложения, не compose: ни image, ни build.
        "relyance.yaml": "services:\n  payments:\n    source: [src/payments]\n",
        # services списком (GitLab CI): не словарь.
        ".gitlab-ci.yml": "services:\n  - postgres:16\n",
        # Чарт Helm: его values читает helm.py.
        "chart/Chart.yaml": "apiVersion: v2\nname: app\n",
        "chart/values.yaml": "services:\n  api:\n    image: api:1\n",
        # Манифест k8s с ключом services.
        "k8s/app.yaml": "apiVersion: v1\nkind: List\nservices:\n  a:\n    image: a\n",
        # Не разбирается как YAML: файл не compose, подсказки о нём нет.
        "broken.yml": "services:\n  a: [\n",
        "nested.yml": "x:\n  services:\n    a:\n      image: a\n",
    }))
    assert found.units == [] and found.notes == {} and found.hints == []


def test_content_compose_in_dev_dir_goes_to_hints(tmp_path: Path) -> None:
    found = _parse(tree(tmp_path, {
        "devenv/stack.yml": "services:\n  grafana:\n    image: grafana/grafana\n",
    }))
    assert found.units == []
    assert [(h.section, h.data["name"], h.data["reason"]) for h in found.hints] == [
        ("profiles", "grafana", texts.dev_manifest(texts.dev_sign_dir("devenv"))),
    ]


def test_named_compose_external_repos(tmp_path: Path) -> None:
    found = _parse(tree(tmp_path, {
        "docker-compose.yml": (
            "x-deps:\n  - repo_link: https://github.com/example/a.git\n"
            "services:\n  app:\n    build: .\n"
        ),
        "Dockerfile": "FROM python:3.12\n",
    }))
    repos = [h.data for h in found.hints if h.section == "external_repos"]
    # Словарь без ключа над собой называется своей ссылкой.
    assert repos == [{
        "kind": "repo", "name": "https://github.com/example/a.git",
        "reason": texts.REASON_EXTERNAL_REPO, "source": "docker-compose.yml:2",
        "repo": "https://github.com/example/a.git",
    }]
    assert found.notes == {}


def test_content_compose_model(tmp_path: Path) -> None:
    model = model_of(tree(tmp_path, {"devservices/config.yml": DEVSERVICES}))
    assert [(o.name, o.shape, o.technology) for o in model.objects] == [
        ("spotlight", "service", "spotlight"), ("memcached", "database", "Memcached"),
    ]
    assert [h["name"] for h in model.hints["external_repos"]] == ["snuba", "relay"]


def test_services_line_regex_is_linear(tmp_path: Path) -> None:
    started = time.perf_counter()
    found = _parse(tree(tmp_path, {
        "a.yml": "services:" + " " * 2_000_000 + "#\n",
        "b.yml": "x: " + "services:" * 200_000 + "\n",
    }))
    assert time.perf_counter() - started < time_limit()
    assert found.units == []


def test_image_services_keep_sole_owner(tmp_path: Path) -> None:
    """Сервисы на образах из compose по содержимому своего кода не имеют: единственный
    контейнер со своим кодом по-прежнему владеет кодом вне своего каталога (owners.sole_owner)."""
    model = model_of(tree(tmp_path, {
        "devservices/config.yml": DEVSERVICES,
        "self-hosted/Dockerfile": "FROM python:3.12\n",
        "pyproject.toml": '[project]\nname = "app"\ndependencies = ["fastapi"]\n',
        "src/app/api.py": (
            "from fastapi import FastAPI\n\napp = FastAPI()\n\n"
            '@app.get("/health")\ndef health():\n    return {}\n'
        ),
    }))
    assert [e.path for e in model.http["self-hosted"]] == ["/health"]
    assert not any(h["kind"] == "route" for h in model.hints.get("unassigned", []))
