"""Инструменты: разрешение проекта, свёртка ответов, границы записи."""

from __future__ import annotations

import json
from typing import get_args

import pytest
from conftest import PROJECT_ID, FakeApi, backend, node

from archmap_mcp import tools
from archmap_mcp.client import ArchMapClient, ArchMapError

OTHER_ID = "22222222-2222-2222-2222-222222222222"


def check_contract(schema: str, body: dict[str, object]) -> None:
    """Тело запроса глазами БЭКЕНДА: то же, что сделает живой сервер с payload."""
    getattr(backend("schemas.project"), schema).model_validate(body)


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
    api.get("/nodes/n2/docs", [{"id": "d1", "name": "POST /orders", "kind": "operation",
                                "operation": None, "content": ""}])
    api.get("/nodes/n2/docs/usage", [])
    api.get("/nodes/n2/config", [])  # семья сервиса — карточка спрашивает её всегда

    out = await tools.call("archmap_node", {"project": "Ярмарка", "node_id": "n2"}, client)

    assert "Путь: Маркетплейс / Сервис заказов" in out
    assert "← Покупатель [заказ]" in out
    assert "• POST /orders (операция)" in out
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


# ── Правила формата (промпты BYOA) ───────────────────────────────────────────

PROMPT_PATH = "/projects/import/prompt"


async def test_промпт_импорта_без_вариантов_шлёт_прежний_запрос(
    client: ArchMapClient, api: FakeApi
) -> None:
    # Сентинел совместимости: строительный промпт — дефолт и ручки, и инструмента,
    # поэтому обычный вызов обязан остаться прежним ЗАПРОСОМ, а не только прежним
    # результатом. Ложный multi_product — тоже серверный дефолт, в query не едет.
    api.get(PROMPT_PATH, {"prompt": "правила формата"})

    await tools.call("archmap_import_prompt", {"system_name": "Zabbix"}, client)
    assert api.calls[-1].url.query == b"system_name=Zabbix"

    await tools.call(
        "archmap_import_prompt",
        {"system_name": "Zabbix", "variant": "builder", "multi_product": False},
        client,
    )
    assert api.calls[-1].url.query == b"system_name=Zabbix&variant=builder"


async def test_промпт_импорта_проносит_вариант_и_федерацию(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.get(PROMPT_PATH, {"prompt": "обёртка с аудитом"})

    out = await tools.call(
        "archmap_import_prompt",
        {"system_name": "Zabbix", "depth": 3, "variant": "orchestrated", "multi_product": True},
        client,
    )

    params = api.calls[-1].url.params
    assert params["variant"] == "orchestrated"
    assert params["multi_product"] == "true"  # bool в query — строкой, как ждёт FastAPI
    assert out == "обёртка с аудитом"


async def test_промпт_доков_проносит_вариант(client: ArchMapClient, api: FakeApi) -> None:
    api.get("/docs-import/prompt", {"prompt": "аудит доков"})

    await tools.call("archmap_docs_prompt", {"project": "Ярмарка"}, client)
    assert api.calls[-1].url.query == b"include=both"  # прежний вызов не изменился

    await tools.call(
        "archmap_docs_prompt", {"project": "Ярмарка", "variant": "skeptic"}, client
    )
    assert api.calls[-1].url.params["variant"] == "skeptic"


async def test_варианты_промпта_те_же_что_у_бэкенда() -> None:
    # Каталог обещает агенту тройку вариантов — она должна быть ровно та, что
    # принимает ручка: лишнее значение в enum = 422 на живом сервере.
    assert tuple(tools.VARIANT_ARG["enum"]) == get_args(backend("skeptic_prompt").PromptVariant)


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


async def test_превью_импорта_шлёт_contents_текстами(
    client: ArchMapClient, api: FakeApi
) -> None:
    # ФОРМА тела, а не только вывод: инструмент слал записи {name, content}, а
    # ImportPreviewIn.contents — список текстов, и живой сервер отвечал 422. Мок
    # тело не валидирует, поэтому судьёй берём схему бэкенда.
    api.post("/projects/import/preview", {
        "ok": True, "errors": [], "node_count": 2, "edge_count": 1, "roots": ["Zabbix"], "files": 2,
    })

    await tools.call(
        "archmap_import_preview",
        {"files": [{"name": "a.yaml", "content": "первый"},
                   {"name": "b.yaml", "content": "второй"}]},
        client,
    )

    body = json.loads(api.calls[-1].content)
    # Порядок сохранён: нумерация замечаний («файл 2») идёт по позиции в списке.
    assert body["contents"] == ["первый", "второй"]
    check_contract("ImportPreviewIn", body)


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
    # Было `body["contents"][0]["name"] == "r.yaml"` — тест закреплял СЛОМАННУЮ
    # форму: SyncPreviewIn.contents принимает тексты, имён файлов у него нет.
    assert body["contents"] == ["x"]
    check_contract("SyncPreviewIn", body)


async def test_создание_проекта_шлёт_yaml_текстами(
    client: ArchMapClient, api: FakeApi
) -> None:
    # Третий носитель той же ошибки формы: ProjectCreate.import_yamls — список
    # текстов. Без этого теста чинилось бы только превью, а запись всё равно
    # ловила бы 422 на живом сервере.
    api.post("/projects/", {"id": PROJECT_ID, "name": "Zabbix", "object_count": 12})

    out = await tools.call(
        "archmap_import_apply",
        {"name": "Zabbix",
         "files": [{"name": "a.yaml", "content": "первый"},
                   {"name": "b.yaml", "content": "второй"}]},
        client,
    )

    body = json.loads(api.calls[-1].content)
    assert body["import_yamls"] == ["первый", "второй"]
    assert body["start"] == "import"
    check_contract("ProjectCreate", body)
    assert "создан" in out


async def test_применение_синка_шлёт_contents_текстами(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.post(f"/projects/{PROJECT_ID}/sync/apply", {
        "nodes_created": 1, "nodes_updated": 0, "nodes_unchanged": 4, "nodes_missing": 0,
        "nodes_returned": 0, "edges_created": 0, "nodes": [], "edges": [],
    })

    await tools.call(
        "archmap_sync_apply",
        {"project": "Ярмарка", "files": [{"name": "r.yaml", "content": "прогон"}],
         "base_graph_rev": 7},
        client,
    )

    body = json.loads(api.calls[-1].content)
    assert body["contents"] == ["прогон"]
    assert body["base_graph_rev"] == 7  # курсор схемы не потерялся вместе с формой
    check_contract("SyncApplyIn", body)


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
