"""Маршруты Spring MVC и WebFlux (ТЗ §15 п. 17 К1): аннотации контроллеров Java и Kotlin,
префикс класса, массивы путей, методы @RequestMapping, префикс приложения из файла настроек
модуля. Ловушки: интерфейс @FeignClient, вложенный класс не контроллер, комментарий (и
вложенный комментарий Kotlin), строка и сырая строка, каталоги тестов, путь выражением.
Общее для Java и Kotlin: маска Kotlin, правило пакета JVM в обходе, каталоги тестов по имени."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from archmap_scan import clike, codetext, jvm, registry, stats, texts, walk
from archmap_scan.parsers import spring
from tests.helpers import FIXTURES, files_of, model_of, time_limit, tree

OWNERS = "owners/src/main/java/org/example/samples/owners/web"
GATEWAY = "gateway/src/main/java/org/example/gateway/GatewayController.java"
ITEMS = "items/src/main/kotlin/items/ItemController.kt"
WEB = (
    "<project><artifactId>x</artifactId><dependencies><dependency>"
    "<artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>\n"
)


def _routes(root: Path) -> list[tuple[str, str, bool, str]]:
    ctx, files = files_of(root)
    found = spring.parse(files, ctx)
    return sorted((r.method, r.path, r.prefix_unresolved, str(r.loc)) for r in found.routes)


def test_fixture() -> None:
    owner, pet = f"{OWNERS}/OwnerResource.java", f"{OWNERS}/PetResource.java"
    assert _routes(FIXTURES / "spring-routes") == [
        # @RequestMapping без method: ANY; префикс приложения /api из application.yml модуля
        # (документ профиля docker префикса не даёт).
        ("ANY", "/api/owners/any", False, f"{owner}:30"),
        # Аннотация без пути: путь префикса класса (у PetResource префикса нет).
        ("GET", "/api", False, f"{pet}:12"),
        # method у @RequestMapping класса — метод для @RequestMapping метода без method;
        # префикс приложения подстановкой: префикс не решён.
        ("GET", "/api/gateway/owners/{ownerId}", True, f"{GATEWAY}:6"),
        # Константа другого класса (Paths.PETS).
        ("GET", "/api/gateway/pets", True, f"{GATEWAY}:9"),
        ("GET", "/api/owners", False, f"{owner}:16"),
        # Путь без ведущей косой: косая добавлена, «*» как написана.
        ("GET", "/api/owners/*/pets/{petId}", False, f"{pet}:9"),
        # method = { RequestMethod.GET, RequestMethod.POST }: маршрут на метод.
        ("GET", "/api/owners/fallback", False, f"{owner}:27"),
        # Путь константой класса того же файла.
        ("GET", "/api/owners/{ownerId}", False, f"{owner}:13"),
        ("GET", "/api/petTypes", False, f"{pet}:6"),
        # Модуль client без контейнера: маршрут есть, владельца нет (сборка, не разборщик).
        ("GET", "/client", False, "client/src/main/java/org/example/client/ClientController.java:5"),
        # Kotlin: массив путей класса ["/items", "/v2/items"], suspend fun.
        ("GET", "/items/{id}", False, f"{ITEMS}:9"),
        ("GET", "/v2/items/{id}", False, f"{ITEMS}:9"),
        ("PATCH", "/items/bulk", False, f"{ITEMS}:23"),
        ("PATCH", "/v2/items/bulk", False, f"{ITEMS}:23"),
        ("POST", "/api/owners", False, f"{owner}:10"),
        ("POST", "/api/owners/fallback", False, f"{owner}:27"),
        ("POST", "/items", False, f"{ITEMS}:12"),
        ("POST", "/v2/items", False, f"{ITEMS}:12"),
        ("PUT", "/api/owners/{ownerId}", False, f"{owner}:19"),
        # Переменная с регулярным выражением {ownerId:[0-9]+} пишется {ownerId}.
        ("PUT", "/api/owners/{ownerId}/edit", False, f"{owner}:19"),
        ("PUT", "/items/bulk", False, f"{ITEMS}:23"),
        ("PUT", "/v2/items/bulk", False, f"{ITEMS}:23"),
    ]


def test_fixture_hints_and_traps() -> None:
    """Путь склейкой, шаблоном Kotlin с «$» и вызовом — подсказки с методом. Интерфейс
    @FeignClient, вложенный класс не контроллер, комментарий, строка, сырая строка Kotlin,
    src/test и testsuite/ маршрутов не дают."""
    ctx, files = files_of(FIXTURES / "spring-routes")
    found = spring.parse(files, ctx)
    assert sorted(
        (h.data["name"], h.data["reason"], h.data["source"], h.data["method"]) for h in found.hints
    ) == [
        ('"$base/{id}"', texts.REASON_DYNAMIC_ROUTE, f"{ITEMS}:20", "DELETE"),
        ('"/" + "x"', texts.REASON_DYNAMIC_ROUTE, f"{OWNERS}/OwnerResource.java:23", "DELETE"),
        ('pathFor("x")', texts.REASON_DYNAMIC_ROUTE, f"{GATEWAY}:12", "POST"),
    ]
    paths = {r.path for r in found.routes}
    for trap in (
        "/visits/{petId}", "/helper", "/commented", "/in-string", "/raw", "/test-only",
        "/testsuite-only",
    ):
        assert not any(p.endswith(trap) for p in paths), trap


def test_owner_and_coverage() -> None:
    """Маршруты у контейнеров модулей; модуль без контейнера — подсказка «без владельца».
    Семья покрыта: «Java: Spring Boot» и Kotlin в непрочитанных маршрутах не названы."""
    model = model_of(FIXTURES / "spring-routes")
    assert {k: len(v) for k, v in model.http.items()} == {"owners": 11, "gateway": 2, "items": 8}
    assert {e.framework for v in model.http.values() for e in v} == {"Spring"}
    assert [h["name"] for h in model.hints.get("unassigned", []) if h["kind"] == "route"] == [
        "GET /client",
    ]
    ctx, files = files_of(FIXTURES / "spring-routes")
    found, errors = registry.collect(files, ctx)
    assert errors == {}
    routes = stats.code_unsupported(found).get("http_routes", [])
    assert not any(item.startswith(("Java", "Kotlin")) for item in routes), routes


def test_without_spring_boot_not_read(tmp_path: Path) -> None:
    """Пакет Java без Spring Boot не читается: аннотации там чужие."""
    tree(tmp_path, {
        "a/pom.xml": "<project><artifactId>a</artifactId></project>\n",
        "a/src/main/java/A.java": '@RestController\nclass A {\n  @GetMapping("/a")\n  void a() {}\n}\n',
    })
    ctx, files = files_of(tmp_path)
    found = spring.parse(files, ctx)
    assert found.routes == [] and spring.NAME not in found.applied


def test_controller_variants(tmp_path: Path) -> None:
    """@Controller, полное имя аннотации, value = {…} у метода, аннотации в несколько строк,
    обобщённый возвращаемый тип; класс без @Controller и record маршрутов не дают; префикс
    класса не литералом — одна подсказка на класс."""
    tree(tmp_path, {
        "a/pom.xml": WEB,
        "a/src/main/java/a/A.java": (
            "@org.springframework.stereotype.Controller\n"
            '@RequestMapping(path = "/a/")\n'
            "public class A {\n"
            "    @org.springframework.web.bind.annotation.GetMapping(\n"
            '        value = {"x", "/y/"},\n'
            '        produces = "text/html")\n'
            "    public ResponseEntity<Map<String, List<B>>> x() { return null; }\n"
            "}\n"
            "class Plain {\n"
            '    @GetMapping("/plain")\n'
            "    void p() {}\n"
            "}\n"
            "@RestController\n"
            "@RequestMapping(Base.PATH + \"/z\")\n"
            "class Dyn {\n"
            '    @GetMapping("/1")\n'
            "    void one() {}\n"
            '    @GetMapping("/2")\n'
            "    void two() {}\n"
            "}\n"
        ),
    })
    assert _routes(tmp_path) == [
        ("GET", "/a/x", False, "a/src/main/java/a/A.java:4"),
        ("GET", "/a/y", False, "a/src/main/java/a/A.java:4"),
    ]
    ctx, files = files_of(tmp_path)
    hints = spring.parse(files, ctx).hints
    assert [(h.data["name"], h.data["source"]) for h in hints] == [
        ('Base.PATH + "/z"', "a/src/main/java/a/A.java:14"),
    ]


def test_limits(tmp_path: Path) -> None:
    """Больше 2000 аннотаций в файле — файл непрочитан, записей из него нет."""
    tree(tmp_path, {
        "a/pom.xml": WEB,
        "a/src/main/java/a/A.java": "@RestController\nclass A {\n" + '  @GetMapping("/a") void a() {}\n' * 2001 + "}\n",
        "a/src/main/java/a/B.java": '@RestController\nclass B {\n  @GetMapping("/b") void b() {}\n}\n',
    })
    ctx, files = files_of(tmp_path)
    found = spring.parse(files, ctx)
    assert [r.path for r in found.routes] == ["/b"]
    assert files.too_large == {"a/src/main/java/a/A.java"}


def test_template() -> None:
    """Переменная пути с регулярным выражением пишется именем (ТЗ §15 п. 17 К1, К2)."""
    assert jvm.template("/a/{id}") == "/a/{id}"
    assert jvm.template("/a/{id:[0-9]+}") == "/a/{id}"
    assert jvm.template("{version : v\\d[0-9a-zA-Z_\\-]*}") == "{version}"
    assert jvm.template("{any:.*}") == "{any}"
    assert jvm.template("index.{html:html}") == "index.{html}"
    assert jvm.template("/a/{n:\\d{2}}/b") == "/a/{n}/b"
    assert jvm.template("/a/{x:") == "/a/{x:"


def test_jvm_package_is_not_a_directory() -> None:
    """Каталоги под src/main/java/ и src/main/kotlin/ — имя пакета: сегмент samples у
    org.springframework.samples не исключает код (ТЗ §15 п. 17 К1); каталоги до корня
    исходников и src/test/ по-прежнему исключаются."""
    rule = walk.convention_rule
    assert rule("m/src/main/java/org/springframework/samples/A.java") is None
    assert rule("m/src/main/kotlin/x/examples/A.kt") is None
    assert rule("samples/m/src/main/java/A.java") == ("samples/", True)
    assert rule("m/src/test/java/A.java") == ("m/src/test/", True)
    assert rule("m/samples/A.java") == ("m/samples/", True)


@pytest.mark.parametrize(("rel", "want"), [
    ("testsuite/rest/src/main/java/A.java", True),
    ("test-framework/core/src/main/java/A.java", True),
    ("quarkus/tests/x/A.java", True),
    ("integration-tests/A.java", True),
    ("keycloak-testsuite-utils/A.java", True),
    ("lib/src/testFixtures/java/A.java", True),
    ("Cart.UnitTests/A.cs", True),
    ("Billing.Tests/A.cs", True),
    ("latest/A.java", False),
    ("contest/A.java", False),
    ("attestation/A.java", False),
    ("services/src/main/java/org/test/A.java", False),
    ("testing/A.java", False),
])
def test_test_dirs(rel: str, want: bool) -> None:
    """Каталог тестов у кода Java и Kotlin по имени: часть имени через «-», «_» или «.» —
    test, tests, testsuite, testsuites, набор исходников Gradle testX; слово внутри части
    имени не в счёт."""
    assert clike.in_jvm_test_dir(rel) is want


@pytest.mark.parametrize(("rel", "want"), [
    ("rust/personhog-test-harness/src/cli.rs", False),
    ("testsuite/a.go", False),
    ("Cart.UnitTests/A.cs", True),
    ("billing-tests/a.rs", True),
])
def test_test_dirs_other_languages(rel: str, want: bool) -> None:
    """У других языков правило каталогов тестов прежнее (имя кончается на Test или Tests):
    крейт PostHog rust/personhog-test-harness/ читается, как до части 5б."""
    assert clike.in_test_dir(rel) is want


def test_kotlin_mask() -> None:
    """Маска Kotlin: вложенный комментарий целиком, строка с подстановкой «${…}» и сырая
    строка в несколько строк; длина и переводы строк сохраняются."""
    text = (
        '/* a /* b */ @GetMapping("/c") */ val x = "p${q("r")}s"\n'
        'val y = """\n  @GetMapping("/raw") ""${"\\"}\n""""\n'
        "val c = '\"' // \"/line\"\n"
        'val e = "\\"/esc"\n'
    )
    mask = codetext.mask(text, codetext.KOTLIN)
    assert len(mask) == len(text) and mask.count("\n") == text.count("\n")
    for hidden in ("/c", "/raw", "/line", "/esc", "q(", "GetMapping"):
        assert hidden not in mask, hidden
    assert 'val x = "' in mask and "val y = " in mask and "val c = '" in mask
    assert mask.rstrip("\n").endswith('"')


KOTLIN_HOSTILE = {
    "nested-open": "/*" * 300_000 + "x" * 800_000,
    "nested-pairs": "/* */" * 120_000 + "y" * 800_000,
    "holes": '"${' * 190_000 + "z" * 800_000,
    "raw-open": '"""' + "w" * 2_000_000,
    "raw-runs": '"""a' * 190_000,
    "strings": '"a"' * 190_000 + "b" * 800_000,
}


@pytest.mark.parametrize("name", sorted(KOTLIN_HOSTILE))
def test_kotlin_mask_is_linear(name: str) -> None:
    payload = KOTLIN_HOSTILE[name]
    took = []
    for _ in range(2):
        started = time.process_time()
        assert len(codetext.mask(payload, codetext.KOTLIN)) == len(payload)
        took.append(time.process_time() - started)
    assert min(took) < time_limit()
