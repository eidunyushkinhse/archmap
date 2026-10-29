"""Схема развёртывания у агента (docs/tasks/deployment-view.md, Ф4): площадки деревом
с составом и размещение одного объекта (archmap_deployment).

Фикстуры площадок и строк размещения сверяются схемами САМОГО БЭКЕНДА: подменённый
транспорт форму не валидирует, и без сверки тест зелён на выдуманных полях.

Единица размещения — контейнер (Р16 эпика docs/plan-c4-elements.md): узлы с
element_effective — сервер с элементами; узлы без поля — старый сервер, и вывод обязан
остаться прежним (узел с детьми — система, лист — единица).
"""

from __future__ import annotations

from typing import Any

import pytest
from conftest import FakeApi, backend, node

from archmap_mcp import render, tools
from archmap_mcp.client import ArchMapClient, ArchMapError


def u(n: int) -> str:
    return f"{n:08d}-0000-0000-0000-000000000000"


CLOUD, CLUSTER, VM, RACK = u(1), u(2), u(3), u(4)
ROOT, SHOP, API, CART, PAY, BUYER = u(10), u(11), u(12), u(13), u(14), u(15)


def site(site_id: str, name: str, kind: str, parent: str | None = None, **over: Any) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": site_id, "name": name, "kind": kind, "technology": None, "description": None,
        "parent_id": parent, "version": 1, "instance_count": 0,
    }
    out.update(over)
    backend("schemas.deployment").SiteOut.model_validate(out)
    return out


def ref(site_id: str, name: str, kind: str, parent_name: str | None = None,
        partial: bool = False) -> dict[str, Any]:
    """Строка NodeResponse.sites — площадка объекта (у контейнера partial — стоит часть)."""
    out = {
        "id": site_id, "name": name, "kind": kind,
        "parent_id": CLOUD if parent_name else None, "parent_name": parent_name,
        "partial": partial,
    }
    backend("schemas.node").NodeSiteOut.model_validate(out)
    return out


SITES = [
    site(VM, "ВМ-2", "vm", instance_count=1),
    site(CLOUD, "Облако", "cloud", technology="Yandex Cloud", instance_count=1),
    site(CLUSTER, "Кластер prod", "kubernetes", CLOUD, technology="k3s", instance_count=1),
    site(RACK, "Стойка", "other"),
]

# Площадки контейнера — площадки его объектов: у «Витрины» и «Ярмарки» все частичные
# (API — ВМ-2 и кластер, Корзина — облако, Платежи — нигде).
PART = [
    ref(VM, "ВМ-2", "vm", partial=True),
    ref(CLUSTER, "Кластер prod", "kubernetes", "Облако", partial=True),
    ref(CLOUD, "Облако", "cloud", partial=True),
]
NODES = [
    node(ROOT, "Ярмарка", has_children=True, sites=PART),
    node(SHOP, "Витрина", ROOT, has_children=True, sites=PART),
    node(API, "API", SHOP, sites=[
        ref(VM, "ВМ-2", "vm"), ref(CLUSTER, "Кластер prod", "kubernetes", "Облако"),
    ]),
    node(CART, "Корзина", SHOP, sites=[ref(CLOUD, "Облако", "cloud")]),
    node(PAY, "Платежи", ROOT, sites=[]),
    node(BUYER, "Покупатель", shape="person", sites=[]),
]


def routes(api: FakeApi, sites: list[dict[str, Any]] = SITES, nodes: list[dict[str, Any]] = NODES) -> None:
    api.get("/deployment/sites", sites)
    api.get("/nodes/all", nodes)


async def test_площадки_деревом_с_составом_и_без_размещения(
    client: ArchMapClient, api: FakeApi
) -> None:
    routes(api)

    out = await tools.call("archmap_deployment", {"project": "Ярмарка"}, client)

    assert out.splitlines() == [
        "Проект «Ярмарка» — площадки развёртывания (4):",
        "ВМ-2 [вм] — 1 объект",
        f"  • Ярмарка / Витрина / API  id={API}",
        "Облако [облако, Yandex Cloud] — 1 объект",
        f"  • Ярмарка / Витрина / Корзина  id={CART}",
        "  Кластер prod [kubernetes, k3s] — 1 объект",
        f"    • Ярмарка / Витрина / API  id={API}",
        "Стойка [другое] — пусто",
        # Контейнеры с объектами на разных площадках раскрыты до объектов; Покупатель
        # живёт вне системы.
        "Без размещения: 1 объект",
        f"  • Ярмарка / Платежи  id={PAY}",
    ]


