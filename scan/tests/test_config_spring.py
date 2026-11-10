"""Параметры из файлов настроек Spring Boot и Quarkus (ТЗ §15 п. 17 Е1): документы YAML и
.properties, профили, подстановки ${X:d}, владельцы, слияние, пределы и враждебный вход."""

from __future__ import annotations

from functools import partial
from pathlib import Path

import pytest

from archmap_scan import jvmconf, registry, stats, texts
from archmap_scan.model import Findings
from archmap_scan.parsers import springconf
from archmap_scan.yamlload import MAX_YAML_BYTES
from tests.helpers import FIXTURES, files_of, model_of, time_limit, timed, tree

GW = "gateway/src/main/resources"
SRV = "server/src/main/resources/application.properties"
BOOT = (
    "<project><artifactId>x</artifactId><dependencies><dependency>"
    "<artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>\n"
)


def _params(root: Path) -> list[tuple[str, str | None, bool, bool | None, str | None, str]]:
    ctx, files = files_of(root)
    found = springconf.parse(files, ctx)
    return sorted(
        (p.name, p.default, p.has_default, p.required, p.type, str(p.loc))
        for p in found.code_params
    )


def test_fixture() -> None:
    yml, props = f"{GW}/application.yml", f"{GW}/bootstrap.properties"
    assert _params(FIXTURES / "spring-config") == [
        # Подстановка без дефолта — обязательный параметр; с дефолтом — дефолт как написан.
        ("CONFIG_SERVER_URL", "http://localhost:8888/", True, False, "string", f"{yml}:7"),
        ("DB_PASSWORD", None, False, True, None, f"{yml}:9"),
        # Вложенная подстановка: у внешней дефолт не литерал, у внутренней литерал.
        ("POOL_DEFAULT", "7", True, False, "int", f"{yml}:10"),
        ("POOL_SIZE", None, True, False, None, f"{yml}:10"),
        ("TIMEOUT_MS", "5000", True, False, "int", f"{props}:8"),
        # Свойство JVM: запись есть, сборка относит его к переменным среды.
        ("file.separator", None, False, True, None, f"{SRV}:4"),
        ("gateway.colon", "value", True, None, "string", f"{props}:5"),
        # Экранированный «=» в ключе и \\u0041 в значении.
        ("gateway.escaped=key", "xA", True, None, "string", f"{props}:7"),
        # Продолжение строки «\\»: ведущие пробелы следующей строки отброшены.
        ("gateway.name", "Gateway of orders", True, None, "string", f"{props}:1"),
        ("gateway.space", "value", True, None, "string", f"{props}:6"),
        ("gateway.timeout", "${TIMEOUT_MS:5000}", True, None, "string", f"{props}:8"),
        ("kc.dir", "${kc.home.dir:default}${file.separator}data", True, None, "string", f"{SRV}:4"),
        ("kc.home.dir", "default", True, False, "string", f"{SRV}:4"),
        ("quarkus.http.port", "8081", True, None, "int", f"{SRV}:1"),
        # Ключ Quarkus с кавычками как написан; «%dev.» — значение профиля, его нет.
        ('quarkus.log.category."io.x".level', "WARN", True, None, "string", f"{SRV}:3"),
        ("server.port", "8080", True, None, "int", f"{yml}:2"),
        ("spring.application.name", "gateway", True, None, "string", f"{yml}:5"),
        # Список одной записью с типом array.
        (
            "spring.cloud.gateway.routes",
            "[{id: orders, uri: lb://orders, predicates: [Path=/api/orders/**]}]", True, None,
            "array", f"{yml}:13",
        ),
        # Значение с подстановкой-адресом дефолтом не пишется (CONFIG_SERVER_URL), как и
        # сам адрес.
        ("spring.config.import", None, True, None, "string", f"{yml}:7"),
        ("spring.datasource.password", "${DB_PASSWORD}", True, None, "string", f"{yml}:9"),
        ("spring.datasource.pool", "${POOL_SIZE:${POOL_DEFAULT:7}}", True, None, "string", f"{yml}:10"),
        ("spring.enabled", "true", True, None, "bool", f"{yml}:21"),
        ("spring.nothing", None, False, None, None, f"{yml}:19"),
        ("spring.ratio", "0.75", True, None, "float", f"{yml}:20"),
    ]


