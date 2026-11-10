"""Маршруты JAX-RS (ТЗ §15 п. 17 К2): корневые ресурсы, глаголы, локаторы подресурсов,
наследование методов, префикс приложения. Ловушки: интерфейсы клиента, каталоги тестов,
комментарий, @Path у класса подресурса, цикл и глубина цепочки, Object и класс вне кода."""

from __future__ import annotations

from pathlib import Path

from archmap_scan import registry, stats, texts
from archmap_scan.parsers import jaxrs
from tests.helpers import FIXTURES, files_of, model_of, tree

SRV = "server/src/main/java/org/example"
KT = "kt/src/main/kotlin/kt/KtResource.kt"
API = (
    "<project><artifactId>x</artifactId><dependencies><dependency>"
    "<artifactId>jakarta.ws.rs-api</artifactId></dependency></dependencies></project>\n"
)


def _routes(root: Path) -> list[tuple[str, str, bool, str]]:
    ctx, files = files_of(root)
    found = jaxrs.parse(files, ctx)
    return sorted((r.method, r.path, r.prefix_unresolved, str(r.loc)) for r in found.routes)


def test_fixture() -> None:
    assert _routes(FIXTURES / "jaxrs-routes") == [
        # Префикс приложения: quarkus.http.root-path (/auth, значение профиля %dev не
        # берётся) и @ApplicationPath("/api") модуля server; @Path класса подресурса
        # RealmResource не применяется.
        ("DELETE", "/auth/api/realms/{realm}", False, f"{SRV}/RealmResource.java:8"),
        # Модуль lib-resources подключает server: префикс приложения server.
        ("GET", "/auth/api/lib", False, "lib/src/main/java/org/example/lib/LibResource.java:5"),
        ("GET", "/auth/api/realms", False, f"{SRV}/RealmsResource.java:9"),
        # Класс подресурса по импорту (org.example.a.Named, не b.Named); косые на стыках.
        ("GET", "/auth/api/realms/named/{name}", False, f"{SRV}/a/Named.java:4"),
        ("GET", "/auth/api/realms/{realm}", False, f"{SRV}/RealmResource.java:5"),
        # Перегрузки одного класса — оба маршрута.
        ("GET", "/auth/api/realms/{realm}/users/count", False, f"{SRV}/UsersResource.java:12"),
        ("GET", "/auth/api/realms/{realm}/users/count/{kind}", False, f"{SRV}/UsersResource.java:16"),
        # Метод базового класса, переопределённый наследником, берётся у наследника.
        ("GET", "/auth/api/realms/{realm}/users/find", False, f"{SRV}/UsersResource.java:21"),
        # Переменная с регулярным выражением пишется именем.
        ("GET", "/auth/api/realms/{realm}/users/{id}", False, f"{SRV}/UsersResource.java:4"),
        ("GET", "/auth/api/realms/{version}", False, f"{SRV}/RealmsResource.java:18"),
        # Kotlin: модуль без приложения, префикса нет.
        ("GET", "/kt/hello", False, f"{KT}:5"),
        # Метод абстрактного базового класса наследуется.
        ("OPTIONS", "/auth/api/realms/{realm}/users", False, f"{SRV}/BaseResource.java:4"),
        ("POST", "/auth/api/realms/{realm}/users", False, f"{SRV}/UsersResource.java:8"),
        ("PUT", "/kt/sub", False, f"{KT}:14"),
    ]


def test_fixture_hints_and_traps() -> None:
    """Object и класс вне кода, класс с именем в двух пакетах, путь выражением — подсказки.
    Интерфейс клиента, testsuite/, комментарий маршрутов не дают; цикл RealmResource.self
    обрывает цепочку без подсказки."""
    ctx, files = files_of(FIXTURES / "jaxrs-routes")
    found = jaxrs.parse(files, ctx)
    assert sorted(
        (h.data["name"], h.data["reason"], h.data["source"], h.data.get("method"))
        for h in found.hints
    ) == [
        ("/auth/api/realms/dup", texts.REASON_LOCATOR_AMBIGUOUS, f"{SRV}/RealmsResource.java:26", None),
        ("/auth/api/realms/missing", texts.REASON_LOCATOR_UNKNOWN, f"{SRV}/RealmsResource.java:33", None),
        (
            "/auth/api/realms/{realm}/protocol/{protocol}", texts.REASON_LOCATOR_UNKNOWN,
            f"{SRV}/RealmsResource.java:15", None,
        ),
        ('PREFIX + "/x"', texts.REASON_DYNAMIC_ROUTE, f"{SRV}/RealmsResource.java:22", "GET"),
    ]
    paths = {r.path for r in found.routes}
    assert not any(p.startswith(("/admin", "/testing")) or "ignored" in p for p in paths)
    assert not any("self" in p for p in paths)


