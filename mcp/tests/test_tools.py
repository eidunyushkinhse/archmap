"""Инструменты: разрешение проекта, свёртка ответов, границы записи."""

from __future__ import annotations

import json
from typing import Any, get_args

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

async def test_список_проектов_называет_роль_учётки(client: ArchMapClient, api: FakeApi) -> None:
    # Сервер отдаёт только доступные учётке проекты; агенту важно знать, где он
    # может править, а где только смотреть (docs/tasks/project-access.md).
    api.get(
        "/projects",
        [
            {"id": PROJECT_ID, "name": "Ярмарка", "object_count": 3, "my_role": "owner"},
            {"id": OTHER_ID, "name": "Плёнка", "object_count": 2, "my_role": "reader",
             "description": "демо"},
            {"id": "33333333-3333-3333-3333-333333333333", "name": "Zabbix",
             "object_count": 9, "my_role": "editor"},
        ],
    )
    out = await tools.t_projects(client, {})
    assert out.splitlines() == [
        f"• Ярмарка [владелец]: 3 объектов  id={PROJECT_ID}",
        f"• Плёнка [чтение]: 2 объектов — демо  id={OTHER_ID}",
        "• Zabbix [редактор]: 9 объектов  id=33333333-3333-3333-3333-333333333333",
    ]


