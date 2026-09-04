"""Инструменты: разрешение проекта, свёртка ответов, границы записи."""

from __future__ import annotations

import json
from typing import get_args

import httpx
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
        "/projects",
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
        "/projects",
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
    api.get("/nodes/n2/processes", [])

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


# ── Якорь в правках объекта ──────────────────────────────────────────────────

def check_node_contract(schema: str, body: dict[str, object]) -> None:
    """Тело правки объекта глазами бэкенда (NodeCreate / NodeUpdate)."""
    getattr(backend("schemas.node"), schema).model_validate(body)


async def test_создание_объекта_шлёт_якорь(client: ArchMapClient, api: FakeApi) -> None:
    # Объект рождается опознаваемым из кода: без source в POST агенту пришлось бы
    # делать второй вызов, а до него объект жил бы «безымянным» для синка.
    api.post("/nodes/", node("n7", "Оркестратор", source={"repo": "github.com/org/repo",
                                                         "path": "src/api", "host": None}))

    out = await tools.call(
        "archmap_create_node",
        {"project": "Ярмарка", "name": "Оркестратор",
         "source": {"repo": "https://github.com/Org/Repo.git", "path": "./src/api/"}},
        client,
    )

    body = json.loads(api.calls[-1].content)
    assert body["source"] == {"repo": "https://github.com/Org/Repo.git", "path": "./src/api/"}
    check_node_contract("NodeCreate", body)
    # Карточкой ответа агент видит, во что сервер привёл вставленный адрес клона.
    assert "Якорь: код github.com/org/repo, путь src/api" in out


async def test_создание_без_якоря_поля_source_не_шлёт(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.post("/nodes/", node("n8", "Ручной"))

    out = await tools.call(
        "archmap_create_node", {"project": "Ярмарка", "name": "Ручной"}, client
    )

    assert "source" not in json.loads(api.calls[-1].content)
    assert "Якорь: нет — опознаётся по имени" in out


async def test_правка_объекта_шлёт_якорь(client: ArchMapClient, api: FakeApi) -> None:
    api.patch("/nodes/n2", node("n2", "Kafka", shape="broker",
                                source={"repo": None, "path": None, "host": "kafka"}))

    out = await tools.call(
        "archmap_update_node",
        {"project": "Ярмарка", "node_id": "n2", "source": {"host": "kafka:9092"}},
        client,
    )

    body = json.loads(api.calls[-1].content)
    assert body == {"source": {"host": "kafka:9092"}}
    check_node_contract("NodeUpdate", body)
    assert "Якорь: имя зависимости kafka" in out


async def test_пустой_объект_source_доезжает_как_очистка(
    client: ArchMapClient, api: FakeApi
) -> None:
    """⚠️ Фильтр «не None» отбросил бы {} вместе с незаполненными полями, и
    просьба снять якорь провалилась бы МОЛЧА — с бодрым «обновлён» в ответе."""
    api.patch("/nodes/n2", node("n2", "Ручной", source=None))

    out = await tools.call(
        "archmap_update_node", {"project": "Ярмарка", "node_id": "n2", "source": {}}, client
    )

    assert json.loads(api.calls[-1].content) == {"source": {}}
    assert "Якорь: нет — опознаётся по имени" in out


async def test_якорь_без_прочих_полей_это_уже_правка(
    client: ArchMapClient, api: FakeApi
) -> None:
    # «Нечего менять» должно оставаться правдой: source — полноценная правка.
    api.patch("/nodes/n2", node("n2", "Узел", source={"repo": "github.com/org/x",
                                                     "path": None, "host": None}))

    await tools.call(
        "archmap_update_node",
        {"project": "Ярмарка", "node_id": "n2", "source": {"repo": "github.com/org/x"}},
        client,
    )

    assert json.loads(api.calls[-1].content)["source"]["repo"] == "github.com/org/x"


async def test_отказ_бэкенда_доезжает_текстом(client: ArchMapClient, api: FakeApi) -> None:
    """422 про адрес среды — это ОБЪЯСНЕНИЕ, чем плох якорь, а не код ошибки:
    агент должен прочитать его и исправиться, а не гадать."""
    detail = (
        "localhost, 127.0.0.1 и адреса конкретных серверов принадлежат среде, "
        "а не продукту — укажите имя, под которым продукт называет зависимость, "
        "как в docker-compose или в имени k8s Service"
    )
    api.patch("/nodes/n2", httpx.Response(422, json={"detail": detail}))

    with pytest.raises(ArchMapError) as exc:
        await tools.call(
            "archmap_update_node",
            {"project": "Ярмарка", "node_id": "n2", "source": {"host": "localhost"}},
            client,
        )

    assert "принадлежат среде" in str(exc.value)


async def test_каталог_объявляет_якорь_обоим_инструментам() -> None:
    by_name = {t["name"]: t for t in tools.TOOLS}
    for name in ("archmap_create_node", "archmap_update_node"):
        props = by_name[name]["schema"]["properties"]
        assert set(props["source"]["properties"]) == {"repo", "path", "host"}
        assert "снять якорь" in props["source"]["description"]
    assert "якорь" in by_name["archmap_node"]["description"].lower()
