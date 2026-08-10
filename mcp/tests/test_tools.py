"""Инструменты: разрешение проекта, свёртка ответов, границы записи."""

from __future__ import annotations

import json

import pytest
from conftest import PROJECT_ID, FakeApi, node

from archmap_mcp import tools
from archmap_mcp.client import ArchMapClient, ArchMapError

OTHER_ID = "22222222-2222-2222-2222-222222222222"


# ── Разрешение проекта ───────────────────────────────────────────────────────

async def test_проект_ищется_по_части_имени(client: ArchMapClient) -> None:
    assert await tools.resolve_project(client, "ярмар") == (PROJECT_ID, "Ярмарка")


async def test_проект_по_uuid(client: ArchMapClient) -> None:
    assert await tools.resolve_project(client, PROJECT_ID) == (PROJECT_ID, "Ярмарка")


async def test_неоднозначное_имя_не_выбирается_молча(
    client: ArchMapClient, api: FakeApi
) -> None:
    # Молчаливый выбор «первого похожего» — самый дорогой вид ошибки: агент
    # напишет правки не в тот проект и узнает об этом от человека.
    api.get(
        "/projects/",
        [
            {"id": PROJECT_ID, "name": "Ярмарка", "object_count": 1},
            {"id": OTHER_ID, "name": "Ярмарка — мультисхемы", "object_count": 1},
        ],
    )
    # «ярмарк» — подстрока обоих имён и точным совпадением не является ни для кого.
    with pytest.raises(ArchMapError) as exc:
        await tools.resolve_project(client, "ярмарк")

    assert "Уточните" in str(exc.value)
    assert "«Ярмарка»" in str(exc.value) and "«Ярмарка — мультисхемы»" in str(exc.value)


async def test_точное_имя_бьёт_подстроку(client: ArchMapClient, api: FakeApi) -> None:
    api.get(
        "/projects/",
        [
            {"id": PROJECT_ID, "name": "Ярмарка", "object_count": 1},
            {"id": OTHER_ID, "name": "Ярмарка — мультисхемы", "object_count": 1},
        ],
    )
    assert (await tools.resolve_project(client, "Ярмарка"))[0] == PROJECT_ID


async def test_неизвестный_проект_показывает_список(
    client: ArchMapClient, api: FakeApi
) -> None:
    with pytest.raises(ArchMapError) as exc:
        await tools.resolve_project(client, "Нет такого")

    assert "«Ярмарка»" in str(exc.value)


# ── Чтение ───────────────────────────────────────────────────────────────────

async def test_схема_отдаёт_дерево_и_связи(client: ArchMapClient, api: FakeApi) -> None:
    api.get("/nodes/all", [
        node("n1", "Маркетплейс"),
        node("n2", "Сервис заказов", "n1", technology="Python"),
        node("n3", "Покупатель", shape="person"),
    ])
    api.get("/edges/", [
        {"id": "e1", "source_id": "n3", "target_id": "n2", "label": "заказ", "technology": "REST"},
    ])

    out = await tools.call("archmap_schema", {"project": "Ярмарка"}, client)

    assert "• Маркетплейс" in out
    assert "  • Сервис заказов [сервис, Python]" in out  # вложенность отступом
    assert "Покупатель → Сервис заказов [заказ, REST]" in out


