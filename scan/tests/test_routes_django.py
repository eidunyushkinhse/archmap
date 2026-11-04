"""Маршруты Django (ТЗ §6.2): ROOT_URLCONF, include() по модулю, списку и списку прямо в
вызове, роутер DRF, реэкспорт urlpatterns, недостижимые списки и пути не строкой; обёртки
регистрации с методами в именованных аргументах (ТЗ §15 п. 1)."""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

from archmap_scan import pyast, texts
from archmap_scan.parsers import djangourls
from tests.helpers import FIXTURES, files_of, tree


def _routes(root: Path) -> list[tuple[str, bool, str]]:
    ctx, files = files_of(root)
    found = djangourls.parse(files, ctx)
    assert {r.method for r in found.routes} <= {"ANY"}
    return sorted((r.path, r.prefix_unresolved, str(r.loc)) for r in found.routes)


def _methods(root: Path) -> list[tuple[str, str, bool, str]]:
    ctx, files = files_of(root)
    found = djangourls.parse(files, ctx)
    return sorted((r.method, r.path, r.prefix_unresolved, str(r.loc)) for r in found.routes)


def test_fixture_routes() -> None:
    # Список с обёрткой api_path подключён дважды: под api/v1/ и под json/.
    assert _methods(FIXTURES / "django-urls") == [
        ("ANY", "/", False, "mysite/urls.py:32"),
        ("ANY", "/api/orders/", False, "mysite/urls.py:9"),
        ("ANY", "/api/orders/{id}/", False, "mysite/urls.py:9"),
        ("ANY", "/api/v1/items/<int:pk>/", False, "mysite/urls.py:12"),
        ("ANY", "/api/v1/legacy/(?P<slug>[-\\w]+)/", False, "mysite/urls.py:13"),
        ("ANY", "/extra/", False, "mysite/extra_urls.py:5"),
        ("ANY", "/inline/a/", False, "mysite/urls.py:36"),
        ("ANY", "/inline/b/", False, "mysite/urls.py:36"),
        ("ANY", "/lost/", True, "orphan/urls.py:6"),
        ("ANY", "/shop/cart/", False, "shop/urls.py:6"),
        ("ANY", "/shop/checkout/", False, "shop/urls.py:7"),
        ("DELETE", "/api/v1/carts/<int:pk>/", False, "mysite/urls.py:26"),
        ("DELETE", "/json/carts/<int:pk>/", False, "mysite/urls.py:26"),
        ("GET", "/api/v1/carts/", False, "mysite/urls.py:25"),
        ("GET", "/json/carts/", False, "mysite/urls.py:25"),
        ("POST", "/api/v1/carts/", False, "mysite/urls.py:25"),
        ("POST", "/json/carts/", False, "mysite/urls.py:25"),
    ]


def test_fixture_dynamic_and_comment() -> None:
    ctx, files = files_of(FIXTURES / "django-urls")
    found = djangourls.parse(files, ctx)
    # Путь обёртки выражением — подсказка (одна, хотя список подключён дважды);
    # health_path возвращает path с литералом и обёрткой не считается: ни маршрута, ни
    # подсказки.
    assert sorted((h.data["source"], h.data["name"]) for h in found.hints) == [
        ("mysite/urls.py:28", "'carts/' + CART"), ("mysite/urls.py:44", "NAME"),
    ]
    assert {h.data["reason"] for h in found.hints} == {texts.REASON_DYNAMIC_ROUTE}
    assert not any("commented" in r.path or "health" in r.path for r in found.routes)


VIEWS = "def v(request):\n    return None\n"


def test_reexported_root_and_no_root_urlconf(tmp_path: Path) -> None:
    # Корень реэкспортирует urlpatterns другого модуля (так устроен Sentry).
    tree(tmp_path / "a", {
        "requirements.txt": "django\n",
        "proj/settings.py": 'ROOT_URLCONF = "proj.urls"\n',
        "proj/urls.py": "from web.urls import urlpatterns\n",
        "web/urls.py": "from django.urls import path\nfrom web.views import v\n"
        'urlpatterns = [path("home/", v)]\n',
        "web/views.py": VIEWS,
    })
    assert _routes(tmp_path / "a") == [("/home/", False, "web/urls.py:3")]
    # Без ROOT_URLCONF корень — urlpatterns, который никто не подключает.
    tree(tmp_path / "b", {
        "requirements.txt": "django\n",
        "urls.py": "from django.urls import include, path\n"
        'urlpatterns = [path("app/", include("app.urls"))]\n',
        "app/urls.py": "from django.urls import path\n"
        'urlpatterns = [path("x/", None), path("y/", None)]\n',
    })
    assert _routes(tmp_path / "b") == [
        ("/app/x/", False, "app/urls.py:2"), ("/app/y/", False, "app/urls.py:2"),
    ]


