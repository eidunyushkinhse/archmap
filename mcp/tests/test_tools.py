"""Инструменты: разрешение проекта, свёртка ответов, границы записи."""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from pathlib import Path
from typing import Any, get_args

import httpx
import pytest
from conftest import PROJECT_ID, FakeApi, backend, node

from archmap_mcp import tools
from archmap_mcp.client import ArchMapClient, ArchMapError, Config

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
        f"• Плёнка [чтение]: 2 объектов · демо  id={OTHER_ID}",
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
    assert "  • Сервис заказов [контейнер, Python]" in out  # вложенность отступом
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
    assert "OpenAPI-спецификация: есть" in out
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

    out = await tools.call("archmap_alerts", {"project": "Ярмарка"}, client)
    assert "Рекомендаций нет. Схема описана полностью." in out


# ── Правила формата (промпты BYOA) ───────────────────────────────────────────

PROMPT_PATH = "/projects/import/prompt"


async def test_промпт_импорта_без_вариантов_шлёт_прежний_запрос(
    client: ArchMapClient, api: FakeApi
) -> None:
    # Сентинел совместимости: строительный промпт — дефолт и ручки, и инструмента,
    # поэтому обычный вызов обязан остаться прежним ЗАПРОСОМ, а не только прежним
    # результатом. Единственная санкционированная правка контракта (фаза 3 сборщика
    # фактов, docs/tasks/fact-collector.md): адрес ArchMap в origin уходит всегда — по нему
    # промпт начинается с запуска сборщика.
    api.get(PROMPT_PATH, {"prompt": "правила формата"})

    await tools.call("archmap_import_prompt", {"system_name": "Zabbix"}, client)
    assert api.calls[-1].url.query == b"system_name=Zabbix&origin=http%3A%2F%2Farchmap.test"

    await tools.call(
        "archmap_import_prompt",
        {"system_name": "Zabbix", "variant": "builder"},
        client,
    )
    assert (
        api.calls[-1].url.query
        == b"system_name=Zabbix&variant=builder&origin=http%3A%2F%2Farchmap.test"
    )


async def test_промпт_импорта_называет_адрес_каким_его_видит_агент(api: FakeApi) -> None:
    """Удалённо запросы в API идут по внутреннему адресу, а агент пришёл по внешнему:
    в команду curl промпта обязан попасть внешний (public_base_url)."""
    api.get(PROMPT_PATH, {"prompt": "правила формата"})
    http = httpx.AsyncClient(transport=httpx.MockTransport(api.handler()))
    remote = ArchMapClient(
        Config.remote("http://127.0.0.1:8000"), http=http, bearer="archmap_x",
        public_base_url="https://archmap.example.com/",
    )

    await tools.call_remote("archmap_import_prompt", {"system_name": "Zabbix"}, remote, read_only=True)
    assert api.calls[-1].url.params["origin"] == "https://archmap.example.com"
    assert str(api.calls[-1].url).startswith("http://127.0.0.1:8000/api/v1/projects/import/prompt")


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


async def test_ссылка_на_загрузку_и_команда(client: ArchMapClient, api: FakeApi) -> None:
    """archmap_upload_url: адрес складывается из адреса ArchMap глазами агента, команда
    curl готова к вставке, upload_id назван отдельно — его передают в files."""
    api.post("/uploads", {"id": "u1", "name": "repo-a.yaml", "path": "/api/v1/uploads/u1/КЛЮЧ",
                          "expires_at": "2026-10-28T12:10:00Z", "max_bytes": 2 * 1024 * 1024})

    out = await tools.call("archmap_upload_url", {"project": "Ярмарка", "name": "repo-a.yaml"}, client)

    assert f"{client.public_base_url}/api/v1/uploads/u1/КЛЮЧ" in out
    assert "curl -sS -T путь/к/repo-a.yaml" in out and "2 МБ" in out
    assert "upload_id: u1" in out
    body = json.loads(api.calls[-1].content)
    assert body == {"name": "repo-a.yaml"}