def test_owner_and_coverage() -> None:
    """Маршруты у контейнеров модулей; модуль библиотеки без своего контейнера — подсказка.
    Java и Kotlin в непрочитанных маршрутах не названы."""
    model = model_of(FIXTURES / "jaxrs-routes")
    assert {k: len(v) for k, v in model.http.items()} == {"api": 11, "kt": 2}
    assert {e.framework for v in model.http.values() for e in v} == {"JAX-RS"}
    assert [h["name"] for h in model.hints.get("unassigned", []) if h["kind"] == "route"] == [
        "GET /auth/api/lib",
    ]
    ctx, files = files_of(FIXTURES / "jaxrs-routes")
    found, errors = registry.collect(files, ctx)
    assert errors == {}
    routes = stats.code_unsupported(found).get("http_routes", [])
    assert not any(item.startswith(("Java", "Kotlin")) for item in routes), routes


def _chain(n: int, cycle: bool = False) -> dict[str, str | bytes]:
    files: dict[str, str | bytes] = {"a/pom.xml": API}
    for i in range(n):
        nxt = 0 if cycle and i == n - 1 else i + 1
        head = '@Path("/root")\n' if i == 0 else ""
        files[f"a/src/main/java/C{i}.java"] = (
            f"{head}public class C{i} {{\n"
            f'    @GET\n    public String g() {{ return ""; }}\n'
            f'    @Path("s{i}")\n    public C{nxt} next() {{ return null; }}\n'
            "}\n"
        )
    if not cycle:
        files[f"a/src/main/java/C{n}.java"] = f'public class C{n} {{\n    @GET\n    public String g() {{ return ""; }}\n}}\n'
    return files


def test_chain_depth_and_cycle(tmp_path: Path) -> None:
    """Цепочка не длиннее восьми локаторов: дальше подсказка; цикл A → B → A обрывается без
    подсказки, маршруты до повтора записаны."""
    deep = tree(tmp_path / "deep", _chain(12))
    ctx, files = files_of(deep)
    found = jaxrs.parse(files, ctx)
    assert len(found.routes) == 9
    assert max(r.path.count("/") for r in found.routes) == 9
    assert [(h.data["reason"], h.data["source"]) for h in found.hints] == [
        (texts.REASON_LOCATOR_DEPTH, "a/src/main/java/C8.java:4"),
    ]
    loop = tree(tmp_path / "loop", _chain(2, cycle=True))
    ctx, files = files_of(loop)
    found = jaxrs.parse(files, ctx)
    assert sorted(r.path for r in found.routes) == ["/root", "/root/s0"]
    assert found.hints == []


def test_without_jaxrs_not_read(tmp_path: Path) -> None:
    tree(tmp_path, {
        "a/pom.xml": "<project><artifactId>a</artifactId></project>\n",
        "a/src/main/java/A.java": '@Path("/a")\npublic class A {\n  @GET\n  public String a() { return ""; }\n}\n',
    })
    ctx, files = files_of(tmp_path)
    found = jaxrs.parse(files, ctx)
    assert found.routes == [] and jaxrs.NAME not in found.applied


def test_class_path_dynamic_and_application_conflict(tmp_path: Path) -> None:
    """@Path класса не литералом — подсказка на класс; два разных @ApplicationPath у одного
    приложения — префикс не решён."""
    tree(tmp_path, {
        "a/pom.xml": API,
        "a/src/main/java/A.java": '@ApplicationPath("/one")\npublic class A extends Application {}\n',
        "a/src/main/java/B.java": '@ApplicationPath("/two")\npublic class B extends Application {}\n',
        "a/src/main/java/R.java": (
            '@Path("/r")\npublic class R {\n    @GET\n    public String g() { return ""; }\n}\n'
        ),
        "a/src/main/java/D.java": (
            "@Path(Base.ROOT)\npublic class D {\n    @GET\n    public String g() { return \"\"; }\n}\n"
        ),
    })
    assert _routes(tmp_path) == [("GET", "/r", True, "a/src/main/java/R.java:3")]
    ctx, files = files_of(tmp_path)
    hints = jaxrs.parse(files, ctx).hints
    assert [(h.data["name"], h.data["source"]) for h in hints] == [("Base.ROOT", "a/src/main/java/D.java:1")]
