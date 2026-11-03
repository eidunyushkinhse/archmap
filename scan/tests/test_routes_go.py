"""Маршруты Go (ТЗ §6.2): net/http, gin, chi и gorilla по фикстуре, группы присваиванием и
замыканием, клиенты и Get хранилищ не маршруты."""

from __future__ import annotations

from pathlib import Path

from archmap_scan.parsers import gohttp
from tests.helpers import FIXTURES, files_of, tree


def _routes(root: Path) -> list[tuple[str, str, bool, str, str]]:
    ctx, files = files_of(root)
    found = gohttp.parse(files, ctx)
    return sorted(
        (r.method, r.path, r.prefix_unresolved, r.framework, str(r.loc)) for r in found.routes
    )


def test_fixture() -> None:
    assert _routes(FIXTURES / "go-http") == [
        ("ANY", "/health", False, "net/http", "cmd/std/main.go:6"),
        ("ANY", "/static/", False, "net/http", "cmd/std/main.go:9"),
        ("DELETE", "/api/v2/users/{id}", False, "chi", "internal/chiapi/router.go:11"),
        ("DELETE", "/v1/admin/cache", False, "Gin", "internal/ginapi/router.go:11"),
        ("GET", "/", False, "chi", "internal/chiapi/router.go:7"),
        ("GET", "/admin/stats", False, "gorilla/mux", "internal/muxapi/router.go:9"),
        ("GET", "/items/{id}", False, "net/http", "cmd/std/main.go:8"),
        ("GET", "/ping", False, "Gin", "internal/ginapi/router.go:7"),
        ("GET", "/plugin", True, "Gin", "internal/ginapi/router.go:21"),
        ("GET", "/products", False, "gorilla/mux", "internal/muxapi/router.go:7"),
        ("PATCH", "/legacy", False, "Gin", "internal/ginapi/router.go:12"),
        ("POST", "/api/users", False, "chi", "internal/chiapi/router.go:9"),
        ("POST", "/products", False, "gorilla/mux", "internal/muxapi/router.go:7"),
        ("POST", "/v1/orders", False, "Gin", "internal/ginapi/router.go:9"),
    ]


def test_dynamic_only_on_known_routers(tmp_path: Path) -> None:
    ctx, files = files_of(FIXTURES / "go-http")
    hints = gohttp.parse(files, ctx).hints
    assert [(h.data["name"], h.data["source"]) for h in hints] == [
        ("pathVar", "internal/ginapi/router.go:13"),
    ]
    tree(tmp_path, {
        "go.mod": "module x\n",
        "store.go": "package x\nfunc f() {\n\tv, _ := store.Get(ctx, key)\n"
        '\tgroup.Get(toPath("/api/x"), h)\n}\n',
    })
    ctx, files = files_of(tmp_path)
    found = gohttp.parse(files, ctx)
    assert found.routes == []
    assert [h.data["name"] for h in found.hints] == ['toPath("/api/x")']
