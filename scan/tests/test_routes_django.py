"""Маршруты Django (ТЗ §6.2): ROOT_URLCONF, include() по модулю, списку и списку прямо в
вызове, роутер DRF, реэкспорт urlpatterns, недостижимые списки и пути не строкой."""

from __future__ import annotations

from pathlib import Path

from archmap_scan import texts
from archmap_scan.parsers import djangourls
from tests.helpers import FIXTURES, files_of, tree


def _routes(root: Path) -> list[tuple[str, bool, str]]:
    ctx, files = files_of(root)
    found = djangourls.parse(files, ctx)
    assert {r.method for r in found.routes} <= {"ANY"}
    return sorted((r.path, r.prefix_unresolved, str(r.loc)) for r in found.routes)


def test_fixture_routes() -> None:
    assert _routes(FIXTURES / "django-urls") == [
        ("/", False, "mysite/urls.py:16"),
        ("/api/orders/", False, "mysite/urls.py:8"),
        ("/api/orders/{id}/", False, "mysite/urls.py:8"),
        ("/api/v1/items/<int:pk>/", False, "mysite/urls.py:11"),
        ("/api/v1/legacy/(?P<slug>[-\\w]+)/", False, "mysite/urls.py:12"),
        ("/extra/", False, "mysite/extra_urls.py:5"),
        ("/inline/a/", False, "mysite/urls.py:20"),
        ("/inline/b/", False, "mysite/urls.py:20"),
        ("/lost/", True, "orphan/urls.py:6"),
        ("/shop/cart/", False, "shop/urls.py:6"),
        ("/shop/checkout/", False, "shop/urls.py:7"),
    ]


def test_fixture_dynamic_and_comment() -> None:
    ctx, files = files_of(FIXTURES / "django-urls")
    found = djangourls.parse(files, ctx)
    assert [h.data for h in found.hints] == [{
        "kind": "route", "name": "NAME", "reason": texts.REASON_DYNAMIC_ROUTE,
        "source": "mysite/urls.py:26",
    }]
    assert not any("commented" in r.path for r in found.routes)


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
