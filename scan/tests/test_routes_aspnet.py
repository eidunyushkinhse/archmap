"""Маршруты ASP.NET Core (ТЗ §15 п. 15 К2): минимальный API (Map*, MapGroup, MapMethods,
MapHealthChecks) и атрибуты контроллеров по маске C#. Ловушки: вызов в комментарии и строке,
MapGrpcService и MapHub, класс не контроллер, файл тестов, путь с подстановкой."""

from __future__ import annotations

from pathlib import Path

from archmap_scan import registry, stats, texts
from archmap_scan.parsers import aspnet
from tests.helpers import FIXTURES, files_of, model_of, tree

WEB = '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>\n'


def _routes(root: Path) -> list[tuple[str, str, bool, str]]:
    ctx, files = files_of(root)
    found = aspnet.parse(files, ctx)
    return sorted((r.method, r.path, r.prefix_unresolved, str(r.loc)) for r in found.routes)


def test_fixture() -> None:
    home = "src/Api/Controllers/HomeController.cs"
    catalog = "src/Api/Controllers/CatalogController.cs"
    assert _routes(FIXTURES / "aspnet-routes") == [
        # Два [Route] на методе без глагола: два маршрута ANY.
        ("ANY", "/", False, f"{home}:8"),
        ("ANY", "/home", False, f"{home}:8"),
        ("DELETE", "/api/v1/items/{id:int}", False, "src/Api/Program.cs:10"),
        # [Route("about")] и [HttpGet] без шаблона: шаблон берётся из [Route].
        # Проект только с FrameworkReference: стек опознан; маршрут по соглашению по шаблону
        # проекта (П5).
        ("GET", "/Account/Login", False, "src/Identity/Controllers/AccountController.cs:3"),
        ("GET", "/about", False, f"{home}:11"),
        # [controller] — имя класса без суффикса Controller как написано.
        ("GET", "/api/Catalog", False, f"{catalog}:7"),
        ("GET", "/api/Catalog/{id}", False, f"{catalog}:10"),
        ("GET", "/api/v1/items", False, "src/Api/Program.cs:7"),
        ("GET", "/health", False, "src/Api/Program.cs:15"),
        ("GET", "/legacy", False, "src/Api/Program.cs:14"),
        # Шаблон с «/» в начале — от корня.
        ("GET", "/privacy", False, f"{home}:14"),
        # Группа с путём не литералом: префикс не решён.
        ("GET", "/unresolved", True, "src/Api/Program.cs:21"),
        ("HEAD", "/check", False, "src/Api/Program.cs:13"),
        ("OPTIONS", "/check", False, "src/Api/Program.cs:13"),
        # Группа группы складывает префиксы.
        ("PATCH", "/api/v1/admin/users/{id}", False, "src/Api/Program.cs:12"),
        # Суффикс Async у действия отброшен, шаблон с {area} не используется (П5).
        ("POST", "/Account/Logout", False, "src/Identity/Controllers/AccountController.cs:6"),
        # Без [Route] у класса и метода — маршрут по соглашению /Контроллер/действие; шаблона
        # в проекте Api нет (шаблон проекта Identity сюда не относится): префикс не решён.
        ("POST", "/Home/Feedback", True, f"{home}:18"),
        # [action] — имя метода.
        ("POST", "/api/Catalog/Import", False, f"{catalog}:13"),
        ("POST", "/api/v1/items", False, "src/Api/Program.cs:8"),
        ("POST", "/legacy", False, "src/Api/Program.cs:14"),
        ("PUT", "/api/v1/items/{id:int}", False, "src/Api/Program.cs:9"),
    ]


def test_framework_reference_is_dependency() -> None:
    """<FrameworkReference Include="Microsoft.AspNetCore.App" /> — зависимость пакета в
    нижнем регистре (ТЗ §15 п. 16 П5): по ней опознан ASP.NET Core."""
    ctx, files = files_of(FIXTURES / "aspnet-routes")
    from archmap_scan import codebase

    pkg = next(p for p in codebase.packages(files, ctx) if p.path == "src/Identity/Identity.csproj")
    assert pkg.deps == ("microsoft.aspnetcore.app",)


def test_template_path() -> None:
    """Путь по шаблону соглашения: {controller} и {action} подставлены (значения по
    умолчанию и ограничения не мешают), необязательные отброшены, остальное как написано."""
    assert aspnet._template_path("{controller=Home}/{action=Index}/{id?}", "Account", "Login") == (
        "/Account/Login"
    )
    assert aspnet._template_path("api/{Controller}/{action}/{id:int?}", "A", "B") == "/api/A/B"
    assert aspnet._template_path("{controller}/{action}/{id}", "A", "B") == "/A/B/{id}"
    assert aspnet._template_path("{controller}-{action}/{*slug}", "A", "B") == "/A-B/{*slug}"


