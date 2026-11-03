"""Параметры конфигурации из кода (ТЗ §6.2): Python, Node, Go по фикстурам и слияние с
параметрами манифестов (дефолт из кода, секреты, required, общий код)."""

from __future__ import annotations

from pathlib import Path

from archmap_scan import texts
from archmap_scan.parsers import goenv, nodeenv, pyenv
from tests.helpers import FIXTURES, files_of, model_of, tree

Row = tuple[str, str | None, bool, bool | None, str | None, str]


def _params(parser: object, root: Path) -> list[Row]:
    ctx, files = files_of(root)
    found = parser.parse(files, ctx)  # type: ignore[attr-defined]
    rows = [
        (p.name, p.default, p.has_default, p.required, p.type, str(p.loc))
        for p in found.code_params
    ]
    return sorted(rows, key=lambda r: (r[0], r[5]))


def test_python_fixture() -> None:
    assert _params(pyenv, FIXTURES / "python-env") == [
        ("ALLOWED_HOSTS", None, True, None, None, "app/settings.py:10"),
        ("APP_API_KEY", "dev-key-not-for-output", True, None, "string", "app/settings.py:32"),
        ("APP_DEBUG", "false", True, None, "bool", "app/settings.py:39"),
        ("APP_PORT", "8000", True, None, "int", "app/settings.py:30"),
        ("APP_TAGS", None, True, None, None, "app/settings.py:34"),
        ("APP_TIMEOUT", None, True, None, "duration", "app/settings.py:31"),
        ("CACHE_TTL", "60", True, None, "int", "app/settings.py:13"),
        ("DATABASE_URL", None, False, True, "string", "app/settings.py:14"),
        ("DEBUG", "false", True, None, "bool", "app/settings.py:10"),
        ("DEBUG", None, False, True, "string", "app/settings.py:12"),
        ("DJANGO_SETTINGS_MODULE", "app.settings", True, None, "string", "app/settings.py:20"),
        ("FAST_MODE", "true", True, None, "bool", "app/settings.py:17"),
        ("HOME_DIR", "/srv", True, None, "string", "app/settings.py:18"),
        ("REGION", None, False, None, None, "app/settings.py:19"),
        ("SECRET_KEY", None, False, True, None, "app/settings.py:21"),
        ("SENTRY_DSN", "", True, None, None, "app/settings.py:15"),
        ("SERVICE_NAME", None, False, True, "string", "app/settings.py:33"),
        ("WORKERS", None, False, True, "int", "app/settings.py:16"),
    ]
    ctx, files = files_of(FIXTURES / "python-env")
    hints = pyenv.parse(files, ctx).hints
    assert [(h.data["name"], h.data["source"]) for h in hints] == [
        ("'PREFIX_' + REGION", "app/settings.py:24"),
    ]


def test_node_fixture() -> None:
    assert _params(nodeenv, FIXTURES / "node-env") == [
        ("API_TOKEN", "dev-token-not-for-output", True, None, "string", "src/config.ts:5"),
        ("DEBUG", None, False, None, None, "src/config.ts:4"),
        ("HOST", "0.0.0.0", True, None, "string", "src/config.ts:3"),
        ("NODE_ENV", None, False, None, None, "src/config.ts:6"),
        ("PORT", "3000", True, None, "int", "src/config.ts:2"),
    ]
    ctx, files = files_of(FIXTURES / "node-env")
    assert [h.data["name"] for h in nodeenv.parse(files, ctx).hints] == ["`PREFIX_${name}`"]


def test_go_fixture() -> None:
    assert _params(goenv, FIXTURES / "go-env") == [
        ("DATABASE_URL", None, False, True, None, "cmd/main.go:7"),
        ("LOG_LEVEL", None, False, None, None, "cmd/main.go:13"),
        ("PORT", "8080", True, None, "int", "cmd/main.go:6"),
        ("REGION", None, False, True, None, "cmd/main.go:14"),
        ("TIMEOUT", "30s", True, None, "duration", "cmd/main.go:8"),
    ]
    ctx, files = files_of(FIXTURES / "go-env")
    assert [h.data["name"] for h in goenv.parse(files, ctx).hints] == ["key"]


COMPOSE = """services:
  api:
    build: ./api
    environment:
      LOG_LEVEL: debug
      API_KEY: ${API_KEY}
"""


def test_merge_with_manifest_params(tmp_path: Path) -> None:
    tree(tmp_path, {
        # Второй контейнер: при единственном общий код достался бы ему (owners.sole_owner).
        "docker-compose.yml": COMPOSE + "  worker:\n    build: ./worker\n",
        "worker/requirements.txt": "celery\n",
        "api/requirements.txt": "fastapi\n",
        "api/.env.example": "TIMEOUT=10s\n",
        "api/app.py": "import os\n"
        'LOG_LEVEL = os.getenv("LOG_LEVEL", "info")\n'
        'API_KEY = os.getenv("API_KEY", "sk_live_in_code_123456")\n'
        'TIMEOUT = os.getenv("TIMEOUT", "30s")\n'
        'TOKEN = os.environ["TOKEN"]\n'
        'MAYBE = os.environ["MAYBE"]\n'
        'MAYBE2 = os.getenv("MAYBE", "x")\n',
        "lib/requirements.txt": "requests\n",
        "lib/shared.py": 'import os\nX = os.getenv("SHARED_ONLY")\nY = os.getenv("SHARED_ONLY")\n',
    })
    model = model_of(tmp_path)
    params = model.params["api"]
    # Дефолт из кода дополняет манифест, а пример окружения старше кода.
    assert params["LOG_LEVEL"].default == "info"
    assert params["TIMEOUT"].default == "10s" and params["TIMEOUT"].type == "duration"
    # Секрет: дефолт из кода не пишется, но место чтения в основаниях.
    assert params["API_KEY"].default is None
    assert any(loc.path == "api/app.py" for loc in params["API_KEY"].locs)
    assert params["TOKEN"].required is True
    # Где-то читается с дефолтом: параметр не обязательный.
    assert params["MAYBE"].required is None
    assert sorted(params["LOG_LEVEL"].parsers) == ["compose", "python-env"]
    assert [h for h in model.hints["unassigned"] if h["kind"] == "config"] == [{
        "kind": "config", "name": "SHARED_ONLY", "reason": texts.REASON_SHARED_LIB,
        "source": "lib/shared.py:2",
    }]
