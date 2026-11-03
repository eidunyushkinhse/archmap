"""Служебные каталоги, конфиги инструментов и переменные ОС (ТЗ §13.1): записи кода из них
не факты сервиса, а подсказки с причиной; покрытие считает файлы, сводка называет записи."""

from __future__ import annotations

from pathlib import Path

from archmap_scan import registry, stats, texts, vocab
from archmap_scan.assemble import assemble
from archmap_scan.objects import Model
from archmap_scan.output import summary
from archmap_scan.output.coverage import Coverage
from archmap_scan.walk import TOOL_CONFIG, TOOLING_DIR, Files, list_files, tooling_kind
from tests.helpers import ctx_of, tree

COMPOSE = """\
services:
  api:
    build: ./services/api
    environment:
      PYTHONUNBUFFERED: "1"
      API_PORT: "8000"
"""
MAIN = """\
import os
from fastapi import FastAPI

app = FastAPI()
HOME = os.getenv("HOME")
SETTINGS = os.environ.get("DJANGO_SETTINGS_MODULE", "api.settings")
PORT = os.getenv("API_PORT", "8000")
os.environ.setdefault("SETUP_ONLY", "1")
PROXY = os.getenv("http_proxy")
LOCALE = os.getenv("LC_ALL")


@app.get("/health")
def health():
    return {}
"""
TOOL = """\
import os
from fastapi import FastAPI

app = FastAPI()
TOKEN = os.getenv("TOOL_TOKEN")


@app.get("/tool")
def tool():
    return {}
"""


def _tree(root: Path) -> Path:
    return tree(root, {
        "docker-compose.yml": COMPOSE,
        "services/api/pyproject.toml": '[project]\nname = "api"\ndependencies = ["fastapi"]\n',
        "services/api/Dockerfile": "FROM python:3.12\n",
        "services/api/app/main.py": MAIN,
        "services/api/tools/gen.py": TOOL,
        "web/Dockerfile": "FROM node:20\n",
        "web/package.json": '{"name": "web", "dependencies": {"react": "18"}}',
        "web/src/app.js": "const mode = process.env.NODE_ENV;\n",
        "web/jest.config.js": "module.exports = { workers: process.env.JEST_WORKERS };\n",
    })


def _run(root: Path) -> tuple[Model, Coverage]:
    ctx = ctx_of(root, "Ярмарка")
    listing = list_files(ctx)
    files = Files(ctx.root, listing.files)
    findings, errors = registry.collect(files, ctx)
    assert errors == {}
    model = assemble(findings, ctx)
    cov = Coverage(
        repo="", commit="", stacks=stats.stacks(model),
        families=stats.families(model, findings, errors), excluded=listing.excluded,
        too_large=0, binary=0,
    )
    return model, cov


def test_tooling_kind() -> None:
    assert tooling_kind("tools/oneclickapps/x.py") == TOOLING_DIR
    assert tooling_kind("src/sentry/testutils/helpers.py") == TOOLING_DIR
    assert tooling_kind(".github/workflows/scripts/a.py") == TOOLING_DIR
    assert tooling_kind("pkg/Test_Utils/a.go") == TOOLING_DIR  # без учёта регистра
    assert tooling_kind("jest.config.js") == TOOL_CONFIG
    assert tooling_kind("e2e/playwright.config.ts") == TOOL_CONFIG
    assert tooling_kind("vite.config.mts") == TOOL_CONFIG
    # Сегмент целиком, а не часть имени; имя файла каталогом не считается.
    assert tooling_kind("src/toolsx/a.py") is None
    assert tooling_kind("src/dev_tools/a.py") is None
    assert tooling_kind("bin.py") is None
    assert tooling_kind("src/app.config.json") is None
    assert tooling_kind("config.js") is None
    assert tooling_kind(".config.js") is None


def test_os_variables() -> None:
    for name in ("HOME", "USER", "TZ", "LC_ALL", "GITHUB_ACTIONS", "GITLAB_CI", "PYTHONPATH",
                 "http_proxy", "HTTPS_PROXY", "No_Proxy", "CI", "CODESPACES", "NODE_OPTIONS"):
        assert vocab.is_os_variable(name), name
    for name in ("NODE_ENV", "DJANGO_SETTINGS_MODULE", "HOME_DIR", "home", "USERNAME", "CIRCLE"):
        assert not vocab.is_os_variable(name), name


def test_tooling_records_go_to_hints(tmp_path: Path) -> None:
    model, cov = _run(_tree(tmp_path))
    assert model.params["api"].keys() == {"API_PORT", "DJANGO_SETTINGS_MODULE"}
    assert model.params["web"].keys() == {"NODE_ENV"}
    assert [e.path for e in model.http["api"]] == ["/health"]
    aside = sorted(
        (h["kind"], h["name"], h["reason"], h["source"])
        for h in model.hints["unassigned"]
    )
    assert aside == [
        ("config", "HOME", texts.REASON_OS_VARIABLE, "services/api/app/main.py:5"),
        ("config", "JEST_WORKERS", texts.REASON_TOOL_CONFIG, "web/jest.config.js:1"),
        ("config", "LC_ALL", texts.REASON_OS_VARIABLE, "services/api/app/main.py:10"),
        ("config", "PYTHONUNBUFFERED", texts.REASON_OS_VARIABLE, "docker-compose.yml:5"),
        ("config", "TOOL_TOKEN", texts.REASON_TOOLING_DIR, "services/api/tools/gen.py:5"),
        ("config", "http_proxy", texts.REASON_OS_VARIABLE, "services/api/app/main.py:9"),
        ("route", "GET /tool", texts.REASON_TOOLING_DIR, "services/api/tools/gen.py:8"),
    ]
    config = cov.families["config"]
    # Записи не факты, но и не «без владельца»: файлы служебных каталогов в skipped.
    assert config.unassigned == 0 and config.skipped == {"tooling": 2}
    assert config.entry()["skipped"] == {"tooling": 2}
    assert cov.families["http_routes"].skipped == {"tooling": 1}
    assert cov.families["http_routes"].found == 1
    text = summary.render(cov)
    assert texts.tooling_line(3) in text
    assert texts.os_variables_line(4) in text
    assert "без владельца" not in text


def test_setdefault_is_not_a_read(tmp_path: Path) -> None:
    model, _cov = _run(_tree(tmp_path))
    names = {h["name"] for h in model.hints.get("unassigned", [])}
    assert "SETUP_ONLY" not in names
    assert all("SETUP_ONLY" not in table for table in model.params.values())
