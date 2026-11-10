"""Связи из файлов настроек Spring (ТЗ §15 п. 17 С1): маршруты Spring Cloud Gateway, сервер
конфигурации и Eureka; начало — контейнер модуля, конец — объект по хосту адреса."""

from __future__ import annotations

from pathlib import Path

from archmap_scan import texts
from archmap_scan.parsers import springconf
from tests.helpers import FIXTURES, files_of, model_of, tree

ROOT = FIXTURES / "spring-links"
GW = "gateway/src/main/resources/application.yml"
ORD = "orders/src/main/resources/application.yml"
BILL = "billing/src/main/resources/bootstrap.properties"
BOOT = (
    "<project><artifactId>x</artifactId><dependencies><dependency>"
    "<artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>\n"
)


def _links(root: Path) -> list[tuple[str, str, str | None, list[str]]]:
    model = model_of(root)
    return [
        (lk.src.name, lk.dst.name, lk.technology, sorted(str(loc) for loc in lk.locs))
        for lk in model.links
    ]


def test_fixture_links() -> None:
    """Маршруты шлюза в списке YAML (и в документе профиля), ключ routes[N].uri в
    .properties, spring.config.import с configserver (подстановка раскрыта дефолтом),
    spring.cloud.config.uri и Eureka через запятую; ключ Quarkus «%dev.» и адрес
    репозитория конфигурации (git.uri) связей не дают."""
    assert _links(ROOT) == [
        ("billing", "config", "HTTP", [f"{BILL}:2"]),
        ("billing", "discovery", "HTTP", [f"{BILL}:3"]),
        ("billing", "orders", "HTTP", [f"{BILL}:4"]),
        ("gateway", "billing", "HTTP", [f"{GW}:14", f"{GW}:34"]),
        ("gateway", "orders", "HTTP", [f"{GW}:10", f"{GW}:24"]),
        ("orders", "config", "HTTP", [f"{ORD}:15", f"{ORD}:5"]),
        ("orders", "discovery", "HTTP", [f"{ORD}:9"]),
    ]


def test_fixture_hints() -> None:
    """Хост не объект — подсказка «другой конец связи не объект схемы», подстановка без
    дефолта — подсказка; localhost и IP ни связи, ни подсказки."""
    model = model_of(ROOT)
    edges = sorted(
        (h["name"], h["reason"], h["source"]) for h in model.hints.get("unassigned", [])
        if h["kind"] == "edge"
    )
    assert edges == [
        ("${ROUTE_URL}", texts.REASON_ADDRESS_PLACEHOLDER, f"{GW}:22"),
        ("gateway→payments", texts.REASON_LINK_NOT_OBJECT, f"{GW}:16"),
    ]


def test_without_owner(tmp_path: Path) -> None:
    """Файл настроек вне каталогов кода контейнеров: подсказка о владельце, а не связь."""
    tree(tmp_path, {
        "compose.yaml": "services:\n  a:\n    image: x/a\n  b:\n    image: x/b\n",
        "lib/pom.xml": BOOT,
        "lib/src/main/resources/application.properties": "spring.cloud.config.uri=http://b:1\n",
    })
    model = model_of(tmp_path)
    assert model.links == []
    hints = [h for h in model.hints.get("unassigned", []) if h["kind"] == "edge"]
    assert [(h["name"], h["reason"]) for h in hints] == [("b", texts.REASON_SHARED_LIB)]


def test_budget(tmp_path: Path) -> None:
    """Не больше 2000 адресов на файл: дальше адреса не смотрятся (враждебный вход)."""
    routes = "".join(f"  - uri: lb://h{i}\n" for i in range(3000))
    tree(tmp_path, {
        "m/pom.xml": BOOT,
        "m/src/main/resources/application.yml": "spring.cloud.gateway.routes:\n" + routes,
    })
    ctx, files = files_of(tmp_path)
    found = springconf.parse(files, ctx)
    assert len(found.path_links) == 2000