def test_fixture_traps() -> None:
    """Документы профилей (spring.config.activate.on-profile и spring.profiles), файл профиля
    application-docker.yml, каталог тестов и пустое отображение параметров не дают; YAML с
    ошибкой — подсказка в unparsed."""
    ctx, files = files_of(FIXTURES / "spring-config")
    found = springconf.parse(files, ctx)
    names = {p.name for p in found.code_params}
    for trap in ("logging.level", "spring.profiles", "test.only", "spring.empty", "gateway.prod"):
        assert trap not in names, trap
    assert not any("application-docker" in str(p.loc) for p in found.code_params)
    assert [(h.section, h.data["name"], h.data["reason"]) for h in found.hints] == [
        ("unparsed", "broken/src/main/resources/application.yml", texts.REASON_BAD_SETTINGS),
    ]


def test_owner_merge_and_coverage() -> None:
    """Параметры у контейнера модуля, дефолт по правилу секретов и адресов: адрес и пароль
    не пишутся. Свойство JVM — переменная среды, не параметр. Spring Boot в непрочитанных
    параметрах не назван."""
    model = model_of(FIXTURES / "spring-config")
    gateway = model.params["gateway"]
    assert gateway["CONFIG_SERVER_URL"].default is None
    assert gateway["spring.datasource.password"].default is None
    assert gateway["DB_PASSWORD"].required is True
    assert gateway["server.port"].default == "8080" and gateway["server.port"].type == "int"
    server = set(model.params["server"])
    assert "file.separator" not in server and "kc.home.dir" in server
    ctx, files = files_of(FIXTURES / "spring-config")
    found, errors = registry.collect(files, ctx)
    assert errors == {}
    assert not any("Spring" in item for item in stats.code_unsupported(found).get("config", []))


def test_without_stack_not_read(tmp_path: Path) -> None:
    """Файл настроек пакета без Spring Boot и Quarkus и файл вне src/main/resources не читаются."""
    tree(tmp_path, {
        "a/pom.xml": "<project><artifactId>a</artifactId></project>\n",
        "a/src/main/resources/application.properties": "a.b=1\n",
        "b/pom.xml": BOOT,
        "b/config/application.properties": "c.d=1\n",
    })
    assert _params(tmp_path) == []


@pytest.mark.parametrize(("text", "want"), [
    ("a=1\n#---\nspring.config.activate.on-profile=x\nb=2\n#---\nc=3\n", ["a", "c"]),
    ("a: 1\n---\nspring:\n  profiles: dev\nb: 2\n", ["a"]),
    ("a: 1\n---\nspring:\n  profiles: [dev, prod]\nb: 2\n", ["a"]),
    ("a: 1\n---\nspring:\n  profiles:\n    active: dev\nb: 2\n", ["a", "b", "spring.profiles.active"]),
    ("a=x\\\\\nb=y\n", ["a", "b"]),
    ("a=x\\\nb=y\n", ["a"]),
    ("  # comment\n\t! comment\nkey value with spaces\n", ["key"]),
])
def test_documents_and_lines(tmp_path: Path, text: str, want: list[str]) -> None:
    """Разделители документов «#---» и «---», профили, чётное и нечётное число «\\» в конце
    строки, комментарии с отступом."""
    name = "application.yml" if text.startswith("a: ") else "application.properties"
    tree(tmp_path, {"m/pom.xml": BOOT, f"m/src/main/resources/{name}": text})
    assert sorted({p[0] for p in _params(tmp_path)}) == want


