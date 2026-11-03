"""Маршруты Node (ТЗ §6.2): Express, Koa-router, NestJS по фикстурам; маска кода."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from archmap_scan import codetext
from archmap_scan.parsers import express, nest
from tests.helpers import FIXTURES, files_of


def _routes(parser: object, root: Path) -> list[tuple[str, str, bool, str, str]]:
    ctx, files = files_of(root)
    found = parser.parse(files, ctx)  # type: ignore[attr-defined]
    return sorted(
        (r.method, r.path, r.prefix_unresolved, r.framework, str(r.loc)) for r in found.routes
    )


def test_express_and_koa_fixture() -> None:
    assert _routes(express, FIXTURES / "express") == [
        ("DELETE", "/api/items/:id", False, "Koa", "koa/app.ts:8"),
        ("GET", "/:id", True, "Express", "src/users.js:4"),
        ("GET", "/api/items", False, "Koa", "koa/app.ts:7"),
        ("GET", "/books", False, "Express", "src/server.js:14"),
        ("GET", "/health", False, "Express", "src/server.js:12"),
        ("GET", "/orders/", False, "Express", "src/server.js:8"),
        ("POST", "/books", False, "Express", "src/server.js:14"),
        ("POST", "/orders/:id/pay", False, "Express", "src/server.js:9"),
    ]


def test_express_traps() -> None:
    ctx, files = files_of(FIXTURES / "express")
    found = express.parse(files, ctx)
    # Ни строка в комментарии, ни вызов HTTP-клиента маршрутом не стали.
    assert not any("commented" in r.path or "external" in r.path for r in found.routes)
    assert [(h.data["name"], h.data["source"]) for h in found.hints] == [
        ("PATH", "src/server.js:22"), ("`/tmpl/${name}`", "src/server.js:23"),
    ]


def test_nest_fixture() -> None:
    assert _routes(nest, FIXTURES / "nest") == [
        ("ANY", "/api/dogs/*", False, "NestJS", "src/cats.controller.ts:30"),
        ("GET", "/api/cats", False, "NestJS", "src/cats.controller.ts:5"),
        ("GET", "/api/cats/:id", False, "NestJS", "src/cats.controller.ts:10"),
        ("GET", "/api/health", False, "NestJS", "src/health.controller.ts:7"),
        ("POST", "/api/cats", False, "NestJS", "src/cats.controller.ts:15"),
        ("PUT", "/api/dogs/:id", False, "NestJS", "src/cats.controller.ts:25"),
    ]
    ctx, files = files_of(FIXTURES / "nest")
    hints = nest.parse(files, ctx).hints
    assert [(h.data["name"], h.data["source"]) for h in hints] == [
        ("ROUTE", "src/health.controller.ts:12"),
    ]


def test_mask_keeps_length_and_hides_comments() -> None:
    text = "a.get('/x') // b.get('/y')\n/* c.get('/z') */ s = \"q\\\"w\"; t = `l1\nl2`\n"
    code = codetext.Code(text, codetext.JS)
    assert len(code.mask) == len(text)
    assert "/y" not in code.mask and "/z" not in code.mask and "/x" not in code.mask
    assert code.mask.count("\n") == text.count("\n")
    start = text.index("'/x'")
    assert code.literal(start, start + 4) == ("/x", False)
    assert code.line(text.index("t = ")) == 2


HOSTILE = {
    "comments": "/**/" * 290_000 + "x" * 840_000,
    "strings": "'a'" * 199_000 + "b" * 1_400_000,
    "templates": "`${" * 199_000 + "c" * 1_400_000,
    "backslashes": "\\" * 2_000_000,
    "unterminated": "/*" + "d" * 2_000_000,
    "quote-escapes": "\"\\" * 290_000 + "e" * 1_400_000,
}


@pytest.mark.parametrize("name", sorted(HOSTILE))
def test_mask_is_linear_on_hostile_input(name: str) -> None:
    payload = HOSTILE[name]
    for lang in (codetext.JS, codetext.GO):
        started = time.perf_counter()
        assert len(codetext.mask(payload, lang)) == len(payload)
        assert time.perf_counter() - started < 1.0


def test_too_dense_file_is_refused(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    (root / "src").mkdir(parents=True)
    (root / "package.json").write_text('{"dependencies": {"express": "*"}}', encoding="utf-8")
    (root / "src" / "app.js").write_text("app.get('/x', h);\n" + "'" * 1_000_000, encoding="utf-8")
    ctx, files = files_of(root)
    started = time.perf_counter()
    assert express.parse(files, ctx).routes == []
    assert time.perf_counter() - started < 1.0
    assert files.too_large == {"src/app.js"}