async def test_файл_по_upload_id_подставляется_и_сверяется(client: ArchMapClient, api: FakeApi) -> None:
    """{name, upload_id} в files: содержимое берётся из загрузки (GET /uploads/{id}),
    бэкенду уходит текст как обычно, а в конце — эхо размера и sha256."""
    text = "nodes:\n  - name: Система\n"
    digest = hashlib.sha256(text.encode()).hexdigest()
    api.get("/uploads/u1", {"id": "u1", "name": "r.yaml", "size": len(text.encode()), "sha256": digest,
                            "content": text})
    api.post(f"/projects/{PROJECT_ID}/sync/preview", sync_plan())

    out = await tools.call(
        "archmap_sync_preview",
        {"project": "Ярмарка", "files": [{"name": "r.yaml", "upload_id": "u1"}]},
        client,
    )

    body = json.loads(api.calls[-1].content)
    assert body["contents"] == [text]
    assert "Получено входов: 1" in out
    assert f"r.yaml · {len(text.encode())} байт, sha256 {digest} (загрузкой по ссылке)" in out


async def test_эхо_sha256_у_текста_вызова(client: ArchMapClient, api: FakeApi) -> None:
    """И у файла текстом вызова — эхо: только так агент заметит, что модель набрала
    текст с ошибками (сервер и превью этого не видят)."""
    api.post(f"/projects/{PROJECT_ID}/sync/preview", sync_plan())
    text = "nodes: []\n"

    out = await tools.call(
        "archmap_sync_preview", {"project": "Ярмарка", "files": [{"name": "r.yaml", "content": text}]}, client
    )

    assert f"sha256 {hashlib.sha256(text.encode()).hexdigest()} (текстом вызова)" in out


async def test_paths_у_синка_локально_читаются_с_диска(client: ArchMapClient, api: FakeApi, tmp_path) -> None:
    """Локальный режим: файл с диска встаёт в files под своим именем, без перепечатки."""
    p = tmp_path / "repo-b.yaml"
    p.write_text("nodes:\n  - name: B\n", encoding="utf-8")
    api.post(f"/projects/{PROJECT_ID}/sync/preview", sync_plan())

    out = await tools.call("archmap_sync_preview", {"project": "Ярмарка", "paths": [str(p)]}, client)

    body = json.loads(api.calls[-1].content)
    assert body["contents"] == ["nodes:\n  - name: B\n"]
    assert "repo-b.yaml" in out and "(с диска)" in out
    check_contract("SyncPreviewIn", body)


async def test_файл_без_content_и_upload_id_или_с_обоими_отклоняется(client: ArchMapClient) -> None:
    with pytest.raises(ArchMapError) as exc:
        await tools.call("archmap_sync_preview", {"project": "Ярмарка", "files": [{"name": "r.yaml"}]}, client)
    assert "archmap_upload_url" in str(exc.value)
    with pytest.raises(ArchMapError) as exc:
        await tools.call(
            "archmap_sync_preview",
            {"project": "Ярмарка", "files": [{"name": "r.yaml", "content": "x", "upload_id": "u1"}]},
            client,
        )
    assert "не оба" in str(exc.value)


async def test_просроченная_загрузка_называет_файл(client: ArchMapClient, api: FakeApi) -> None:
    api.get("/uploads/u9", httpx.Response(410, json={"detail": "Срок загрузки истёк — запросите новую ссылку"}))
    with pytest.raises(ArchMapError) as exc:
        await tools.call(
            "archmap_sync_preview", {"project": "Ярмарка", "files": [{"name": "old.yaml", "upload_id": "u9"}]}, client
        )
    assert "old.yaml" in str(exc.value) and "истёк" in str(exc.value)


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
    assert "Схема уже соответствует присланному YAML" in out


