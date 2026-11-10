"""Параметры Spring в коде Java и Kotlin (ТЗ §15 п. 17 Е2): @Value над полем, свойством,
параметром и сеттером, @ConfigurationProperties над классом, record и data class."""

from __future__ import annotations

from pathlib import Path

import pytest

from archmap_scan import registry, texts
from archmap_scan.parsers import springvalue
from tests.helpers import FIXTURES, files_of, model_of, tree

ROOT = FIXTURES / "spring-value"
KT = "kt/src/main/kotlin/org/example/kt/KtConfig.kt"
REC = "recs/src/main/java/org/example/recs/RecService.java"
MAIL = "vets/src/main/java/org/example/vets/MailProperties.java"
VETS = "vets/src/main/java/org/example/vets/VetsProperties.java"
BOOT = (
    "<project><artifactId>x</artifactId><dependencies><dependency>"
    "<artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>\n"
)


def _params(root: Path) -> list[tuple[str, str | None, bool, bool | None, str | None, str]]:
    ctx, files = files_of(root)
    found = springvalue.parse(files, ctx)
    return sorted(
        (p.name, p.default, p.has_default, p.required, p.type, str(p.loc))
        for p in found.code_params
    )


def test_fixture() -> None:
    assert _params(ROOT) == [
        # Значение из двух подстановок: тип только по дефолту.
        ("a.first", None, False, True, None, f"{REC}:26"),
        ("a.second", "2", True, False, "int", f"{REC}:26"),
        # Вложенная подстановка: у внешней дефолт не литерал, тип по полю int.
        ("inner.key", "5", True, False, "int", f"{REC}:29"),
        # Константа Java раскрыта.
        ("keys.constant", "c", True, False, "string", f"{REC}:35"),
        # Kotlin: data class с дефолтами параметров и вложенный тип того же файла.
        ("kt.cache.ttl", "60", True, None, "int", f"{KT}:8"),
        # @field:Value — цель применения Kotlin.
        ("kt.field", "x", True, False, "string", f"{KT}:15"),
        ("kt.flag", None, False, True, "string", f"{KT}:12"),
        ("kt.heap-size", "100", True, None, "int", f"{KT}:7"),
        ("kt.name", None, False, None, "string", f"{KT}:7"),
        ("kt.port", "8080", True, False, "int", f"{KT}:11"),
        # Свойство var тела; val и переменная функции не свойства.
        ("kt.vars.size", "5", True, None, "int", f"{KT}:24"),
        # Lombok @Data, префикс константой; static не свойство.
        ("lombok.name", "n", True, None, "string", f"{MAIL}:48"),
        ("outer.key", None, True, False, "int", f"{REC}:29"),
        # @DefaultValue у компонента record.
        ("rec.label", None, False, None, "string", f"{MAIL}:53"),
        ("rec.size", "7", True, None, "int", f"{MAIL}:53"),
        # Параметр конструктора: тип long — int (ожидание брифа по OpenTelemetry Demo).
        ("recommendation.catalog-timeout-ms", "2000", True, False, "int", f"{REC}:10"),
        ("recommendation.mode", None, False, True, "string", f"{REC}:11"),
        ("shop.flags", "a,b", True, False, "array", f"{REC}:42"),
        ("shop.mail.enabled", None, False, None, "bool", f"{MAIL}:15"),
        # Литерал 1_000L пишется числом.
        ("shop.mail.max-size-bytes", "1000", True, None, "int", f"{MAIL}:20"),
        ("shop.mail.port", "25", True, None, "int", f"{MAIL}:13"),
        ("shop.mail.recipients", None, False, None, "array", f"{MAIL}:16"),
        ("shop.mail.retry.attempts", "3", True, None, "int", f"{MAIL}:33"),
        # Второй уровень вложенности не раскрывается: свойство без типа.
        ("shop.mail.retry.deep", None, False, None, None, f"{MAIL}:34"),
        ("shop.mail.sender", "shop", True, None, "string", f"{MAIL}:12"),
        # Инициализатор не литерал: дефолт есть, но не пишется.
        ("shop.mail.timeout", None, True, None, "duration", f"{MAIL}:14"),
        ("shop.name", None, False, True, "string", f"{REC}:14"),
        ("shop.ratio", "0.5", True, False, "float", f"{REC}:17"),
        # Сеттер с @Value: тип по параметру.
        ("shop.timeout", "PT5S", True, False, "duration", f"{REC}:38"),
        ("vets.cache.heap-size", None, False, None, "int", f"{VETS}:13"),
        ("vets.cache.ttl", None, False, None, "int", f"{VETS}:12"),
        ("vets.title", None, False, None, "string", f"{VETS}:9"),
    ]