async def test_схема_поддерева_режет_и_узлы_и_связи(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.get("/nodes/all", [
        node("n1", "Маркетплейс"),
        node("n2", "Сервис заказов", "n1"),
        node("n3", "Order API", "n2"),
        node("n4", "Посторонний"),
    ])
    api.get("/edges/", [
        {"id": "e1", "source_id": "n3", "target_id": "n4"},
        {"id": "e2", "source_id": "n4", "target_id": "n4"},
    ])

    out = await tools.call("archmap_schema", {"project": "Ярмарка", "node_id": "n2"}, client)

    assert "Сервис заказов" in out and "Order API" in out
    assert "Маркетплейс" not in out.split("СВЯЗИ:")[0]
    assert "e1" in out and "e2" not in out  # связь без конца в поддереве отброшена


async def test_карточка_объекта_собирает_связи_и_доки(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.get("/nodes/n2", node("n2", "Сервис заказов", "n1", openapi_spec="openapi: 3.0.0"))
    api.get("/nodes/all", [node("n1", "Маркетплейс"), node("n2", "Сервис заказов", "n1")])
    api.get("/nodes/n2/edges", [
        {"id": "e1", "direction": "incoming", "other_node_id": "n3",
         "other_node_name": "Покупатель", "label": "заказ", "technology": None},
    ])
    api.get("/nodes/n2/docs", [{"id": "d1", "name": "Обзор", "kind": "обзор", "operation": None}])

    out = await tools.call("archmap_node", {"project": "Ярмарка", "node_id": "n2"}, client)

    assert "Путь: Маркетплейс / Сервис заказов" in out
    assert "← Покупатель [заказ]" in out
    assert "• Обзор (обзор)" in out
    assert "OpenAPI-спека: есть" in out
    assert "openapi: 3.0.0" not in out  # текст спеки — только по явному запросу


async def test_алерты_читаются_именами(client: ArchMapClient, api: FakeApi) -> None:
    api.get("/nodes/alerts", {
        "disconnected_nodes": [{"node_id": "n9", "node_name": "Сирота"}],
        "intermediate_edges": [],
        "isolated_groups": [],
        "container_own_docs": [],
        "persons_inside": [{"node_id": "n3", "node_name": "Покупатель",
                            "parent_id": "n1", "parent_name": "Маркетплейс"}],
        "dangling_messages": [],
    })

    out = await tools.call("archmap_alerts", {"project": "Ярмарка"}, client)

    assert "Объекты без связей (1)" in out
    assert "Покупатель внутри Маркетплейс" in out


async def test_пустые_алерты_говорят_что_всё_хорошо(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.get("/nodes/alerts", {
        "disconnected_nodes": [], "intermediate_edges": [], "isolated_groups": [],
        "container_own_docs": [], "persons_inside": [], "dangling_messages": [],
    })

    assert "завершена" in await tools.call("archmap_alerts", {"project": "Ярмарка"}, client)


async def test_шаги_процесса_помечают_повисшие(client: ArchMapClient, api: FakeApi) -> None:
    api.get("/processes/p1", {
        "id": "p1", "name": "Оформление заказа",
        "participants": [
            {"id": "pp1", "node_id": "n3", "name": "Покупатель", "order": 0},
            {"id": "pp2", "node_id": "n2", "name": "Сервис заказов", "order": 1},
        ],
        "messages": [
            {"id": "m1", "order": 0, "from_id": "n3", "to_id": "n2",
             "caption": "создать заказ", "valid": True},
            {"id": "m2", "order": 1, "from_id": "n2", "to_id": "n3",
             "caption": "ответ", "valid": False},
        ],
        "fragments": [],
    })

    out = await tools.call(
        "archmap_processes", {"project": "Ярмарка", "process_id": "p1"}, client
    )

    assert "0. Покупатель → Сервис заказов: создать заказ" in out
    assert "⚠ связь удалена из схемы" in out


# ── Запись ───────────────────────────────────────────────────────────────────

async def test_превью_импорта_не_создаёт_проект(client: ArchMapClient, api: FakeApi) -> None:
    api.post("/projects/import/preview", {
        "ok": True, "errors": [], "node_count": 12, "edge_count": 9, "roots": ["Маркетплейс"],
        "files": 2, "warnings": ["актор внутри системы: Покупатель"],
    })

    out = await tools.call(
        "archmap_import_preview",
        {"files": [{"name": "a.yaml", "content": "x"}, {"name": "b.yaml", "content": "y"}]},
        client,
    )

    assert "объектов 12" in out
    assert "актор внутри системы" in out
    assert "НЕ создан" in out
    assert all(c.url.path != "/api/v1/projects/" or c.method != "POST" for c in api.calls)


async def test_битый_yaml_возвращает_ошибки_а_не_молчит(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.post("/projects/import/preview", {
        "ok": False, "errors": ["a.yaml: не найден корневой узел"],
        "node_count": 0, "edge_count": 0, "roots": [], "files": 1,
    })

    out = await tools.call(
        "archmap_import_preview", {"files": [{"name": "a.yaml", "content": "!"}]}, client
    )

    assert "НЕ пройдёт" in out and "не найден корневой узел" in out


async def test_план_синка_считает_и_не_пишет(client: ArchMapClient, api: FakeApi) -> None:
    api.post(f"/projects/{PROJECT_ID}/sync/preview", {
        "nodes_created": 2, "nodes_updated": 1, "nodes_unchanged": 5,
        "nodes_missing": 1, "nodes_returned": 0, "edges_created": 3,
        "nodes": [
            {"path": "Маркетплейс / Новый", "action": "create", "fields": [], "returned": False},
            {"path": "Маркетплейс / Старый", "action": "missing", "fields": [], "returned": False},
        ],
        "edges": [],
    })

    out = await tools.call(
        "archmap_sync_preview",
        {"project": "Ярмарка", "files": [{"name": "r.yaml", "content": "x"}],
         "mark_missing_deprecated": True},
        client,
    )

    assert "создать объектов: 2" in out
    assert "create: Маркетплейс / Новый" in out
    assert "Ничего не записано" in out
    body = json.loads(api.calls[-1].content)
    assert body["mark_missing_deprecated"] is True
    assert body["contents"][0]["name"] == "r.yaml"


async def test_правка_узла_без_полей_отклоняется(client: ArchMapClient) -> None:
    # Пустой PATCH молча «успешен» — агент решил бы, что правка применилась.
    with pytest.raises(ArchMapError) as exc:
        await tools.call("archmap_update_node", {"project": "Ярмарка", "node_id": "n2"}, client)

    assert "Нечего менять" in str(exc.value)


async def test_создание_связи_шлёт_тип_канала(client: ArchMapClient, api: FakeApi) -> None:
    api.post("/edges/", {"id": "e9"})

    await tools.call(
        "archmap_create_edge",
        {"project": "Ярмарка", "source_id": "n1", "target_id": "n2",
         "label": "событие оплаты", "is_synchronous": False},
        client,
    )

    body = json.loads(api.calls[-1].content)
    assert body["is_synchronous"] is False
    assert body["label"] == "событие оплаты"


async def test_удалений_в_каталоге_нет() -> None:
    # Решение пользователя 2026-08-10: снос узла уводит поддерево, связи, доки и
    # спеки — такое делают глазами. Тест держит границу каталога.
    assert not [t for t in tools.TOOLS if "delete" in t["name"] or "remove" in t["name"]]


async def test_каждый_инструмент_описан_и_вызываем() -> None:
    for t in tools.TOOLS:
        assert t["name"].startswith("archmap_")
        assert len(t["description"]) > 40, t["name"]
        assert t["schema"]["type"] == "object"
        assert callable(t["handler"])