async def test_негодный_прогон_называет_ошибки_а_не_нули(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.post(f"/projects/{PROJECT_ID}/sync/preview", sync_plan(
        ok=False, errors=["вход 1: корень документа должен быть словарём"],
        nodes=[], summary={},
    ))

    # Плана нет — отказ (isError): агент исправляет прогон, а не читает пустой план.
    with pytest.raises(ArchMapError) as exc:
        await tools.call(
            "archmap_sync_preview",
            {"project": "Ярмарка", "files": [{"name": "r.yaml", "content": "мусор"}]},
            client,
        )

    assert "корень документа должен быть словарём" in str(exc.value)
    assert "Будет сделано" not in str(exc.value)


async def test_прогон_без_типа_у_объекта_с_вложенными_отказ(
    client: ArchMapClient, api: FakeApi
) -> None:
    """Тип выбран всегда: прогон без element у объекта с вложенными плана не получает —
    причина словами продукта в отказе."""
    отказ = (
        "У объекта с вложенными объектами не указан тип: «Система». Укажите element: system "
        "или element: container."
    )
    api.post(f"/projects/{PROJECT_ID}/sync/preview", sync_plan(
        ok=False, errors=[отказ], nodes=[], summary={},
    ))

    with pytest.raises(ArchMapError) as exc:
        await tools.call(
            "archmap_sync_preview",
            {"project": "Ярмарка", "files": [{"name": "r.yaml", "content": "nodes: []"}]},
            client,
        )

    assert отказ in str(exc.value)


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
        skipped=["Маркетплейс / Склад: тип не изменён. У объекта есть вложенные объекты — базой данных, брокером или «Пользователем» ему не стать"],
        graph_rev=12,
        code_changes_cleared=["gitlab.example.org/market/shop"],
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
    # Пропуски бывают не только «цель исчезла»: сервер оставляет и тип, который менять
    # нельзя, — причина в самой строке, заголовок её не подменяет.
    assert "Пропущено (причина в строке): 1" in out
    assert "• Маркетплейс / Склад: тип не изменён." in out
    assert "graph_rev=12" in out
    # обновление из кода с объектами репозитория снимает напоминание о слиянии из CI
    assert (
        "Напоминание «Документацию пора обновить» снято для репозитория "
        "gitlab.example.org/market/shop." in out
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


async def test_удаление_только_пачкой_с_версией() -> None:
    # Решение владельца 2026-11-21 (вместо прежнего «удалений нет» от 2026-08-10):
    # агент удаляет лишнее сам, но ТОЛЬКО через archmap_delete, то есть POST /deletions,
    # где сервер сперва сохраняет версию. Метод DELETE не шлёт ни один инструмент:
    # личным токеном он закрыт, а без версии удалённое не вернуть.
    assert [t["name"] for t in tools.TOOLS if "delete" in t["name"] or "remove" in t["name"]] == [
        "archmap_delete"
    ]
    source = Path(tools.__file__).read_text(encoding="utf-8")
    assert '"DELETE"' not in source


def test_правка_объекта_называет_удаление_пачкой() -> None:
    # Находка 3 (2026-11-24): описание правки объекта говорило агенту «удаления объектов
    # через MCP нет», хотя есть archmap_delete. Теперь оно называет его, а статус
    # deprecated оставляет для того, что выводят из эксплуатации.
    desc = next(t["description"] for t in tools.TOOLS if t["name"] == "archmap_update_node")
    assert "archmap_delete" in desc and "status=deprecated" in desc
    for t in tools.TOOLS:
        assert "Удаления объектов через MCP нет" not in t["description"], t["name"]


async def test_удаление_пачкой_тело_по_схеме_бэкенда_и_отчёт(api: FakeApi, client) -> None:
    schemas = backend("schemas.deletions")
    cache, edge, doc, shop = (str(uuid.uuid4()) for _ in range(4))
    api.post("/deletions", schemas.DeletionOut(
        dry_run=False,
        items=[
            schemas.DeletionTarget(kind="node", id=cache, label="Ярмарка / Заказы / Кэш", covered_by=None),
            schemas.DeletionTarget(kind="doc", id=doc, label="«Прогрев» у Ярмарка / Заказы / Кэш", covered_by=cache),
            schemas.DeletionTarget(kind="edge", id=edge, label="Ярмарка / Заказы → Ярмарка / Оплаты", covered_by=None),
        ],
        totals=schemas.DeletionTotals(processes=0, nodes=1, edges=3, docs=1, facts=0, instances=0, process_links=2),
        version=schemas.DeletionVersion(node_id=shop, label="Ярмарка", number=4, created=True),
    ).model_dump(mode="json"))

    text = await tools.call(
        "archmap_delete",
        {"project": "Ярмарка", "items": [{"kind": "node", "id": cache}, {"kind": "doc", "id": doc},
                                         {"kind": "edge", "id": edge}], "reason": "дубль прогона"},
        client,
    )

    body = json.loads(api.calls[-1].content)
    schemas.DeletionRequest.model_validate(body)
    assert body["reason"] == "дубль прогона" and body["dry_run"] is False
    assert api.calls[-1].method == "POST"
    assert "В проекте «Ярмарка» удалено:" in text
    assert f"схема логики «Прогрев» у Ярмарка / Заказы / Кэш  id={doc} (вместе с «Ярмарка / Заказы / Кэш»)" in text
    assert "Всего ушло: 1 объект, 3 связи, 1 схема логики." in text
    assert "В процессах опустеют привязки к удалённому: 2" in text
    assert "Перед удалением сохранена версия v4 объекта «Ярмарка»." in text
    assert "откат к v4 в истории версий объекта «Ярмарка»" in text


async def test_удаление_пачкой_dry_run_и_версия_проекта(api: FakeApi, client) -> None:
    schemas = backend("schemas.deletions")
    bank = str(uuid.uuid4())
    api.post("/deletions", schemas.DeletionOut(
        dry_run=True,
        items=[schemas.DeletionTarget(kind="node", id=bank, label="Банк", covered_by=None)],
        totals=schemas.DeletionTotals(processes=0, nodes=1, edges=0, docs=0, facts=0, instances=0, process_links=0),
        version=schemas.DeletionVersion(node_id=None, label=None, number=None, created=False),
    ).model_dump(mode="json"))

    text = await tools.call(
        "archmap_delete", {"project": "Ярмарка", "items": [{"kind": "node", "id": bank}], "dry_run": True},
        client,
    )

    assert json.loads(api.calls[-1].content)["dry_run"] is True
    assert "будет удалено:" in text and "Всего уйдёт: 1 объект." in text
    assert "сохранит версию всего проекта" in text and "опустеют" not in text
    assert "Вернуть" not in text


async def test_удаление_пачкой_кривой_пункт_до_запроса(api: FakeApi, client) -> None:
    with pytest.raises(ArchMapError, match="Каждый пункт items"):
        await tools.call("archmap_delete", {"project": "Ярмарка", "items": [{"id": "x"}]}, client)
    assert not [c for c in api.calls if c.url.path.endswith("/deletions")]


async def test_каждый_инструмент_описан_и_вызываем() -> None:
    for t in tools.TOOLS:
        assert t["name"].startswith("archmap_")
        assert len(t["description"]) > 40, t["name"]
        assert t["schema"]["type"] == "object"
        assert callable(t["handler"])


# Внутренний словарь в описания не попадает (правило владельца 2026-10-29): агент
# пользователя говорит словами продукта — «спецификация», «схемы логики и
# спецификации», «система», «контейнер», «компонент».
_JARGON = re.compile(
    r"(?<![а-яёА-ЯЁ])([Сс]пек(а|и|у|ой|е|ам|ах|ами)?|[Дд]оки|[Дд]оков|[Кк]оробк\w*|[Мм]одул\w*)"
    r"(?![а-яёА-ЯЁ])"
)


def _descriptions(value: object) -> list[str]:
    """Все тексты description в схеме инструмента, на любой глубине."""
    if isinstance(value, dict):
        own = [value["description"]] if isinstance(value.get("description"), str) else []
        return own + [d for v in value.values() for d in _descriptions(v)]
    if isinstance(value, list):
        return [d for v in value for d in _descriptions(v)]
    return []


def test_в_описаниях_инструментов_нет_жаргона() -> None:
    hits = [
        f"{t['name']}: {m.group(0)}"
        for t in [*tools.TOOLS, *tools.REMOTE_TOOLS]
        for text in [t["description"], *_descriptions(t["schema"])]
        for m in _JARGON.finditer(text)
    ]
    assert not hits


# ── Источник в правках объекта ──────────────────────────────────────────────────

def check_node_contract(schema: str, body: dict[str, object]) -> None:
    """Тело правки объекта глазами бэкенда (NodeCreate / NodeUpdate).

    Схемы бэкенда лишних полей не запрещают (extra="forbid" нет), поэтому одной
    model_validate мало: поле, которого сервер не знает, прошло бы проверку, сервер
    молча выбросил бы его, а инструмент ответил бы «обновлён» (камень 24
    docs/plan-c4-elements.md). Ключи тела сверяются с полями схемы."""
    model = getattr(backend("schemas.node"), schema)
    unknown = set(body) - set(model.model_fields)
    assert not unknown, f"{schema} не знает полей тела: {sorted(unknown)}"
    model.model_validate(body)


def test_сторож_контракта_ловит_лишнее_поле_тела() -> None:
    with pytest.raises(AssertionError, match="no_such_field"):
        check_node_contract("NodeUpdate", {"name": "X", "no_such_field": 1})


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
    assert "Источник: нет, объект опознаётся по имени" in out


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
    assert "Источник: нет, объект опознаётся по имени" in out


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


async def test_статус_страницы_ставится_у_контейнера_с_компонентами(
    client: ArchMapClient, api: FakeApi
) -> None:
    # Р14: контейнер с компонентами ставит свой статус — подтверждение без счётчика.
    api.patch("/nodes/n2", node("n2", "orders", has_children=True, element="container",
                                element_effective="container",
                                approval="approved", approval_effective="approved"))

    out = await tools.call(
        "archmap_update_node", {"project": "Ярмарка", "node_id": "n2", "approval": "approved"}, client
    )

    assert out.splitlines()[-1] == "Статус страницы: согласовано"
    desc = tools.BY_NAME["archmap_update_node"]["description"]
    assert "только у контейнера или компонента" in desc
    assert "у системы он складывается из вложенных объектов" in desc


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

    assert "update: М / Заказы (description) · по коду" in out
    assert "update: М / Kafka · по имени зависимости" in out
    assert "create: М / Оплата · источник: код github.com/y/pay, путь svc" in out
    assert "create: М / Ручной · источника нет, объект будет опознаваться по имени" in out


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


# ── Элемент архитектуры (docs/plan-c4-elements.md, Ф1) ─────────────────────────

async def test_создание_объекта_шлёт_элемент(client: ArchMapClient, api: FakeApi) -> None:
    api.post("/nodes", node("n7", "orders", element="container", element_effective="container"))

    out = await tools.call(
        "archmap_create_node",
        {"project": "Ярмарка", "name": "orders", "element": "container"},
        client,
    )

    body = json.loads(api.calls[-1].content)
    assert body["element"] == "container"
    check_node_contract("NodeCreate", body)
    assert out.splitlines()[-1] == "Элемент архитектуры: контейнер"


async def test_создание_без_элемента_поля_не_шлёт(client: ArchMapClient, api: FakeApi) -> None:
    api.post("/nodes", node("n8", "billing", element=None, element_effective="container"))

    out = await tools.call(
        "archmap_create_node", {"project": "Ярмарка", "name": "billing", "element": ""}, client
    )

    assert "element" not in json.loads(api.calls[-1].content)
    assert "Элемент архитектуры" not in out


async def test_правка_объекта_шлёт_элемент(client: ArchMapClient, api: FakeApi) -> None:
    api.patch("/nodes/n2", node("n2", "orders", element="container", element_effective="container"))

    out = await tools.call(
        "archmap_update_node", {"project": "Ярмарка", "node_id": "n2", "element": "container"}, client
    )

    body = json.loads(api.calls[-1].content)
    assert body == {"element": "container"}
    check_node_contract("NodeUpdate", body)
    assert out.splitlines()[-1] == "Элемент архитектуры: контейнер"


async def test_элемент_правки_уходит_только_значением(client: ArchMapClient, api: FakeApi) -> None:
    """Тип выбран всегда (решение владельца 2026-11-01): снять элемент нельзя, правка
    шлёт только значение; действующий элемент после правки — от сервера."""
    api.patch("/nodes/n2", node("n2", "orders", element="system", element_effective="system"))

    out = await tools.call(
        "archmap_update_node", {"project": "Ярмарка", "node_id": "n2", "element": "system"}, client
    )

    body = json.loads(api.calls[-1].content)
    assert body == {"element": "system"}
    check_node_contract("NodeUpdate", body)
    assert "Элемент архитектуры: система" in out


async def test_старый_сервер_без_элемента_строки_не_печатает(
    client: ArchMapClient, api: FakeApi
) -> None:
    # Сервер, который элемента не знает, поле не отдаёт: выдуманное слово было бы неправдой.
    api.patch("/nodes/n2", node("n2", "orders"))

    out = await tools.call(
        "archmap_update_node", {"project": "Ярмарка", "node_id": "n2", "element": "container"}, client
    )

    assert "Элемент архитектуры" not in out


async def test_элемент_в_каталоге_тот_же_что_у_бэкенда() -> None:
    # Ровно словарь сервера: лишнее значение было бы 422 на живом сервере, а пустой строки
    # (прежнего синонима снятия) нет — у сервиса вне контейнера тип есть всегда.
    for name in ("archmap_create_node", "archmap_update_node"):
        arg = tools.BY_NAME[name]["schema"]["properties"]["element"]
        assert arg["enum"] == list(get_args(backend("domain_types").NodeElement))


async def test_дерево_называет_тип_словами_интерфейса(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.get("/nodes/all", [
        node("n1", "shop", has_children=True, element_effective="system"),
        node("n2", "orders", "n1", has_children=True, element="container", element_effective="container"),
        node("n3", "api", "n2", element_effective="component"),
        node("n4", "billing", "n1", element_effective="container"),
    ])
    api.get("/edges", [])

    out = await tools.call("archmap_schema", {"project": "Ярмарка"}, client)

    lines = out.splitlines()
    # Тип стоит в скобках строки словами интерфейса (MCP 0.13.2): контейнер с
    # компонентами и лист-контейнер — одного типа, маркера «(контейнер)» больше нет.
    assert "• shop [система]  id=n1" in lines
    assert "  • orders [контейнер]  id=n2" in lines
    assert "    • api [компонент]  id=n3" in lines
    assert "  • billing [контейнер]  id=n4" in lines


async def test_дерево_помечает_пустую_систему(client: ArchMapClient, api: FakeApi) -> None:
    # Пустая система (Р39) — лист в дереве; без маркера агент прочёл бы её контейнером.
    api.get("/nodes/all", [
        node("n1", "shop", has_children=True, element_effective="system"),
        node("n2", "warehouse", "n1", has_children=False, element="system", element_effective="system"),
    ])
    api.get("/edges", [])

    out = await tools.call("archmap_schema", {"project": "Ярмарка"}, client)

    assert "  • warehouse (система без контейнеров) [система]  id=n2" in out.splitlines()


async def test_дерево_не_помечает_внешнюю_систему(client: ArchMapClient, api: FakeApi) -> None:
    # Внешняя система (Р42) — чёрный ящик: пометки «без контейнеров» нет, внешность
    # видна в свойствах строки.
    api.get("/nodes/all", [
        node("n1", "Банк", has_children=False, is_external=True, element_effective="system"),
    ])
    api.get("/edges", [])

    out = await tools.call("archmap_schema", {"project": "Ярмарка"}, client)

    assert "• Банк [система, внешний]  id=n1" in out.splitlines()


async def test_план_синка_отказ_схеме_сборщика(client: ArchMapClient, api: FakeApi) -> None:
    """Схему сборщика обновление из кода не принимает: отказ печатается строкой ошибки."""
    rejected = backend("scan_origin").SCHEMA_REJECTED
    api.post(f"/projects/{PROJECT_ID}/sync/preview", sync_plan(ok=False, errors=[f"файл 2: {rejected}"]))

    with pytest.raises(ArchMapError) as e:
        await tools.call(
            "archmap_sync_preview",
            {"project": "Ярмарка", "files": [{"name": "a.yaml", "content": "x"},
                                             {"name": "schema.yaml", "content": "y"}]},
            client,
        )

    assert str(e.value).splitlines()[-1] == f"  • файл 2: {rejected}"


async def test_удаление_процесса_говорит_как_вернуть(api: FakeApi, client) -> None:
    schemas = backend("schemas.deletions")
    proc = str(uuid.uuid4())
    api.post("/deletions", schemas.DeletionOut(
        dry_run=False,
        items=[schemas.DeletionTarget(kind="process", id=proc, label="«Оформление»", covered_by=None)],
        totals=schemas.DeletionTotals(processes=1, nodes=0, edges=0, docs=0, facts=0, instances=0, process_links=0),
        version=schemas.DeletionVersion(node_id=None, label=None, number=3, created=True),
    ).model_dump(mode="json"))

    text = await tools.call(
        "archmap_delete", {"project": "Ярмарка", "items": [{"kind": "process", "id": proc}]}, client
    )

    assert f"  • процесс «Оформление»  id={proc}" in text
    assert "Всего ушло: 1 процесс." in text
    assert "Процесс откат не вернёт" in text and "archmap_process_apply" in text
