"""Маршруты Go (ТЗ §6.2): net/http, gin, chi и gorilla по фикстуре, группы присваиванием и
замыканием, клиенты и Get хранилищ не маршруты; путь в обёртке toPath("/p") на известном
объекте маршрутизации (ТЗ §15 п. 2)."""

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
        ("DELETE", "/v1/alerts/{id}", False, "chi", "internal/alertapi/routes.go:21"),
        ("GET", "/", False, "chi", "internal/chiapi/router.go:7"),
        ("GET", "/admin/stats", False, "gorilla/mux", "internal/muxapi/router.go:9"),
        ("GET", "/items/{id}", False, "net/http", "cmd/std/main.go:8"),
        ("GET", "/ping", False, "Gin", "internal/ginapi/router.go:7"),
        ("GET", "/plugin", True, "Gin", "internal/ginapi/router.go:21"),
        ("GET", "/products", False, "gorilla/mux", "internal/muxapi/router.go:7"),
        ("GET", "/v1/alerts/{id}", False, "chi", "internal/alertapi/routes.go:17"),
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


def test_wrapped_path(tmp_path: Path) -> None:
    """Обёртка с одним строковым литералом пути на известном получателе — маршрут (и с
    методами gorilla после неё); выражение в обёртке, литерал не с «/» и неизвестный
    получатель — подсказка, как раньше."""
    tree(tmp_path, {
        "go.mod": "module x\n\nrequire github.com/gorilla/mux v1.8.1\n",
        "routes.go": 'package x\nimport "github.com/gorilla/mux"\nfunc f() {\n'
        "\tr := mux.NewRouter()\n"
        '\tr.HandleFunc(toPath("/items"), h).Methods("PUT", "PATCH")\n'
        '\tr.HandleFunc(toPath(`/raw`), h)\n'
        '\tr.HandleFunc(toPath(base + "/x"), h)\n'
        '\tr.HandleFunc(toPath("items"), h)\n'
        '\tr.HandleFunc(pkg.ToPath("/q"), h)\n'
        '\tother.Put(toPath("/unknown"), h)\n'
        "}\n",
    })
    assert _routes(tmp_path) == [
        ("ANY", "/raw", False, "gorilla/mux", "routes.go:6"),
        ("PATCH", "/items", False, "gorilla/mux", "routes.go:5"),
        ("PUT", "/items", False, "gorilla/mux", "routes.go:5"),
    ]
    ctx, files = files_of(tmp_path)
    hints = gohttp.parse(files, ctx).hints
    assert [(h.data["name"], h.data["source"]) for h in hints] == [
        ('toPath(base + "/x")', "routes.go:7"), ('toPath("items")', "routes.go:8"),
        ('pkg.ToPath("/q")', "routes.go:9"), ('toPath("/unknown")', "routes.go:10"),
    ]


def test_dev_code_not_read(tmp_path: Path) -> None:
    """Находка фазы 1б на Grafana: 439 маршрутов из devenv/docker/blocks/*/main.go ушли в
    подсказки. Код в каталогах для разработки разборщики кода не читают: ни в entrypoints,
    ни в hints его нет, а семья считает пропуск в skipped.dev_code (ТЗ §4). Каталоги demo
    и local на код не действуют."""
    import yaml

    from archmap_scan.scan import Options, run

    root = tree(tmp_path / "repo", {
        "Dockerfile": "FROM golang:1.22\n",
        "go.mod": "module github.com/org/shop\n",
        "main.go": 'package main\nfunc main() { http.HandleFunc("/live", h) }\n',
        "devenv/x/main.go": 'package main\nfunc main() { http.HandleFunc("/dev-only", h) }\n',
        ".devcontainer/tool/main.go": (
            'package main\nfunc main() { http.HandleFunc("/container-only", h) }\n'
        ),
        "src/demo_mode/main.go": 'package demo\nfunc f() { http.HandleFunc("/demo", h) }\n',
        "local/main.go": 'package local\nfunc f() { http.HandleFunc("/local", h) }\n',
        "dev/cron.d/cleanup": "0 3 * * * root /usr/bin/cleanup\n",
    })
    out = tmp_path / "out"
    run(Options(path=str(root), out=str(out), system="shop", use_git=False))
    text = "".join(
        (out / rel).read_text(encoding="utf-8")
        for rel in ("agent/entrypoints.yaml", "agent/hints.yaml", "schema.yaml")
    )
    assert "/live" in text and "/demo" in text and "/local" in text
    assert "/dev-only" not in text and "/container-only" not in text and "cleanup" not in text
    families = yaml.safe_load((out / "coverage.yaml").read_text(encoding="utf-8"))["families"]
    assert families["http_routes"]["skipped"] == {"dev_code": 2}
    assert families["config"]["skipped"] == {"dev_code": 2}
    assert families["schedules"]["skipped"] == {"dev_code": 1}
    assert "skipped" not in families["containers"]


def test_dev_code_tokens() -> None:
    from archmap_scan.walk import is_dev_code

    assert is_dev_code("devenv/docker/blocks/x/main.go")
    assert is_dev_code(".devcontainer/x.py") and is_dev_code("tools/hack/gen.go")
    assert not is_dev_code("src/sentry/demo_mode/views.py")
    assert not is_dev_code("zproject/dev_urls.py")  # имя файла не в счёт
    assert not is_dev_code("contrib/x.py") and not is_dev_code("ci/x.py")
