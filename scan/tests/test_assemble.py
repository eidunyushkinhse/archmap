"""Сборка схемы: вид объектов, связи, источники, Dockerfile без манифеста."""

from __future__ import annotations

from pathlib import Path

from archmap_scan.assemble import Model, Obj
from tests.helpers import FIXTURES, model_of, tree


def _obj(model: Model, name: str) -> Obj:
    obj = model.obj(name)
    assert obj is not None, name
    return obj


def _links(model: Model) -> set[tuple[str, str, str | None]]:
    return {(lk.src.name, lk.dst.name, lk.technology) for lk in model.links}


def test_compose_fixture_model() -> None:
    model = model_of(FIXTURES / "compose")
    kinds = {o.name: (o.shape, o.technology, o.role) for o in model.objects}
    assert kinds == {
        "api": ("service", "Python", "сервис"),
        "worker": ("service", None, "воркер"),
        "legacy": ("service", "legacy-tool", "сервис"),
        "proxy": ("service", "Traefik", "прокси"),
        "web": ("service", "nginx", "прокси"),
        "db": ("database", "PostgreSQL", "БД"),
        "search": ("database", "Elasticsearch", "БД"),
        # CELERY_BROKER_URL указывает на Redis: это брокер задач, а не кэш.
        "cache": ("broker", "Redis", "брокер"),
    }
    # DATABASE_URL с подстановкой не даёт адреса, но depends_on к базе связь рисует.
    assert _links(model) == {
        ("api", "cache", "Redis"),
        ("api", "db", "PostgreSQL"),
        ("api", "search", "Elasticsearch"),
        ("worker", "cache", "Redis"),
    }
    assert model.hints["depends_on"][0]["to"] == "worker"
    # api и worker собраны из одного каталога: пути к коду нет ни у кого.
    assert _obj(model, "api").path is None and _obj(model, "worker").path is None
    assert model.hints["shared_code"] == [{
        "path": "services/api/", "containers": ["api", "worker"],
        "reason": model.hints["shared_code"][0]["reason"],
    }]
    assert [o.name for o in model.objects][:5] == ["api", "legacy", "proxy", "web", "worker"]


def test_unique_code_dir_and_root_container(tmp_path: Path) -> None:
    tree(tmp_path, {
        "docker-compose.yml": "services:\n  app:\n    build: .\n  db:\n    image: mysql\n",
        "Dockerfile": "FROM golang:1.22\n",
    })
    model = model_of(tmp_path)
    app = _obj(model, "app")
    assert app.code_dir == "" and app.path is None and app.technology == "Go"
    assert app.dockerfile is not None
    assert _links(model) == set()


def test_standalone_dockerfiles(tmp_path: Path) -> None:
    tree(tmp_path, {
        "services/orders/Dockerfile": "FROM python:3.12\nCMD python -m orders\n",
        "services/orders/Dockerfile.worker": "FROM python:3.12\nCMD celery worker\n",
        "Dockerfile-postgresql": "FROM zulip/zulip-postgresql:14\n",
        "tools/ci/Dockerfile": "FROM ubuntu\n",
        ".devcontainer/Dockerfile": "FROM ubuntu\n",
        "Dockerfile": "FROM node:20\n",
    })
    model = model_of(tmp_path, system="Ярмарка")
    kinds = {o.name: (o.shape, o.technology, o.role, o.code_dir) for o in model.objects}
    assert kinds == {
        "orders": ("service", "Python", "сервис", "services/orders"),
        "worker": ("service", "Python", "воркер", "services/orders"),
        "Ярмарка": ("service", "Node.js", "сервис", ""),
        "postgresql": ("database", "PostgreSQL", "БД", ""),
    }
    dev = {str(h["service"]) for h in model.hints["profiles"]}
    assert dev == {"tools/ci/Dockerfile", ".devcontainer/Dockerfile"}


