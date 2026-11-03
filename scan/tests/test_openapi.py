"""Файлы OpenAPI: опознание по имени и ключу версии, число операций, подсказка агенту."""

from __future__ import annotations

import time
from pathlib import Path

import yaml

from archmap_scan.parsers import openapi
from archmap_scan.scan import Options, run
from tests.helpers import FIXTURES, files_of, tree


def test_candidates() -> None:
    assert openapi.is_candidate("a/openapi.yaml")
    assert openapi.is_candidate("a/Swagger-v2.JSON")
    assert openapi.is_candidate("openapi.yml")
    assert not openapi.is_candidate("a/openapi.md")
    assert not openapi.is_candidate("a/my-openapi.yaml")


def test_fixture_and_hints(tmp_path: Path) -> None:
    ctx, files = files_of(FIXTURES / "openapi")
    found = openapi.parse(files, ctx)
    assert [(s.path, s.operations) for s in found.openapi] == [
        ("api/swagger.json", 1), ("services/orders/openapi.yaml", 3),
    ]
    assert [h.data["path"] for h in found.hints] == ["web/openapi.json"]

    out = tmp_path / "out"
    run(Options(path=str(FIXTURES / "openapi"), out=str(out), system="Ярмарка", use_git=False))
    hints = yaml.safe_load((out / "agent" / "hints.yaml").read_text(encoding="utf-8"))
    assert hints["openapi_files"] == [
        {"path": "api/swagger.json", "operations": 1},
        {"path": "services/orders/openapi.yaml", "container": "orders", "operations": 3},
    ]


def test_too_large_and_hostile(tmp_path: Path) -> None:
    tree(tmp_path, {
        "big/openapi.yaml": "openapi: 3.0.0\npaths:\n" + "  /p{0}: {{get: {{}}}}\n" * 40_000,
        "deep/openapi.json": "[" * 1_000_000,
        "line/openapi.yaml": "x" * 2_000_000,
    })
    ctx, files = files_of(tmp_path)
    started = time.perf_counter()
    found = openapi.parse(files, ctx)
    assert time.perf_counter() - started < 1.0
    assert [(s.path, s.operations) for s in found.openapi] == [("big/openapi.yaml", None)]
    assert [h.data["path"] for h in found.hints] == ["deep/openapi.json"]