def test_limits(tmp_path: Path) -> None:
    """.properties больше 1 МБ, YAML больше предела yamlload и YAML больше чем с MAX_DOCUMENTS
    разделителями «---» непрочитаны с подсказкой; с MAX_DOCUMENTS разделителями читается."""
    docs = jvmconf.MAX_DOCUMENTS
    tree(tmp_path, {
        "m/pom.xml": BOOT,
        "m/src/main/resources/application.properties": "a=" + "x" * 1_100_000 + "\n",
        "n/pom.xml": BOOT,
        "n/src/main/resources/application.yml": "a: " + "x" * 300_000 + "\n",
        "o/pom.xml": BOOT,
        "o/src/main/resources/application.yml": "a: 1\n" + "---\na: 1\n" * (docs + 1),
        "p/pom.xml": BOOT,
        "p/src/main/resources/application.yml": "a: 1\n" + "---\na: 1\n" * docs,
    })
    ctx, files = files_of(tmp_path)
    found = springconf.parse(files, ctx)
    assert len(found.code_params) == docs + 1
    assert {str(p.loc).split("/")[0] for p in found.code_params} == {"p"}
    assert files.too_large == {
        "m/src/main/resources/application.properties", "n/src/main/resources/application.yml",
        "o/src/main/resources/application.yml",
    }
    assert len(found.hints) == 3


# Враждебные файлы настроек вплотную к пределам: тысячи ключей, подстановки без конца и
# вложенные, продолжения строк, экранирование, длинные ключи без разделителя, документы.
_NEAR = 990_000
SETTINGS_HOSTILE = {
    "properties:keys": "".join(f"k{i}=v{i}\n" for i in range(4900)),
    "properties:open-holes": "a=" + "${" * (_NEAR // 2) + "\n",
    "properties:nested-holes": "a=" + "${A:" * 1000 + "x" + "}" * 1000 + "\n",
    "properties:closed-holes": "a=" + "${A}" * (_NEAR // 4) + "\n",
    "properties:braces": "a=${" + "{" * (_NEAR - 5) + "\n",
    "properties:continuations": "a=" + "x\\\n" * (_NEAR // 3) + "\n",
    "properties:backslashes": "a=" + "\\" * _NEAR + "\n",
    "properties:escapes": "a=" + "\\u0041" * (_NEAR // 6) + "\n",
    "properties:long-key": "k" * _NEAR + "\n",
    "properties:documents": "a=1\n#---\n" * (_NEAR // 8),
    "properties:comments": "#\n" * (_NEAR // 2),
    "yml:keys": "".join(f"k{i:05}: v\n" for i in range(4900)),
    "yml:long-values": "".join(f"k{i}: '{'x' * 500}'\n" for i in range((MAX_YAML_BYTES - 100) // 510)),
    "yml:holes": "a: '" + "${" * ((MAX_YAML_BYTES - 100) // 2) + "'\n",
    "yml:documents": "a: 1\n---\n" * (MAX_YAML_BYTES // 10),
    "yml:nested": "a:\n" + "".join("  " * i + f"b{i}:\n" for i in range(1, 49)) + "  " * 49 + "c: 1\n",
}


def _fresh(root: Path) -> Findings:
    """Разбор по новому списку файлов: кэш документов в Files не должен удешевлять повтор
    прогона в timed."""
    ctx, files = files_of(root)
    return springconf.parse(files, ctx)


@pytest.mark.parametrize("kind", sorted(SETTINGS_HOSTILE))
def test_settings_hostile(tmp_path: Path, kind: str) -> None:
    """Враждебные файлы настроек: в пределе с запасом 30 %. YAML вплотную к пределу yamlload
    читается целиком, и время почти всё уходит на общий разбор YAML, поэтому предел у него
    втрое шире (как у config/schedule.yml в test_schedules)."""
    ext = "properties" if kind.startswith("properties") else "yml"
    tree(tmp_path, {
        "m/pom.xml": BOOT, f"m/src/main/resources/application.{ext}": SETTINGS_HOSTILE[kind],
    })
    limit = time_limit() * (3 if ext == "yml" else 0.7)
    _found, took = timed(partial(_fresh, tmp_path), limit)
    assert took < limit, f"{took:.2f} с"


def test_placeholders() -> None:
    ph = jvmconf.placeholders
    assert [(p.name, p.default, p.has_default) for p in ph("${A:${B:c}}")] == [
        ("A", None, True), ("B", "c", True),
    ]
    assert [(p.name, p.default) for p in ph("x${A}y${B:1:2}")] == [("A", None), ("B", "1:2")]
    assert ph("${A:") == [] and ph("${ BAD }") == []
    assert len(ph("${A}" * 1000)) == 200