async def test_контейнер_целиком_одной_строкой(client: ArchMapClient, api: FakeApi) -> None:
    """Все объекты контейнера на одном наборе площадок — контейнер одной строкой со
    счётчиком объектов, внутрь дерево не спускается."""
    whole = [ref(CLOUD, "Облако", "cloud")]
    routes(api, [SITES[1]], [
        node(ROOT, "Ярмарка", has_children=True, sites=whole),
        node(SHOP, "Витрина", ROOT, has_children=True, sites=whole),
        node(API, "API", SHOP, sites=whole),
        node(CART, "Корзина", SHOP, sites=whole),
        node(BUYER, "Покупатель", ROOT, shape="person", sites=[]),
    ])

    out = await tools.call("archmap_deployment", {"project": "Ярмарка"}, client)

    assert out.splitlines()[1:] == [
        "Облако [облако, Yandex Cloud] — 2 объекта",
        f"  • Ярмарка (целиком, 2 объекта)  id={ROOT}",
        "Без размещения: нет — все объекты стоят на площадках",
    ]


async def test_состав_площадки_и_без_размещения_с_капом(
    client: ArchMapClient, api: FakeApi
) -> None:
    many = [node(u(100 + i), f"svc-{i:02d}", sites=[ref(VM, "ВМ-2", "vm")]) for i in range(23)]
    lonely = [node(u(200 + i), f"job-{i:02d}", sites=[]) for i in range(21)]
    routes(api, [SITES[0]], [*many, *lonely])

    out = await tools.call("archmap_deployment", {"project": "Ярмарка"}, client)

    lines = out.splitlines()
    assert lines[1] == "ВМ-2 [вм] — 23 объекта"
    assert lines[2:22] == [f"  • svc-{i:02d}  id={u(100 + i)}" for i in range(20)]
    assert lines[22] == "  …и ещё 3"
    assert lines[23] == "Без размещения: 21 объект"
    assert lines[-1] == "  …и ещё 1" and len(lines) == 24 + 20 + 1


async def test_размещение_одного_объекта_и_контейнера(
    client: ArchMapClient, api: FakeApi
) -> None:
    routes(api)

    own = await tools.call("archmap_deployment", {"project": "Ярмарка", "node_id": API}, client)
    container = await tools.call("archmap_deployment", {"project": "Ярмарка", "node_id": SHOP}, client)
    nothing = await tools.call("archmap_deployment", {"project": "Ярмарка", "node_id": PAY}, client)

    assert own.splitlines() == [
        "Проект «Ярмарка»",
        f"Путь: Ярмарка / Витрина / API  id={API}",
        "Размещение (2 площадки):",
        "  • ВМ-2 [вм]",
        "  • Облако / Кластер prod [kubernetes, k3s]",
    ]
    # Контейнер: площадки его объектов, где стоит часть — пометка.
    assert container.splitlines()[2:] == [
        "Размещение (3 площадки):",
        "  • ВМ-2 [вм] — часть объектов",
        "  • Облако / Кластер prod [kubernetes, k3s] — часть объектов",
        "  • Облако [облако, Yandex Cloud] — часть объектов",
    ]
    assert nothing.splitlines()[2:] == ["Размещение: не указано"]


async def test_пользователь_и_неизвестный_объект(client: ArchMapClient, api: FakeApi) -> None:
    routes(api)

    out = await tools.call("archmap_deployment", {"project": "Ярмарка", "node_id": BUYER}, client)
    assert out.splitlines()[-1] == "Размещения нет: пользователь живёт вне системы"

    with pytest.raises(ArchMapError, match="не найден в проекте «Ярмарка»"):
        await tools.call("archmap_deployment", {"project": "Ярмарка", "node_id": u(999)}, client)


async def test_проект_без_площадок_одной_фразой(client: ArchMapClient, api: FakeApi) -> None:
    api.get("/deployment/sites", [])

    out = await tools.call("archmap_deployment", {"project": "Ярмарка"}, client)

    assert out == (
        "Проект «Ярмарка». Площадок нет: размещение задаётся на холсте «Развёртывание» "
        "или разделом deployment в YAML импорта."
    )
    # Без площадок дерево объектов не нужно — лишнего запроса нет.
    assert [c.url.path for c in api.calls][-1].endswith("/deployment/sites")