def test_service_links_and_dynamic(tmp_path: Path) -> None:
    tree(tmp_path, {
        "docker-compose.yml": (
            "services:\n"
            "  front:\n    image: ghcr.io/org/front:1\n"
            "    environment:\n"
            "      API_URL: http://back:8080\n"
            "      GRPC_ADDR: back:9000\n"
            "      SELF_URL: http://front\n"
            "      OTHER: ${X}\n"
            "  back:\n    image: ghcr.io/org/back:1\n"
            "    environment: [RQ_REDIS_URL=redis://queue:6379, CACHE_HOST=memo]\n"
            "  queue:\n    image: redis\n"
            "  memo:\n    image: memcached\n"
        ),
    })
    model = model_of(tmp_path)
    assert _links(model) == {
        ("front", "back", "HTTP"),
        ("back", "queue", "Redis"),
        ("back", "memo", "Memcached"),
    }
    front_back = next(lk for lk in model.links if lk.src.name == "front")
    assert {str(loc) for loc in front_back.locs} == {"docker-compose.yml:5", "docker-compose.yml:6"}
    assert _obj(model, "queue").shape == "broker"
    assert _obj(model, "memo").role == "кэш"


def test_technology_from_manifests_and_frontend(tmp_path: Path) -> None:
    tree(tmp_path, {
        "docker-compose.yml": "services:\n  storefront:\n    build: ./frontend\n",
        "frontend/package.json": '{"name": "storefront", "dependencies": {"react": "18"}}',
        "frontend/Dockerfile": "FROM node:20 AS b\nFROM nginx\n",
    })
    store = _obj(model_of(tmp_path), "storefront")
    assert (store.technology, store.role) == ("Node.js + React", "фронтенд")
    assert {str(loc) for loc in store.locs} == {
        "docker-compose.yml:2", "frontend/Dockerfile:1", "frontend/package.json:1",
    }


def test_workspace_dir_for_image_only_workload(tmp_path: Path) -> None:
    tree(tmp_path, {
        "k8s/orders.yaml": (
            "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: orders\nspec:\n"
            "  template:\n    spec:\n      containers:\n        - image: ghcr.io/org/orders:1\n"
        ),
        "services/orders/pyproject.toml": '[project]\nname = "orders"\ndependencies = ["fastapi"]\n',
    })
    orders = _obj(model_of(tmp_path), "orders")
    assert orders.code_dir == "services/orders" and orders.path == "services/orders"
    assert orders.technology == "Python + FastAPI"


def test_implicit_container(tmp_path: Path) -> None:
    tree(tmp_path, {
        "pyproject.toml": '[project]\nname = "notes"\ndependencies = ["flask", "redis"]\n',
        ".env.example": "PORT=8000\n",
    })
    model = model_of(tmp_path, system=None)
    assert model.system == "notes" and model.implicit
    notes = _obj(model, "notes")
    assert notes.technology == "Python + Flask" and notes.code_dir == ""
    assert list(model.params["notes"]) == ["PORT"]
    assert model.hints["clients"] == [{
        "container": "notes", "library": "redis", "kind": "Redis",
        "source": "pyproject.toml:2",
    }]


def test_no_manifests_no_implicit_container(tmp_path: Path) -> None:
    tree(tmp_path, {"main.c": "int main(){}\n"})
    model = model_of(tmp_path, system=None)
    assert model.objects == [] and model.system == tmp_path.name


def test_depends_on_hint_only_without_edge(tmp_path: Path) -> None:
    tree(tmp_path, {
        "docker-compose.yml": (
            "services:\n"
            "  web:\n    build: web\n    environment: [API=http://api:8080]\n"
            "    depends_on: [api, auth]\n"
            "  api:\n    build: api\n"
            "  auth:\n    build: auth\n"
        ),
    })
    model = model_of(tmp_path)
    assert _links(model) == {("web", "api", "HTTP")}
    assert [(h["from"], h["to"]) for h in model.hints["depends_on"]] == [("web", "auth")]