def test_fixture_traps_and_hints() -> None:
    """SpEL «#{…}», литерал без «${», @lombok.Value без аргументов, поле без сеттера, static,
    @ConfigurationProperties над методом @Bean и шаблон Kotlin в имени параметров не дают;
    склейка в @Value и в префиксе — подсказки о динамическом имени."""
    ctx, files = files_of(ROOT)
    found = springvalue.parse(files, ctx)
    names = {p.name for p in found.code_params}
    for trap in ("user.region", "literal", "shop.mail.no-setter", "shop.mail.ignored",
                 "bean.made.sender", "kt.vars.fixed", "kt.vars.local", "dyn", "ab.x"):
        assert trap not in names, trap
    assert sorted((h.data["name"], h.data["reason"], h.data["source"]) for h in found.hints) == [
        ('"${" + "dyn}"', texts.REASON_DYNAMIC_PARAM, f"{REC}:32"),
        ('"a" + "b"', texts.REASON_DYNAMIC_PARAM, f"{MAIL}:56"),
    ]
    assert found.applied == {springvalue.NAME}


def test_owner_and_merge_with_settings_file() -> None:
    """Владелец — контейнер модуля; запись кода и ключ файла настроек сливаются: дефолт из
    файла, тип из кода; секрет по имени (keys.constant) дефолтом не пишется."""
    model = model_of(ROOT)
    recs = model.params["recs"]
    ratio = recs["shop.ratio"]
    assert (ratio.default, ratio.type) == ("0.75", "float")
    assert ratio.parsers == {"spring-config", "spring-value"}
    assert recs["recommendation.catalog-timeout-ms"].default == "2000"
    assert recs["keys.constant"].default is None
    assert set(model.params["vets"]) >= {"vets.cache.ttl", "vets.cache.heap-size"}


def test_without_spring_boot_not_read(tmp_path: Path) -> None:
    tree(tmp_path, {
        "a/pom.xml": "<project><artifactId>a</artifactId></project>\n",
        "a/src/main/java/A.java": 'class A { @Value("${a.b}") String x; }\n',
    })
    ctx, files = files_of(tmp_path)
    found = springvalue.parse(files, ctx)
    assert found.code_params == [] and found.applied == set()


@pytest.mark.parametrize(("name", "want"), [
    ("heapSize", "heap-size"), ("ttl", "ttl"), ("max_size", "max-size"),
    ("URLPath", "u-r-l-path"), ("already-dashed", "already-dashed"), ("a_B", "a-b"),
])
def test_dashed(name: str, want: str) -> None:
    """Имя свойства как у Spring (DataObjectPropertyName.toDashedForm)."""
    assert springvalue.dashed(name) == want


@pytest.mark.parametrize(("code", "want"), [
    # Аннотация с пакетом и пробелами, поле с параметрами типа.
    ('class A { @ org.x.Value ( "${a.b:1}" ) private java.util.List<String> x; }', [
        ("a.b", "1", "array")]),
    # Массив в Java и Kotlin, vararg.
    ('class A { A(@Value("${a.c}") String... xs) {} }', [("a.c", None, "array")]),
    # Метод не сеттер (два параметра): тип по дефолту.
    ('class A { @Value("${a.d:5}") void set(int a, int b) {} }', [("a.d", "5", "int")]),
    # Пустой дефолт.
    ('class A { @Value("${a.e:}") String x; }', [("a.e", "", "string")]),
])
def test_value_forms(tmp_path: Path, code: str, want: list[tuple[str, str | None, str]]) -> None:
    tree(tmp_path, {"m/pom.xml": BOOT, "m/src/main/java/A.java": code + "\n"})
    assert [(p[0], p[1], p[4]) for p in _params(tmp_path)] == want


def test_registered_as_code_parser() -> None:
    spec = next(p for p in registry.PARSERS if p.name == springvalue.NAME)
    assert spec.code and spec.families == ("config",)
