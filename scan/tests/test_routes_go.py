"""Маршруты Go (ТЗ §6.2): net/http, gin, chi и gorilla по фикстуре, группы присваиванием и
замыканием, клиенты и Get хранилищ не маршруты; путь в обёртке toPath("/p") на известном
объекте маршрутизации (ТЗ §15 п. 2); префикс через параметр функции регистрации из мест
вызова в том же пакете (ТЗ §15 п. 3)."""

from __future__ import annotations

from pathlib import Path

from archmap_scan import texts
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
        # Склейка двух литералов — путь целиком (К5); mux — параметр без мест вызова.
        ("ANY", "/api/v2", True, "net/http", "internal/joinapi/router.go:9"),
        ("ANY", "/health", False, "net/http", "cmd/std/main.go:6"),
        ("ANY", "/plain", False, "net/http", "internal/joinapi/router.go:11"),
        ("ANY", "/static/", False, "net/http", "cmd/std/main.go:9"),
        ("DELETE", "/api/folders/{uid}/", False, "chi", "internal/folderapi/folders.go:8"),
        ("DELETE", "/api/v2/users/{id}", False, "chi", "internal/chiapi/router.go:11"),
        ("DELETE", "/internal/folders/{uid}/", False, "chi", "internal/folderapi/folders.go:8"),
        ("DELETE", "/v1/admin/cache", False, "Gin", "internal/ginapi/router.go:11"),
        ("DELETE", "/v1/alerts/{id}", False, "chi", "internal/alertapi/routes.go:21"),
        ("GET", "/", False, "chi", "internal/chiapi/router.go:7"),
        ("GET", "/admin/stats", False, "gorilla/mux", "internal/muxapi/router.go:9"),
        ("GET", "/api/folders", False, "chi", "internal/folderapi/folders.go:6"),
        # registerArchive никто не вызывает: префикс как прежде, не решён.
        ("GET", "/archive", True, "chi", "internal/folderapi/folders.go:14"),
        ("GET", "/internal/folders", False, "chi", "internal/folderapi/folders.go:6"),
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
        ('"/"+root+"/"', "internal/joinapi/router.go:7"),
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


def test_param_prefix_rules(tmp_path: Path) -> None:
    """Префикс параметра от места вызова (Grafana registerFolderAPI): флаг «не решён»
    приходит с места вызова (корень полем структуры), вызов x.имя( тоже вызов; место
    вызова с неизвестным объектом даёт запись как прежде, параметр другой функции дальше
    не резолвится; параметр, перекрытый параметром замыкания (группа выражением), и имя,
    определённое в пакете дважды, не резолвятся; вызов из другого каталога не в счёт."""
    tree(tmp_path, {
        "go.mod": "module x\n",
        "api/api.go": "package api\n"
        "func (hs *HTTPServer) registerRoutes() {\n"
        "\tr := hs.RouteRegister\n"
        '\tr.Group("/api", func(apiRoute routing.RouteRegister) {\n'
        "\t\ths.registerFolderAPI(apiRoute, authorize)\n"
        "\t\ths.registerShared(apiRoute)\n"
        "\t\tregisterDyn(apiRoute)\n"
        "\t\tx.register(apiRoute)\n"
        "\t})\n"
        "\ths.registerShared(r)\n"
        "}\n"
        "func mount(sub routing.RouteRegister) {\n\tregisterTeams(sub)\n}\n",
        "api/folder.go": "package api\n"
        "func (hs *HTTPServer) registerFolderAPI(apiRoute routing.RouteRegister,"
        " authorize func(ac.Evaluator) web.Handler) {\n"
        '\tapiRoute.Group("/folders", func(folderRoute routing.RouteRegister) {\n'
        '\t\tfolderRoute.Get("/", h)\n'
        "\t})\n"
        "}\n"
        "func (hs *HTTPServer) registerShared(r routing.RouteRegister) {\n"
        '\tr.Get("/shared", h)\n'
        "}\n"
        "func registerTeams(r routing.RouteRegister) {\n"
        '\tr.Get("/teams", h)\n'
        "}\n"
        "func registerDyn(r routing.RouteRegister) {\n"
        '\tr.Group(fmt.Sprintf("/x/%s", k), func(r routing.RouteRegister) {\n'
        '\t\tr.Get("/dyn", h)\n'
        "\t})\n"
        "}\n"
        'func (a *A) register(r routing.RouteRegister) {\n\tr.Get("/a", h)\n}\n'
        'func (b *B) register(r routing.RouteRegister) {\n\tr.Get("/b", h)\n}\n',
        "other/main.go": "package other\nfunc main() {\n\tr := chi.NewRouter()\n"
        '\tr.Route("/o", func(o chi.Router) {\n\t\tregisterTeams(o)\n\t})\n}\n',
    })
    assert _routes(tmp_path) == [
        ("GET", "/a", True, "net/http", "api/folder.go:19"),
        ("GET", "/api/folders/", True, "net/http", "api/folder.go:4"),
        ("GET", "/api/shared", True, "net/http", "api/folder.go:8"),
        ("GET", "/b", True, "net/http", "api/folder.go:22"),
        ("GET", "/dyn", True, "net/http", "api/folder.go:15"),
        ("GET", "/shared", True, "net/http", "api/folder.go:8"),
        ("GET", "/teams", True, "net/http", "api/folder.go:11"),
    ]


