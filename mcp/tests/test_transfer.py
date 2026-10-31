"""Перенос документации и сбор с компонентов (Р19 эпика «Элемент архитектуры»).

Получателей и их флаги считает сервер (GET …/docs/transfer-preview, app/facts_transfer):
MCP их только называет. Фикстуры ответов и тела запросов сверяются схемами САМОГО
БЭКЕНДА — подменённый транспорт форму не судит, и «почти такой» словарь прятал бы
расхождение до живого сервера.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from conftest import FakeApi, backend

from archmap_mcp import tools
from archmap_mcp.client import ArchMapClient, ArchMapError

SHOP = "55555555-5555-5555-5555-555555555555"
ORDERS = "66666666-6666-6666-6666-666666666666"


def u(n: int) -> str:
    return f"{n:08d}-0000-0000-0000-000000000000"


def dump(model: str, **fields: Any) -> dict[str, Any]:
    """Ответ бэкенда как он есть: модель собирается, валидируется и сериализуется."""
    return getattr(backend("schemas.node"), model)(**fields).model_dump(mode="json")


def receiver(n: int, path: str, element: str | None = "container", **flags: bool) -> dict[str, Any]:
    return {
        "node_id": u(n), "path": path, "element_effective": element,
        "takes_docs": flags.get("docs", False), "takes_process_facts": flags.get("process", False),
        "has_spec": flags.get("spec", False),
    }


def shop_preview(**over: Any) -> dict[str, Any]:
    """Система «Ярмарка»: контейнер orders с компонентом api, лист billing со своей
    спецификацией, база orders-db и вложенная система inner — как их видит сервер."""
    fields: dict[str, Any] = {
        "node_id": SHOP, "name": "Ярмарка", "element_effective": "system",
        "docs": [
            {"doc_id": u(1), "name": "Старт заказа", "kind": "operation", "operation": "POST /orders"},
            {"doc_id": u(2), "name": "Ночной пересчёт", "kind": "worker", "operation": None},
        ],
        "has_spec": True, "params": 3,
        "receivers": [
            receiver(10, "billing", docs=True, process=True, spec=True),
            receiver(11, "inner", "system"),
            receiver(12, "orders", process=True),
            receiver(13, "orders / api", "component", docs=True),
            receiver(14, "orders-db"),
        ],
    }
    fields.update(over)
    return dump("TransferDocsPreview", **fields)


def refusal(status: int, detail: str) -> httpx.Response:
    return httpx.Response(status, json={"detail": detail})


def sent_json(api: FakeApi) -> Any:
    return json.loads(api.calls[-1].content)


# ── Перенести документацию: превью ──────────────────────────────────────────

async def test_превью_переноса_называет_своё_и_получателей_с_пометками(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.get(f"/nodes/{SHOP}/docs/transfer-preview", shop_preview())

    out = await tools.call("archmap_transfer_docs_preview", {"project": "Ярмарка", "node_id": SHOP}, client)

    assert api.calls[-1].method == "GET"
    assert api.calls[-1].url.path == f"/api/v1/nodes/{SHOP}/docs/transfer-preview"
    lines = out.splitlines()
    assert f"Объект «Ярмарка» — система. node_id={SHOP}" in lines
    assert f"    • Старт заказа [операция, POST /orders]  doc_id={u(1)}" in lines
    assert f"    • Ночной пересчёт [воркер]  doc_id={u(2)}" in lines
    assert "  Спецификация: есть" in lines and "  Параметров конфигурации: 3" in lines
    # Получатели — в порядке сервера, путём от объекта, с пометками по семьям.
    takers = [line for line in lines if line.startswith("  • ")]
    assert takers == [
        f"  • billing [контейнер] — схемы логики; спецификация и конфигурация (своя спецификация уже есть)  node_id={u(10)}",
        f"  • orders [контейнер] — спецификация и конфигурация  node_id={u(12)}",
        f"  • orders / api [компонент] — схемы логики  node_id={u(13)}",
    ]
    assert "Не принимают ничего: inner, orders-db." in lines
    assert "archmap_transfer_docs_apply" in out and "Ничего не записано" in out


async def test_превью_переноса_пусто_переносить_нечего(client: ArchMapClient, api: FakeApi) -> None:
    api.get(f"/nodes/{SHOP}/docs/transfer-preview", shop_preview(docs=[], has_spec=False, params=0))

    out = await tools.call("archmap_transfer_docs_preview", {"project": "Ярмарка", "node_id": SHOP}, client)

    assert "Переносить нечего: своей документации у объекта нет." in out
    assert "archmap_transfer_docs_apply" not in out


async def test_превью_переноса_у_контейнера_схемы_отдать_некому(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.get(f"/nodes/{ORDERS}/docs/transfer-preview", shop_preview(
        node_id=ORDERS, name="orders", element_effective="container", has_spec=True, params=0,
        receivers=[receiver(14, "orders-db")],
    ))

    out = await tools.call("archmap_transfer_docs_preview", {"project": "Ярмарка", "node_id": ORDERS}, client)

    assert "У контейнера с компонентами не на месте только схемы логики" in out
    assert "  нет — внутри нет ни компонентов, ни объектов без вложенных, ни контейнеров" in out.splitlines()


async def test_превью_переноса_у_листа_отказ_словами_сервера(client: ArchMapClient, api: FakeApi) -> None:
    text = "Внутри «billing» нет объектов, поэтому переносить документацию некуда."
    api.get(f"/nodes/{u(10)}/docs/transfer-preview", refusal(422, text))

    with pytest.raises(ArchMapError) as exc:
        await tools.call("archmap_transfer_docs_preview", {"project": "Ярмарка", "node_id": u(10)}, client)

    assert str(exc.value) == text


# ── Перенести документацию: применение ──────────────────────────────────────

async def test_применение_переноса_шлёт_назначения_и_отчитывается(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.post(f"/nodes/{SHOP}/docs/distribute", dump(
        "DistributeDocsOut", moved_docs=2, spec_moved=True, moved_params=3,
    ))

    out = await tools.call("archmap_transfer_docs_apply", {
        "project": "Ярмарка", "node_id": SHOP,
        "docs": {u(1): u(13), u(2): u(10)}, "spec_to": u(12), "params_to": u(12),
    }, client)

    body = sent_json(api)
    backend("schemas.node").DistributeDocsIn.model_validate(body)
    assert body == {
        "doc_assignments": [{"doc_id": u(1), "child_id": u(13)}, {"doc_id": u(2), "child_id": u(10)}],
        "spec_child_id": u(12),
        "params_target_id": u(12),
    }
    assert "Переехало: схем логики 2, спецификация — да, параметров конфигурации 3." in out


async def test_применение_переноса_только_схем(client: ArchMapClient, api: FakeApi) -> None:
    api.post(f"/nodes/{SHOP}/docs/distribute", dump(
        "DistributeDocsOut", moved_docs=1, spec_moved=False, moved_params=0,
    ))

    out = await tools.call("archmap_transfer_docs_apply", {
        "project": "Ярмарка", "node_id": SHOP, "docs": {u(1): u(13)},
    }, client)

    assert sent_json(api) == {"doc_assignments": [{"doc_id": u(1), "child_id": u(13)}]}
    assert "Переехало: схем логики 1, спецификация — нет, параметров конфигурации 0." in out


async def test_применение_переноса_без_назначений_не_уходит_на_сервер(
    client: ArchMapClient, api: FakeApi
) -> None:
    calls = len(api.calls)
    with pytest.raises(ArchMapError) as exc:
        await tools.call("archmap_transfer_docs_apply", {"project": "Ярмарка", "node_id": SHOP}, client)

    assert "docs" in str(exc.value) and "archmap_transfer_docs_preview" in str(exc.value)
    assert all("/docs/distribute" not in c.url.path for c in api.calls[calls:])


@pytest.mark.parametrize(
    ("status", "detail"),
    [
        (409, "У «orders / api» уже есть схема «Старт заказа»"),
        (422, "Схемы логики переносятся компонентам и объектам без вложенных, а «inner» — система."),
    ],
)
async def test_отказ_переноса_текстом_сервера_без_чужих_советов(
    client: ArchMapClient, api: FakeApi, status: int, detail: str
) -> None:
    # 409 здесь — не гонка правок (занято имя), совет «перечитайте и повторите» был бы ложью.
    api.post(f"/nodes/{SHOP}/docs/distribute", refusal(status, detail))

    with pytest.raises(ArchMapError) as exc:
        await tools.call("archmap_transfer_docs_apply", {
            "project": "Ярмарка", "node_id": SHOP, "docs": {u(1): u(11)},
        }, client)

    assert str(exc.value) == detail


# ── Собрать с компонентов ───────────────────────────────────────────────────

def collect_preview(**over: Any) -> dict[str, Any]:
    fields: dict[str, Any] = {
        "components": [
            {"node_id": u(21), "name": "api", "params": 2, "has_spec": True},
            {"node_id": u(22), "name": "checkout", "params": 1, "has_spec": True},
            {"node_id": u(23), "name": "scheduler", "params": 1, "has_spec": False},
        ],
        "param_clashes": [{
            "name": "FEATURE_NEW_CHECKOUT",
            "candidates": [
                {"node_id": u(21), "node_name": "api", "description": "включает новый расчёт корзины"},
                {"node_id": u(22), "node_name": "checkout", "description": None},
            ],
            "container_keeps": False,
        }],
        "specs": [
            {"node_id": ORDERS, "name": "orders"},
            {"node_id": u(21), "name": "api"},
            {"node_id": u(22), "name": "checkout"},
        ],
        "container_has_spec": True,
        "single_spec_from": None,
    }
    fields.update(over)
    return dump("CollectFactsPreview", **fields)


async def test_превью_сбора_называет_компоненты_споры_и_спецификации(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.get(f"/nodes/{ORDERS}/facts/collect-preview", collect_preview())

    out = await tools.call("archmap_collect_facts_preview", {"project": "Ярмарка", "node_id": ORDERS}, client)

    lines = out.splitlines()
    assert api.calls[-1].method == "GET"
    assert "Компоненты с конфигурацией или спецификацией (3):" in lines
    assert f"  • api · 2 параметра, спецификация  node_id={u(21)}" in lines
    assert f"  • scheduler · 1 параметр  node_id={u(23)}" in lines
    assert "  «FEATURE_NEW_CHECKOUT»:" in lines
    assert f"      api: «включает новый расчёт корзины»  node_id={u(21)}" in lines
    assert f"      checkout: без описания  node_id={u(22)}" in lines
    assert f"  • orders — своя у контейнера, выбранная в spec_from её заменит  node_id={ORDERS}" in lines
    assert f"  • checkout  node_id={u(22)}" in lines
    assert "param_choices" in out and "spec_from" in out and "Ничего не записано" in out


async def test_превью_сбора_пусто(client: ArchMapClient, api: FakeApi) -> None:
    api.get(f"/nodes/{ORDERS}/facts/collect-preview", collect_preview(components=[], param_clashes=[], specs=[]))

    out = await tools.call("archmap_collect_facts_preview", {"project": "Ярмарка", "node_id": ORDERS}, client)

    assert out.endswith("Собирать нечего: у компонентов нет ни параметров конфигурации, ни спецификации.")


async def test_превью_сбора_у_не_контейнера_отказ_словами_сервера(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.get(f"/nodes/{SHOP}/facts/collect-preview", refusal(422, "Собирать можно только контейнеру с компонентами"))

    with pytest.raises(ArchMapError) as exc:
        await tools.call("archmap_collect_facts_preview", {"project": "Ярмарка", "node_id": SHOP}, client)

    assert str(exc.value) == "Собирать можно только контейнеру с компонентами"


async def test_применение_сбора_шлёт_выбор_и_отчитывается(client: ArchMapClient, api: FakeApi) -> None:
    api.post(f"/nodes/{ORDERS}/facts/collect", dump(
        "CollectFactsOut", moved_params=3, spec_moved=True, dropped_params=0, dropped_specs=0,
        left_params=[], left_specs=0,
    ))

    out = await tools.call("archmap_collect_facts_apply", {
        "project": "Ярмарка", "node_id": ORDERS,
        "param_choices": {"FEATURE_NEW_CHECKOUT": u(22)}, "spec_from": u(22),
    }, client)

    body = sent_json(api)
    backend("schemas.node").CollectFactsIn.model_validate(body)
    assert body == {
        "param_choices": [{"name": "FEATURE_NEW_CHECKOUT", "node_id": u(22)}],
        "spec_from": u(22),
    }
    assert "Переехало параметров: 3, спецификация — да." in out


async def test_применение_сбора_без_выбора_и_отказ_словами(client: ArchMapClient, api: FakeApi) -> None:
    api.post(f"/nodes/{ORDERS}/facts/collect", dump(
        "CollectFactsOut", moved_params=1, spec_moved=False, dropped_params=0, dropped_specs=0,
        left_params=[], left_specs=0,
    ))

    out = await tools.call("archmap_collect_facts_apply", {"project": "Ярмарка", "node_id": ORDERS}, client)

    assert sent_json(api) == {"param_choices": []}
    assert "Переехало параметров: 1, спецификация — нет." in out

    text = "Параметр «FEATURE_NEW_CHECKOUT» есть у нескольких объектов. Выберите, какое описание оставить."
    api.post(f"/nodes/{ORDERS}/facts/collect", refusal(422, text))
    with pytest.raises(ArchMapError) as exc:
        await tools.call("archmap_collect_facts_apply", {"project": "Ярмарка", "node_id": ORDERS}, client)
    assert str(exc.value) == text


async def test_кривой_выбор_отказ_до_сервера(client: ArchMapClient, api: FakeApi) -> None:
    with pytest.raises(ArchMapError, match="param_choices — объект"):
        await tools.call("archmap_collect_facts_apply", {
            "project": "Ярмарка", "node_id": ORDERS, "param_choices": ["FEATURE_NEW_CHECKOUT"],
        }, client)
    with pytest.raises(ArchMapError, match="docs — объект"):
        await tools.call("archmap_transfer_docs_apply", {
            "project": "Ярмарка", "node_id": SHOP, "docs": [u(1)],
        }, client)
    assert not any(c.url.path.endswith(("/facts/collect", "/docs/distribute")) for c in api.calls)


# ── Каталог ─────────────────────────────────────────────────────────────────

def test_четыре_инструмента_пишущие_и_доступны_удалённо() -> None:
    names = [
        "archmap_transfer_docs_preview", "archmap_transfer_docs_apply",
        "archmap_collect_facts_preview", "archmap_collect_facts_apply",
    ]
    remote = {t["name"] for t in tools.remote_catalog(read_only=False)}
    reader = {t["name"] for t in tools.remote_catalog(read_only=True)}
    for name in names:
        assert tools.BY_NAME[name]["writes"] is True
        assert name in remote and name not in reader