# Система «Ярмарка»: контейнер orders с компонентами api и worker — на «Облаке» сам;
# лист billing — без размещения. У системы «Облако» частичное.
ORDERS, API_C, WORKER, BILLING = u(20), u(21), u(22), u(23)


def c4_nodes() -> list[dict[str, Any]]:
    cloud = [ref(CLOUD, "Облако", "cloud")]
    return [
        node(ROOT, "Ярмарка", has_children=True, element_effective="system",
             sites=[ref(CLOUD, "Облако", "cloud", partial=True)]),
        node(ORDERS, "orders", ROOT, has_children=True, element="container",
             element_effective="container", sites=cloud),
        node(API_C, "api", ORDERS, element_effective="component", sites=[]),
        node(WORKER, "worker", ORDERS, element_effective="component", sites=[]),
        node(BILLING, "billing", ROOT, element_effective="container", sites=[]),
        node(BUYER, "Покупатель", shape="person", element_effective=None, sites=[]),
    ]


async def test_контейнер_с_компонентами_одной_строкой_без_целиком(
    client: ArchMapClient, api: FakeApi
) -> None:
    """Контейнер — единица: одна строка без хвоста «целиком», хоть у него и есть дети;
    компоненты не размещаются и в «Без размещения» не попадают."""
    routes(api, [SITES[1]], c4_nodes())

    out = await tools.call("archmap_deployment", {"project": "Ярмарка"}, client)

    assert out.splitlines()[1:] == [
        "Облако [облако, Yandex Cloud] — 1 объект",
        f"  • Ярмарка / orders  id={ORDERS}",
        "Без размещения: 1 объект",
        f"  • Ярмарка / billing  id={BILLING}",
    ]


async def test_система_целиком_считает_единицы(client: ArchMapClient, api: FakeApi) -> None:
    """Система, все единицы которой на одном наборе, — «целиком, N объектов» по числу
    единиц (контейнер с компонентами — одна), а не листьев."""
    cloud = [ref(CLOUD, "Облако", "cloud")]
    nodes = c4_nodes()
    nodes[0] = {**nodes[0], "sites": cloud}
    nodes[4] = {**nodes[4], "sites": cloud}
    routes(api, [SITES[1]], nodes)

    out = await tools.call("archmap_deployment", {"project": "Ярмарка"}, client)

    assert out.splitlines()[1:] == [
        "Облако [облако, Yandex Cloud] — 2 объекта",
        f"  • Ярмарка (целиком, 2 объекта)  id={ROOT}",
        "Без размещения: нет — все объекты стоят на площадках",
    ]


async def test_размещение_компонента_называет_контейнер(
    client: ArchMapClient, api: FakeApi
) -> None:
    routes(api, [SITES[1]], c4_nodes())

    out = await tools.call("archmap_deployment", {"project": "Ярмарка", "node_id": API_C}, client)
    own = await tools.call("archmap_deployment", {"project": "Ярмарка", "node_id": ORDERS}, client)

    assert out.splitlines()[2:] == [
        "Размещения нет: это компонент — площадки задаются контейнеру «orders»",
    ]
    assert own.splitlines()[2:] == ["Размещение (1 площадка):", "  • Облако [облако, Yandex Cloud]"]


async def test_инструмент_есть_в_удалённом_наборе_и_только_чтения() -> None:
    assert tools.BY_NAME["archmap_deployment"]["writes"] is False
    assert "archmap_deployment" in [t["name"] for t in tools.remote_catalog(read_only=True)]


def test_превью_ввоза_называет_площадки() -> None:
    """Счётчики семей превью (UnifiedFamilyCountsOut) несут площадки — теми же словами."""
    counts = backend("schemas.unified_import").UnifiedFamilyCountsOut(docs=1, sites=2)
    assert render.family_counts(counts.model_dump()) == "Содержимое: схем логики 1, площадок 2."


def test_слова_вида_площадки_те_же_что_у_бэкенда() -> None:
    from typing import get_args

    assert set(render.SITE_KIND_WORD) == set(get_args(backend("domain_types").SiteKind))