def test_param_prefix_site_limit(tmp_path: Path) -> None:
    """Мест вызова одной функции разбирается не больше 50, первые по файлу. Параметр
    назван не r: корень r := chi.NewRouter() известен по имени во всём файле."""
    groups = "".join(
        f'\tr.Route("/p{i:02d}", func(g chi.Router) {{ reg(g) }})\n' for i in range(60)
    )
    tree(tmp_path, {
        "go.mod": "module x\n",
        "main.go": "package x\nfunc main() {\n\tr := chi.NewRouter()\n" + groups + "}\n"
        'func reg(rt chi.Router) {\n\trt.Get("/x", h)\n}\n',
    })
    assert [r[1] for r in _routes(tmp_path)] == [f"/p{i:02d}/x" for i in range(50)]


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


def _mask(text: str) -> str:
    from archmap_scan import codetext

    return codetext.mask(text, codetext.GO)


def test_gocode_functions_and_calls() -> None:
    """Определения: метод с получателем, параметры типа, сгруппированные параметры и
    параметр-функция; объявление без тела пропускается. Вызовы: «имя(» и «x.имя(», но не
    часть длинного имени, не определение и не строка."""
    from archmap_scan import gocode

    mask = _mask(
        "package x\n"
        "func (hs *S) reg(api, b chi.Router, auth func(E) H) {\n\tapi.Get(\"/a\", h)\n}\n"
        "func Map[T any](xs []T, f func(T) T) []T {\n\treturn xs\n}\n"
        "func asm(x int) int\n"
        "func main() {\n\ths.reg(r, nil, auth)\n\treg( q )\n\tprereg(z)\n"
        '\ts := "reg(x)"\n\t(f()).reg(w)\n}\n'
    )
    funcs = gocode.functions(mask)
    assert [(f.name, f.params) for f in funcs] == [
        ("reg", ("api", "b", "auth")), ("Map", ("xs", "f")), ("main", ()),
    ]
    skip = {f.at for f in funcs}
    assert [(n, a) for n, _at, a in gocode.calls(mask, {"reg"}, skip, 50)] == [
        ("reg", ["r", "nil", "auth"]), ("reg", ["q"]),
    ]
    assert gocode.calls(mask, {"reg"}, skip, 1)[0][2] == ["r", "nil", "auth"]
    assert gocode.calls(mask, set(), skip, 50) == []
    # Список не закрылся в пределах MAX_LIST: ни определения, ни вызова.
    long = _mask("func f(" + "a, " * 1000 + "b int) {\n}\nf(" + "x, " * 1000 + ")\n")
    assert gocode.functions(long) == [] and gocode.calls(long, {"f"}, set(), 50) == []


def test_joined_literal_is_not_a_route() -> None:
    """«"/"+root+"/"» (Argo CD server/server.go): литерал лишь часть пути, маршрута «/» нет,
    склейка в подсказках с причиной (ТЗ §15 п. 10 А). Склейка двух литералов «"/api" +
    "/v2"» с части 4 — путь целиком (ТЗ §15 п. 15 К5); обычный литерал рядом остаётся
    маршрутом."""
    ctx, files = files_of(FIXTURES / "go-http")
    found = gohttp.parse(files, ctx)
    joined = [r for r in found.routes if r.loc.path == "internal/joinapi/router.go"]
    assert sorted((r.method, r.path) for r in joined) == [("ANY", "/api/v2"), ("ANY", "/plain")]
    reasons = {
        h.data["name"]: h.data["reason"] for h in found.hints
        if str(h.data["source"]).startswith("internal/joinapi/")
    }
    assert reasons == {'"/"+root+"/"': texts.REASON_JOINED_NAME}


def test_prefix_variable(tmp_path: Path) -> None:
    """«имя + "/литерал"» на известном объекте маршрутизации (Online Boutique
    baseUrl+"/cart/checkout"): путь литерала с нерешённым префиксом, методы из .Methods с
    константами http.MethodGet; поле слева и несколько литералов тоже. «"/x" + имя», «a +
    b» и склейка на неизвестном получателе — подсказки, как раньше (ТЗ §15 п. 15 К5)."""
    tree(tmp_path, {
        "go.mod": "module x\n\nrequire github.com/gorilla/mux v1.8.1\n",
        "main.go": 'package main\nimport "github.com/gorilla/mux"\nfunc main() {\n'
        "\tr := mux.NewRouter()\n"
        '\tr.HandleFunc(baseUrl+"/cart/checkout", h).Methods(http.MethodPost)\n'
        '\tr.HandleFunc(baseUrl + "/", h).Methods(http.MethodGet, http.MethodHead)\n'
        '\tr.HandleFunc(cfg.Base + "/api" + "/v1", h).Methods("PUT")\n'
        '\tr.HandleFunc("/x" + tail, h)\n'
        "\tr.HandleFunc(a + b, h)\n"
        '\tother.HandleFunc(base + "/y", h)\n'
        '\thttp.HandleFunc(prefix + "/z", h)\n'
        "}\n",
    })
    assert _routes(tmp_path) == [
        ("ANY", "/z", True, "gorilla/mux", "main.go:11"),
        ("GET", "/", True, "gorilla/mux", "main.go:6"),
        ("HEAD", "/", True, "gorilla/mux", "main.go:6"),
        ("POST", "/cart/checkout", True, "gorilla/mux", "main.go:5"),
        ("PUT", "/api/v1", True, "gorilla/mux", "main.go:7"),
    ]
    ctx, files = files_of(tmp_path)
    hints = gohttp.parse(files, ctx).hints
    assert [(h.data["name"], h.data["reason"], h.data["source"]) for h in hints] == [
        ('"/x" + tail', texts.REASON_JOINED_NAME, "main.go:8"),
        ("a + b", texts.REASON_DYNAMIC_ROUTE, "main.go:9"),
        ('base + "/y"', texts.REASON_DYNAMIC_ROUTE, "main.go:10"),
    ]
