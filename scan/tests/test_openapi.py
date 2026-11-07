"""Файлы OpenAPI: опознание по имени и ключу версии, число операций, подсказка агенту."""

from __future__ import annotations

import time
from pathlib import Path

import yaml

from archmap_scan import texts
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
    assert [h.data["name"] for h in found.hints] == ["web/openapi.json"]

    out = tmp_path / "out"
    run(Options(path=str(FIXTURES / "openapi"), out=str(out), system="Ярмарка", use_git=False))
    hints = yaml.safe_load((out / "agent" / "hints.yaml").read_text(encoding="utf-8"))
    assert hints["openapi_files"] == [
        {
            "kind": "openapi", "name": "api/swagger.json", "reason": texts.REASON_OPENAPI_FILE,
            "source": "api/swagger.json", "operations": 1,
        },
        {
            "kind": "openapi", "name": "services/orders/openapi.yaml", "object": "orders",
            "reason": texts.REASON_OPENAPI_FILE, "source": "services/orders/openapi.yaml",
            "operations": 3,
        },
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
    assert [h.data["name"] for h in found.hints] == ["deep/openapi.json"]


def test_paths_by_file_refs(tmp_path: Path) -> None:
    """Находка фазы 1а на Sentry: api-docs/openapi.json, 0 операций, потому что пути —
    ссылки $ref на paths/*.json. Ссылки на файлы репозитория разворачиваются на один
    уровень; неразворачиваемая ссылка — операции не посчитаны, причина в подсказке. Каталог
    api-docs с ТЗ §15 п. 12 С3 исключается соглашением (docs частью сегмента), поэтому в
    дереве теста он называется api-spec."""
    import json

    tree(tmp_path, {
        "api-spec/openapi.json": json.dumps({"openapi": "3.0.0", "paths": {
            "/a/": {"$ref": "paths/a.json"},
            "/b/": {"$ref": "paths/b.json#/item"},
            "/c/": {"$ref": "#/components/pathItems/c"},
            "/d/": {"get": {}},
        }, "components": {"pathItems": {"c": {"put": {}, "summary": "x"}}}}),
        "api-spec/paths/a.json": json.dumps({"get": {}, "post": {}, "parameters": []}),
        "api-spec/paths/b.json": json.dumps({"item": {"delete": {}}}),
        "whole/openapi.yaml": "openapi: 3.1.0\npaths:\n  $ref: ./routes.yaml\n",
        "whole/routes.yaml": "/x:\n  get: {}\n  patch: {}\n",
        "broken/openapi.yaml": (
            "openapi: 3.0.0\npaths:\n  /a:\n    $ref: missing.yaml\n  /b:\n    get: {}\n"
        ),
        "remote/openapi.yaml": "openapi: 3.0.0\npaths:\n  /a:\n    $ref: https://x/y.yaml\n",
        "chain/openapi.yaml": "openapi: 3.0.0\npaths:\n  /a:\n    $ref: one.yaml\n",
        "chain/one.yaml": "$ref: two.yaml\n",
        "chain/two.yaml": "get: {}\n",
    })
    ctx, files = files_of(tmp_path)
    found = openapi.parse(files, ctx)
    got = {s.path: (s.operations, s.reason) for s in found.openapi}
    refs = "пути заданы ссылками, которые не удалось развернуть, операции не посчитаны"
    assert got == {
        "api-spec/openapi.json": (5, None),
        "whole/openapi.yaml": (2, None),
        "broken/openapi.yaml": (None, refs),
        "remote/openapi.yaml": (None, refs),
        # Один уровень, без рекурсии: ссылка из целевого файла не разворачивается.
        "chain/openapi.yaml": (None, refs),
    }
    out = tmp_path / "out"
    run(Options(path=str(tmp_path), out=str(out), use_git=False))
    hints = yaml.safe_load((out / "agent" / "hints.yaml").read_text(encoding="utf-8"))
    assert {
        "kind": "openapi", "name": "broken/openapi.yaml", "reason": refs,
        "source": "broken/openapi.yaml",
    } in hints["openapi_files"]


def test_ref_file_limit(tmp_path: Path) -> None:
    files_map: dict[str, str | bytes] = {
        "api/openapi.yaml": "openapi: 3.0.0\npaths:\n" + "".join(
            f"  /p{i}:\n    $ref: p/{i}.yaml\n" for i in range(openapi.MAX_REF_FILES + 1)
        ),
    }
    for i in range(openapi.MAX_REF_FILES + 1):
        files_map[f"api/p/{i}.yaml"] = "get: {}\n"
    tree(tmp_path, files_map)
    ctx, files = files_of(tmp_path)
    started = time.perf_counter()
    [spec] = openapi.parse(files, ctx).openapi
    assert time.perf_counter() - started < 2.0
    assert spec.operations is None and spec.reason is not None
