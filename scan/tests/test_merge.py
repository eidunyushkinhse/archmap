"""Склейка дублей контейнеров (ТЗ §13.5): один процесс в двух манифестах."""

from __future__ import annotations

from pathlib import Path

from archmap_scan import texts
from tests.helpers import model_of, tree

GO_SERVER = (
    'package main\n\nimport "net/http"\n\nfunc main() {\n'
    '\thttp.HandleFunc("/api/health", h)\n}\n'
)
UNIT = "[Unit]\nDescription=Grafana\n\n[Service]\nExecStart=/usr/share/grafana/bin/grafana server\n"


def _grafana(root: Path) -> Path:
    return tree(root, {
        "go.mod": "module github.com/example/grafana\n",
        "Dockerfile": "FROM golang:1.26 AS build\nFROM alpine:3.24\nENTRYPOINT [\"/run.sh\"]\n",
        "pkg/server/server.go": GO_SERVER,
        "packaging/deb/systemd/grafana-server.service": UNIT,
        "packaging/rpm/systemd/grafana-server.service": UNIT,
    })


def test_dockerfile_and_systemd_are_one_container(tmp_path: Path) -> None:
    # Имя системы из go.mod: корневой Dockerfile даёт контейнер grafana.
    model = model_of(_grafana(tmp_path), system=None)
    assert [o.name for o in model.objects] == ["grafana"]
    grafana = model.objects[0]
    assert grafana.parsers == ["dockerfile", "systemd"]
    assert grafana.technology == "Go" and grafana.dockerfile is not None
    # Источники обоих: Dockerfile и оба юнита systemd.
    assert sorted(str(loc) for loc in grafana.locs) == [
        "Dockerfile:1", "Dockerfile:3", "go.mod:1",
        "packaging/deb/systemd/grafana-server.service:4",
        "packaging/deb/systemd/grafana-server.service:5",
        "packaging/rpm/systemd/grafana-server.service:4",
        "packaging/rpm/systemd/grafana-server.service:5",
    ]
    assert model.hints["merged"] == [{
        "kind": "container", "name": "grafana-server", "object": "grafana",
        "reason": texts.REASON_MERGED,
        "source": ["Dockerfile:1", "packaging/deb/systemd/grafana-server.service:5"],
    }]
    # Каталог кода больше не общий: маршруты достаются контейнеру.
    assert "shared_code" not in model.hints
    assert [e.path for e in model.http["grafana"]] == ["/api/health"]


def test_shorter_name_without_dockerfile(tmp_path: Path) -> None:
    model = model_of(tree(tmp_path, {
        "go.mod": "module example.com/app\n",
        "main.go": "package main\n\nfunc main() {}\n",
        "deploy/app-server.service": "[Service]\nExecStart=/usr/local/bin/app serve\n",
        "deploy/supervisord.conf": "[program:app]\ncommand=/usr/local/bin/app\n",
    }))
    assert [o.name for o in model.objects] == ["app"]
    assert model.objects[0].parsers == ["supervisor", "systemd"]
    assert [(h["name"], h["object"]) for h in model.hints["merged"]] == [("app-server", "app")]


def test_no_merge_without_command_match(tmp_path: Path) -> None:
    """Zulip: Dockerfile-postgresql без каталога кода и программы supervisor, команды которых
    не запускают программу с именем другого контейнера."""
    model = model_of(tree(tmp_path, {
        "pyproject.toml": '[project]\nname = "zulip"\ndependencies = ["django"]\n',
        "Dockerfile": "FROM python:3.12\nCMD [\"uwsgi\"]\n",
        "Dockerfile-postgresql": "FROM postgres:16\nCMD [\"postgres\"]\n",
        "puppet/supervisor/zulip.conf": (
            "[program:zulip-django]\ncommand=/home/zulip/deployments/current/manage.py runserver\n"
            "[program:postgresql]\ncommand=/usr/lib/postgresql/16/bin/postgres\n"
        ),
    }))
    names = sorted(o.name for o in model.objects)
    assert "postgresql" in names and "zulip-django" in names
    assert "merged" not in model.hints


def test_same_manifest_family_not_merged(tmp_path: Path) -> None:
    model = model_of(tree(tmp_path, {
        "go.mod": "module example.com/grafana\n",
        "main.go": "package main\n\nfunc main() {}\n",
        "deploy/grafana.service": "[Service]\nExecStart=/usr/bin/grafana cli\n",
        "deploy/grafana-server.service": "[Service]\nExecStart=/usr/bin/grafana server\n",
    }))
    assert sorted(o.name for o in model.objects) == ["grafana", "grafana-server"]
    assert "merged" not in model.hints