def test_conventional_template_not_literal(tmp_path: Path) -> None:
    """Шаблон не литералом: путь /Контроллер/действие с prefix_unresolved, как без шаблона;
    позиционный второй аргумент и pattern: читаются, MapDefaultControllerRoute — шаблон по
    умолчанию."""
    controller = "class AController : Controller {\n  [HttpGet]\n  public X GetAsync() => 1;\n}\n"
    cases = {
        'app.MapControllerRoute("d", Pattern);\n': ("/A/Get", True),
        'app.MapControllerRoute(name: "d", pattern: "x/{controller}/{action}");\n': ("/x/A/Get", False),
        "app.MapDefaultControllerRoute();\n": ("/A/Get", False),
    }
    for i, (program, want) in enumerate(cases.items()):
        root = tree(tmp_path / str(i), {
            "App/App.csproj": WEB, "App/Program.cs": program, "App/AController.cs": controller,
        })
        assert [(p, u) for _m, p, u, _l in _routes(root)] == [want], program


def test_fixture_hints() -> None:
    """Путь с подстановкой и группа с путём из переменной — подсказки о динамическом пути.
    Вызов в комментарии и строке, MapGrpcService, MapHub, класс не контроллер и файл
    тестов маршрутов не дают."""
    ctx, files = files_of(FIXTURES / "aspnet-routes")
    found = aspnet.parse(files, ctx)
    assert [(h.section, h.data["name"], h.data["reason"], h.data["source"]) for h in found.hints] == [
        ("dynamic_names", '$"/{prefix}/dynamic"', texts.REASON_DYNAMIC_ROUTE, "src/Api/Program.cs:19"),
        ("dynamic_names", "prefix", texts.REASON_DYNAMIC_ROUTE, "src/Api/Program.cs:20"),
    ]
    paths = {r.path for r in found.routes}
    for trap in ("/commented", "/in-string", "/hubs/chat", "/from-test", "/ignored"):
        assert trap not in paths


def test_owner_and_coverage() -> None:
    """Маршруты у контейнера проекта, семья покрыта: .NET в непрочитанных маршрутах нет.
    Контейнер в фикстуре один (Dockerfile только у Api), поэтому и маршруты проекта Identity
    его (единственный контейнер со своим кодом, ТЗ §7)."""
    model = model_of(FIXTURES / "aspnet-routes")
    assert {k: len(v) for k, v in model.http.items()} == {"Api": 21}
    assert {e.framework for e in model.http["Api"]} == {"ASP.NET Core"}
    ctx, files = files_of(FIXTURES / "aspnet-routes")
    found, errors = registry.collect(files, ctx)
    assert errors == {}
    assert ".NET" not in stats.code_unsupported(found).get("http_routes", [])


def test_without_web_not_read(tmp_path: Path) -> None:
    """Проект .NET без веб-SDK и без Microsoft.AspNetCore.* не читается."""
    tree(tmp_path, {
        "App/App.csproj": '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
        "App/Program.cs": 'app.MapGet("/a", () => 1);\n',
    })
    ctx, files = files_of(tmp_path)
    found = aspnet.parse(files, ctx)
    assert found.routes == [] and aspnet.NAME not in found.applied


def test_package_reference_and_prefixes(tmp_path: Path) -> None:
    """Зависимость Microsoft.AspNetCore.* включает чтение. Вызов берёт последнее
    присваивание группы до себя, цепочка вызовов даёт нерешённый префикс, «~/» — от корня,
    $"…" без подстановки — литерал, [Route] класса не литералом — подсказка."""
    tree(tmp_path, {
        "Lib/Lib.csproj": (
            '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>'
            '<PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="8.0.0" />'
            "</ItemGroup></Project>\n"
        ),
        "Lib/Endpoints.cs": (
            'var g = app.MapGroup("/one");\n'
            'g.MapGet("/a", h);\n'
            'g = app.MapGroup("/two");\n'
            'g.MapGet($"/b", h);\n'
            'app.MapGroup("/x").MapGet("/c", h);\n'
        ),
        "Lib/Controllers.cs": (
            "[ApiController]\n"
            '[Route("api")]\n'
            "public class UsersController : ControllerBase {\n"
            '  [HttpGet("~/root/[controller]")]\n'
            "  public IActionResult Root() => Ok();\n"
            "}\n"
            "[ApiController]\n"
            "[Route(Prefix)]\n"
            "public class DynController : ControllerBase {\n"
            '  [HttpGet("x")]\n'
            "  public IActionResult X() => Ok();\n"
            '  [HttpGet("y")]\n'
            "  public IActionResult Y() => Ok();\n"
            "}\n"
        ),
    })
    assert _routes(tmp_path) == [
        ("GET", "/c", True, "Lib/Endpoints.cs:5"),
        ("GET", "/one/a", False, "Lib/Endpoints.cs:2"),
        ("GET", "/root/Users", False, "Lib/Controllers.cs:4"),
        ("GET", "/two/b", False, "Lib/Endpoints.cs:4"),
    ]
    ctx, files = files_of(tmp_path)
    hints = aspnet.parse(files, ctx).hints
    assert [(h.data["name"], h.data["source"]) for h in hints] == [("Prefix", "Lib/Controllers.cs:8")]


def test_limits(tmp_path: Path) -> None:
    """Больше 2000 вызовов Map* в файле — файл непрочитан, записей из него нет."""
    tree(tmp_path, {
        "Api/Api.csproj": WEB,
        "Api/Program.cs": 'app.MapGet("/a", h);\n' * 2001,
        "Api/Other.cs": 'app.MapGet("/b", h);\n',
    })
    ctx, files = files_of(tmp_path)
    found = aspnet.parse(files, ctx)
    assert [r.path for r in found.routes] == ["/b"]
    assert files.too_large == {"Api/Program.cs"}