def test_cycles_and_self_extension_terminate(tmp_path: Path) -> None:
    tree(tmp_path, {
        "requirements.txt": "django\n",
        "a/urls.py": "from django.urls import include, path\n"
        'urlpatterns = [path("b/", include("b.urls")), path("a/", None)]\n'
        'urlpatterns = urlpatterns + [path("more/", None)]\n',
        "b/urls.py": "from django.urls import include, path\n"
        'urlpatterns = [path("a/", include("a.urls")), path("leaf/", None)]\n',
    })
    # Корня нет (оба списка подключены друг другом): маршруты есть, но нерешённые.
    assert _routes(tmp_path) == [
        ("/a/", True, "a/urls.py:2"), ("/b/leaf/", True, "b/urls.py:2"),
        ("/more/", True, "a/urls.py:3"),
    ]


WRAP = (
    "from django.urls import path\n"
    "def api_path(route, **handlers):\n    return path(route, dispatch, handlers)\n"
)


def test_wrapper_forms(tmp_path: Path) -> None:
    """Обёртка в том же модуле, по импорту модуля, под другим именем и с путём route=;
    без методов в аргументах — ANY; include() среди аргументов и обёртка над обёрткой не
    маршруты (один уровень)."""
    tree(tmp_path, {
        "requirements.txt": "django\n",
        "api/__init__.py": "",
        "api/routing.py": WRAP + "def twice(route, **kw):\n    return api_path(route, **kw)\n"
        "def mount(route, target):\n    return path(route, include(target))\n",
        "urls.py": "from django.urls import include, path\n"
        "from api import routing\n"
        "from api.routing import api_path as ap, twice, mount\n"
        "def local(route, view=None, **kw):\n"
        "    if view:\n        return path(route, view)\n"
        "    def inner(x):\n        return path(x, None)\n"
        "    return re_path(route=route, view=None)\n"
        "urlpatterns = [\n"
        '    local("own/", POST=v),\n'
        '    routing.api_path(route="mod/", PUT=v, extra=1),\n'
        '    ap("alias/", HEAD=v, OPTIONS=v),\n'
        '    ap("bare/"),\n'
        '    ap("inc/", GET=include("x.urls")),\n'
        '    twice("deep/", GET=v),\n'
        '    mount("m/", "x.urls"),\n'
        '    unknown("u/", GET=v),\n'
        "]\n",
    })
    assert _methods(tmp_path) == [
        ("ANY", "/bare/", False, "urls.py:14"),
        ("HEAD", "/alias/", False, "urls.py:13"),
        ("OPTIONS", "/alias/", False, "urls.py:13"),
        ("POST", "/own/", False, "urls.py:11"),
        ("PUT", "/mod/", False, "urls.py:12"),
    ]


def test_wrapper_cache_and_cycle(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Модуль обёртки импортирует сам список маршрутов (цикл импортов) и держит свой
    список: разбор идёт один уровень, каждый файл разбирается один раз (дерево модуля,
    разобранного ради определения, переходит к разбору списков), ответ по (файл, имя)
    кэшируется, и отрицательный тоже."""
    wrappers = (
        "from proj import urls\nfrom proj.urls import urlpatterns as top\n"
        + WRAP + 'urlpatterns = [api_path("c/", DELETE=v), unknown("z/"), unknown("w/")]\n'
    )
    urls = (
        "from django.urls import include, path\nfrom proj.wrappers import api_path\n"
        'urlpatterns = [api_path("a/", GET=v), api_path("b/", POST=v),\n'
        '    unknown("x/"), unknown("y/"), path("r/", include("proj.wrappers"))]\n'
    )
    tree(tmp_path, {
        "requirements.txt": "django\n",
        "proj/settings.py": 'ROOT_URLCONF = "proj.urls"\n',
        "proj/urls.py": urls,
        "proj/wrappers.py": wrappers,
    })
    parsed: list[str] = []
    real_parse = pyast.parse

    def counted_parse(text: str) -> ast.Module | None:
        parsed.append(text)
        return real_parse(text)

    resolved: list[tuple[str, str]] = []
    real_resolve = djangourls._Urls._resolve_wrapper

    def counted_resolve(self: djangourls._Urls, mod: djangourls._Module, name: str) -> str | None:
        resolved.append((mod.rel, name))
        return real_resolve(self, mod, name)

    monkeypatch.setattr(pyast, "parse", counted_parse)
    monkeypatch.setattr(djangourls._Urls, "_resolve_wrapper", counted_resolve)
    assert _methods(tmp_path) == [
        ("DELETE", "/r/c/", False, "proj/wrappers.py:6"),
        ("GET", "/a/", False, "proj/urls.py:3"),
        ("POST", "/b/", False, "proj/urls.py:3"),
    ]
    assert parsed.count(urls) == 1 and parsed.count(wrappers) == 1
    assert sorted(resolved) == [
        ("proj/urls.py", "api_path"), ("proj/urls.py", "unknown"),
        ("proj/wrappers.py", "api_path"), ("proj/wrappers.py", "unknown"),
    ]