async def test_схема_отдаёт_дерево_и_связи(client: ArchMapClient, api: FakeApi) -> None:
    api.get("/nodes/all", [
        node("n1", "Маркетплейс"),
        node("n2", "Сервис заказов", "n1", technology="Python"),
        node("n3", "Покупатель", shape="person"),
    ])
    api.get("/edges", [
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
    api.get("/edges", [
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
    # результатом.
    api.get(PROMPT_PATH, {"prompt": "правила формата"})

    await tools.call("archmap_import_prompt", {"system_name": "Zabbix"}, client)
    assert api.calls[-1].url.query == b"system_name=Zabbix"

    await tools.call(
        "archmap_import_prompt",
        {"system_name": "Zabbix", "variant": "builder"},
        client,
    )
    assert api.calls[-1].url.query == b"system_name=Zabbix&variant=builder"


async def test_промпт_импорта_проносит_вариант(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.get(PROMPT_PATH, {"prompt": "обёртка с аудитом"})

    out = await tools.call(
        "archmap_import_prompt",
        {"system_name": "Zabbix", "depth": 3, "variant": "orchestrated"},
        client,
    )

    params = api.calls[-1].url.params
    assert params["variant"] == "orchestrated"
    assert params["depth"] == "3"
    assert out == "обёртка с аудитом"


async def test_промпт_доков_проносит_вариант(client: ArchMapClient, api: FakeApi) -> None:
    api.get("/docs-import/prompt", {"prompt": "аудит доков"})

    await tools.call("archmap_docs_prompt", {"project": "Ярмарка"}, client)
    assert api.calls[-1].url.query == b"include=both"  # прежний вызов не изменился

    await tools.call(
        "archmap_docs_prompt", {"project": "Ярмарка", "variant": "skeptic"}, client
    )
    assert api.calls[-1].url.params["variant"] == "skeptic"


async def test_промпт_доков_проносит_одну_точку_входа(client: ArchMapClient, api: FakeApi) -> None:
    # Сценарий «задокументировать монолит»: после разведки каждую заглушку описывают
    # отдельным прогоном — target с её именем (аудит P-12: README его обещал, а
    # инструмент не передавал).
    api.get("/docs-import/prompt", {"prompt": "одна схема"})

    await tools.call(
        "archmap_docs_prompt",
        {"project": "Ярмарка", "node_id": "n1", "target": "Пересчёт остатков"},
        client,
    )
    params = api.calls[-1].url.params
    assert params["target"] == "Пересчёт остатков"
    assert params["node_id"] == "n1"


def test_у_каждого_аргумента_есть_описание() -> None:
    # Агент выбирает аргументы по описанию: голый {"type": "boolean"} у флага синка
    # не говорит, что он включает (аудит P-28 — было 75 таких аргументов).
    missing: list[str] = []

    def walk(where: str, schema: dict[str, Any]) -> None:
        for key, arg in (schema.get("properties") or {}).items():
            if not arg.get("description"):
                missing.append(f"{where}.{key}")
            if arg.get("type") == "object":
                walk(f"{where}.{key}", arg)
            items = arg.get("items")
            if isinstance(items, dict) and items.get("type") == "object":
                walk(f"{where}.{key}[]", items)

    for tool in tools.TOOLS:
        walk(tool["name"], tool["schema"])
    assert missing == []


async def test_варианты_промпта_те_же_что_у_бэкенда() -> None:
    # Каталог обещает агенту тройку вариантов — она должна быть ровно та, что
    # принимает ручка: лишнее значение в enum = 422 на живом сервере.
    assert tuple(tools.VARIANT_ARG["enum"]) == get_args(backend("skeptic_prompt").PromptVariant)


# ── Запись ───────────────────────────────────────────────────────────────────

def sync_plan(**over: object) -> dict[str, object]:
    """План синка как его отдаёт БЭКЕНД. ⚠️ Счётчики живут в summary и зовутся по
    ИМЕНИ ДЕЙСТВИЯ («nodes_create»), а не «nodes_created» в корне ответа: на
    выдуманной форме отчёт печатал нули на любом плане (полевая находка Ф4)."""
    fields: dict[str, object] = {
        "ok": True, "files": 1,
        "nodes": [
            {"path": "Маркетплейс / Новый", "action": "create"},
            {"path": "Маркетплейс / Старый", "action": "missing"},
        ],
        "edges": [],
        "summary": {"nodes_create": 2, "nodes_update": 1, "nodes_unchanged": 5,
                    "nodes_missing": 1, "edges_create": 3},
        "graph_rev": 11,
    }
    fields.update(over)
    return backend("schemas.project").SyncPreviewOut(**fields).model_dump(mode="json")


async def test_план_синка_считает_и_не_пишет(client: ArchMapClient, api: FakeApi) -> None:
    api.post(f"/projects/{PROJECT_ID}/sync/preview", sync_plan())

    out = await tools.call(
        "archmap_sync_preview",
        {"project": "Ярмарка", "files": [{"name": "r.yaml", "content": "x"}],
         "mark_missing_deprecated": True},
        client,
    )

    assert "создать объектов: 2" in out
    assert "обновить: 1" in out and "без изменений: 5" in out
    assert "create: Маркетплейс / Новый" in out
    assert "Ничего не записано" in out
    # Курсор схемы для применения обязан быть НАЗВАН: без него apply — слепая
    # запись поверх чужой параллельной правки.
    assert "base_graph_rev=11" in out
    body = json.loads(api.calls[-1].content)
    assert body["mark_missing_deprecated"] is True
    # Было `body["contents"][0]["name"] == "r.yaml"` — тест закреплял СЛОМАННУЮ
    # форму: SyncPreviewIn.contents принимает тексты, имён файлов у него нет.
    assert body["contents"] == ["x"]
    check_contract("SyncPreviewIn", body)


async def test_план_синка_показывает_связи_с_каналами(client: ArchMapClient, api: FakeApi) -> None:
    """С 2026-10-28 план называет связи: новой — её канал, обновляемой — чем заполнится
    пустое. Без этого агент не видел, что канал из прогона будет (или не будет) записан."""
    api.post(f"/projects/{PROJECT_ID}/sync/preview", sync_plan(
        nodes=[],
        edges=[
            {"source_path": "С / producer", "target_path": "С / bus", "action": "create",
             "channel": "topic.c"},
            {"source_path": "С / producer", "target_path": "С / bus", "action": "update",
             "fields": ["channel"], "channel": "topic.a"},
            {"source_path": "С / bus", "target_path": "С / consumer", "action": "update",
             "fields": ["channel", "is_synchronous"], "channel": "topic.a", "is_synchronous": False},
            {"source_path": "С / a", "target_path": "С / b", "action": "unchanged"},
            {"source_path": "С / x", "target_path": "С / y", "action": "missing"},
        ],
        summary={"edges_create": 1, "edges_update": 2, "edges_unchanged": 1, "edges_missing": 1},
    ))

    out = await tools.call(
        "archmap_sync_preview",
        {"project": "Ярмарка", "files": [{"name": "r.yaml", "content": "x"}]},
        client,
    )

    assert "связей дополнить: 2" in out and "связей пропало из кода: 1" in out
    assert "create: С / producer → С / bus (канал topic.c)" in out
    assert "update: С / producer → С / bus (канал ← topic.a)" in out
    assert "update: С / bus → С / consumer (канал ← topic.a, тип ← асинхронный)" in out
    assert "missing: С / x → С / y" in out
    assert "С / a → С / b" not in out  # без изменений не перечисляется


async def test_план_синка_без_изменений_говорит_это_вслух(
    client: ArchMapClient, api: FakeApi
) -> None:
    """Фикспойнт синка: повторный прогон на том же входе пуст. Молчание тут
    неотличимо от «инструмент сломался»."""
    api.post(f"/projects/{PROJECT_ID}/sync/preview", sync_plan(
        nodes=[{"path": "Маркетплейс / Заказы", "action": "unchanged"}],
        summary={"nodes_unchanged": 1},
        is_noop=True,
    ))

    out = await tools.call(
        "archmap_sync_preview",
        {"project": "Ярмарка", "files": [{"name": "r.yaml", "content": "x"}]},
        client,
    )

    assert "без изменений: 1" in out
    assert "Схема уже соответствует прогону" in out


async def test_негодный_прогон_называет_ошибки_а_не_нули(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.post(f"/projects/{PROJECT_ID}/sync/preview", sync_plan(
        ok=False, errors=["вход 1: корень документа должен быть словарём"],
        nodes=[], summary={},
    ))

    out = await tools.call(
        "archmap_sync_preview",
        {"project": "Ярмарка", "files": [{"name": "r.yaml", "content": "мусор"}]},
        client,
    )

    assert "корень документа должен быть словарём" in out
    assert "Будет сделано" not in out


async def test_применение_синка_шлёт_contents_текстами(
    client: ArchMapClient, api: FakeApi
) -> None:
    # ⚠️ Ответ применения — СВОЯ форма (SyncApplyOut): списки путей, а не план
    # ещё раз. Отчёт, читавший поля плана, печатал пустоту после реальной записи.
    api.post(f"/projects/{PROJECT_ID}/sync/apply", backend("schemas.project").SyncApplyOut(
        created_nodes=["Маркетплейс / Новый"],
        updated_nodes=["Маркетплейс / Заказы"],
        deprecated_nodes=[],
        created_edges=["Маркетплейс / Новый → Маркетплейс / Kafka"],
        updated_edges=["Маркетплейс / Заказы → Маркетплейс / Kafka"],
        skipped=[],
        graph_rev=12,
    ).model_dump(mode="json"))

    out = await tools.call(
        "archmap_sync_apply",
        {"project": "Ярмарка", "files": [{"name": "r.yaml", "content": "прогон"}],
         "base_graph_rev": 7},
        client,
    )

    assert "Создано объектов: 1" in out and "• Маркетплейс / Новый" in out
    assert "Обновлено: 1" in out
    assert "Создано связей: 1" in out
    assert "Дополнено связей (канал, тип канала): 1" in out
    assert "graph_rev=12" in out
    body = json.loads(api.calls[-1].content)
    assert body["contents"] == ["прогон"]
    assert body["base_graph_rev"] == 7  # курсор схемы не потерялся вместе с формой
    check_contract("SyncApplyIn", body)


async def test_правка_узла_без_полей_отклоняется(client: ArchMapClient) -> None:
    # Пустой PATCH молча «успешен» — агент решил бы, что правка применилась.
    with pytest.raises(ArchMapError) as exc:
        await tools.call("archmap_update_node", {"project": "Ярмарка", "node_id": "n2"}, client)

    assert "Нечего менять" in str(exc.value)


async def test_правка_связи_шлёт_канал(client: ArchMapClient, api: FakeApi) -> None:
    """Канал брокера правится агентом (с 0.9.1): до того связи без канала, оставленные
    синком, через MCP было не вылечить."""
    api.patch("/edges/e9", {"id": "e9"})

    out = await tools.call(
        "archmap_update_edge",
        {"project": "Ярмарка", "edge_id": "e9", "channel": "orders.created"},
        client,
    )

    body = json.loads(api.calls[-1].content)
    assert body == {"channel": "orders.created"}
    # Контракт связи живёт в schemas.edge, а не schemas.project (как у check_contract).
    backend("schemas.edge").EdgeUpdate.model_validate(body)
    assert "channel" in out


async def test_создание_связи_шлёт_тип_канала(client: ArchMapClient, api: FakeApi) -> None:
    api.post("/edges", {"id": "e9"})

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


# ── Источник в правках объекта ──────────────────────────────────────────────────

def check_node_contract(schema: str, body: dict[str, object]) -> None:
    """Тело правки объекта глазами бэкенда (NodeCreate / NodeUpdate)."""
    getattr(backend("schemas.node"), schema).model_validate(body)


async def test_создание_объекта_шлёт_источник(client: ArchMapClient, api: FakeApi) -> None:
    # Объект рождается опознаваемым из кода: без source в POST агенту пришлось бы
    # делать второй вызов, а до него объект жил бы «безымянным» для синка.
    api.post("/nodes", node("n7", "Оркестратор", source={"repo": "github.com/org/repo",
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
    assert "Источник: код github.com/org/repo, путь src/api" in out


async def test_создание_без_источника_поля_source_не_шлёт(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.post("/nodes", node("n8", "Ручной"))

    out = await tools.call(
        "archmap_create_node", {"project": "Ярмарка", "name": "Ручной"}, client
    )

    assert "source" not in json.loads(api.calls[-1].content)
    assert "Источник: нет — опознаётся по имени" in out


async def test_правка_объекта_шлёт_источник(client: ArchMapClient, api: FakeApi) -> None:
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
    assert "Источник: имя зависимости kafka" in out


async def test_пустой_объект_source_доезжает_как_очистка(
    client: ArchMapClient, api: FakeApi
) -> None:
    """⚠️ Фильтр «не None» отбросил бы {} вместе с незаполненными полями, и
    просьба снять источник провалилась бы МОЛЧА — с бодрым «обновлён» в ответе."""
    api.patch("/nodes/n2", node("n2", "Ручной", source=None))

    out = await tools.call(
        "archmap_update_node", {"project": "Ярмарка", "node_id": "n2", "source": {}}, client
    )

    assert json.loads(api.calls[-1].content) == {"source": {}}
    assert "Источник: нет — опознаётся по имени" in out


async def test_источник_без_прочих_полей_это_уже_правка(
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


async def test_правка_объекта_шлёт_статус_страницы(client: ArchMapClient, api: FakeApi) -> None:
    api.patch("/nodes/n2", node("n2", "Сервис заказов",
                                approval="approved", approval_effective="approved"))

    out = await tools.call(
        "archmap_update_node", {"project": "Ярмарка", "node_id": "n2", "approval": "approved"}, client
    )

    body = json.loads(api.calls[-1].content)
    assert body == {"approval": "approved"}
    check_node_contract("NodeUpdate", body)
    assert "Статус страницы: согласовано" in out


async def test_статус_страницы_в_каталоге_тот_же_что_у_бэкенда() -> None:
    # Лишнее значение в enum = 422 на живом сервере; описание предупреждает агента,
    # что согласование ставит человек.
    arg = tools.BY_NAME["archmap_update_node"]["schema"]["properties"]["approval"]
    assert tuple(arg["enum"]) == get_args(backend("domain_types").NodeApproval)
    assert "явной просьбе человека" in arg["description"]
    assert "approval" not in tools.BY_NAME["archmap_create_node"]["schema"]["properties"]


async def test_отказ_бэкенда_доезжает_текстом(client: ArchMapClient, api: FakeApi) -> None:
    """422 про адрес среды — это ОБЪЯСНЕНИЕ, чем плох источник, а не код ошибки:
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


async def test_каталог_объявляет_источник_обоим_инструментам() -> None:
    by_name = {t["name"]: t for t in tools.TOOLS}
    for name in ("archmap_create_node", "archmap_update_node"):
        props = by_name[name]["schema"]["properties"]
        assert set(props["source"]["properties"]) == {"repo", "path", "host"}
        assert "снять источник" in props["source"]["description"]
    assert "источник" in by_name["archmap_node"]["description"].lower()


async def test_план_синка_называет_основание_и_источника(
    client: ArchMapClient, api: FakeApi
) -> None:
    """Синк — единственное место, где ошибка опознания сразу пишется в живой
    проект: «нашли по имени» и «нашли по коду» — решения разной надёжности."""
    plan = backend("schemas.project").SyncPreviewOut(
        ok=True,
        nodes_created=2, nodes_updated=2, nodes_unchanged=0,
        nodes_missing=0, nodes_returned=0, edges_created=0,
        nodes=[
            {"path": "М / Заказы", "action": "update", "fields": ["description"],
             "matched_by": "code"},
            {"path": "М / Kafka", "action": "update", "fields": [], "matched_by": "dependency"},
            {"path": "М / Оплата", "action": "create",
             "source": {"repo": "github.com/y/pay", "path": "svc"}},
            {"path": "М / Ручной", "action": "create"},
        ],
        edges=[],
    ).model_dump(mode="json")
    api.post(f"/projects/{PROJECT_ID}/sync/preview", plan)

    out = await tools.call(
        "archmap_sync_preview",
        {"project": "Ярмарка", "files": [{"name": "r.yaml", "content": "x"}]},
        client,
    )

    assert "update: М / Заказы (description) — по коду" in out
    assert "update: М / Kafka — по имени зависимости" in out
    assert "create: М / Оплата — источник: код github.com/y/pay, путь svc" in out
    assert "create: М / Ручной — источника нет — будет опознаваться по имени" in out


async def test_экспорт_отдаёт_сам_yaml_а_не_одну_шапку(
    client: ArchMapClient, api: FakeApi
) -> None:
    """Полевая находка Ф4: инструмент читал поле «yaml», которого в ExportResponse
    нет, и агент получал шапку без схемы — импорт такого «экспорта» падал на 400.
    Фикстура собрана схемой бэкенда: она и есть судья имени поля."""
    export = backend("schemas.export").ExportResponse(
        format="yaml", content="nodes:\n  - name: Маркетплейс\nedges: []\n"
    ).model_dump(mode="json")
    api.get("/export", export)

    out = await tools.call("archmap_export", {"project": "Ярмарка"}, client)

    assert "nodes:" in out and "name: Маркетплейс" in out


# ── Размещение в правке объекта (Ф4 эпика развёртывания) ─────────────────────

CLOUD = "00000001-0000-0000-0000-000000000000"
CLUSTER = "00000002-0000-0000-0000-000000000000"


def site_out(site_id: str, name: str, kind: str, parent: str | None = None) -> dict[str, object]:
    out: dict[str, object] = {"id": site_id, "name": name, "kind": kind, "technology": None,
                              "description": None, "parent_id": parent, "version": 1,
                              "instance_count": 0}
    backend("schemas.deployment").SiteOut.model_validate(out)
    return out


SITES = [site_out(CLOUD, "Облако", "cloud"), site_out(CLUSTER, "Кластер prod", "kubernetes", CLOUD)]


def site_ref(site_id: str, name: str, parent_name: str | None = None) -> dict[str, object]:
    out = {"id": site_id, "name": name, "kind": "cloud", "parent_id": CLOUD if parent_name else None,
           "parent_name": parent_name, "partial": False}
    backend("schemas.node").NodeSiteOut.model_validate(out)
    return out


async def test_правка_размещения_шлёт_id_площадок_по_именам(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.get("/deployment/sites", SITES)
    api.patch("/nodes/n2", node("n2", "API", sites=[
        site_ref(CLUSTER, "Кластер prod", "Облако"), site_ref(CLOUD, "Облако"),
    ]))

    out = await tools.call(
        "archmap_update_node",
        # Регистр имени не важен, если площадка одна такая; повтор — одна площадка.
        {"project": "Ярмарка", "node_id": "n2", "sites": ["Кластер prod", "облако", "Облако"]},
        client,
    )

    body = json.loads(api.calls[-1].content)
    assert body == {"site_ids": [CLUSTER, CLOUD]}
    check_node_contract("NodeUpdate", body)
    assert "обновлён «API»: sites." in out
    assert out.splitlines()[-1] == "Размещение: Кластер prod (в Облако), Облако"


async def test_пустой_список_площадок_снимает_размещение(
    client: ArchMapClient, api: FakeApi
) -> None:
    """⚠️ Фильтр «не None» отбросил бы [] как пустое поле — и снять размещение было бы
    нечем. Список площадок при [] не нужен: id не резолвятся."""
    api.patch("/nodes/n2", node("n2", "API", sites=[]))

    out = await tools.call(
        "archmap_update_node", {"project": "Ярмарка", "node_id": "n2", "sites": []}, client
    )

    assert json.loads(api.calls[-1].content) == {"site_ids": []}
    assert "/deployment/sites" not in " ".join(c.url.path for c in api.calls)
    assert out.splitlines()[-1] == "Размещение: не указано"


async def test_неизвестная_площадка_отказ_с_перечнем_и_без_записи(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.get("/deployment/sites", SITES)

    with pytest.raises(ArchMapError) as exc:
        await tools.call(
            "archmap_update_node",
            {"project": "Ярмарка", "node_id": "n2", "sites": ["Облако", "Кластер dev"]},
            client,
        )

    text = str(exc.value)
    assert text.startswith("Площадки «Кластер dev» в проекте «Ярмарка» нет. ")
    assert "Есть: «Кластер prod», «Облако»." in text
    assert "Через MCP площадки не создаются" in text
    assert "PATCH" not in [c.method for c in api.calls]


async def test_без_ключа_sites_размещение_не_трогается(client: ArchMapClient, api: FakeApi) -> None:
    api.patch("/nodes/n2", node("n2", "API"))

    out = await tools.call(
        "archmap_update_node", {"project": "Ярмарка", "node_id": "n2", "name": "API"}, client
    )

    assert json.loads(api.calls[-1].content) == {"name": "API"}
    assert "Размещение" not in out
