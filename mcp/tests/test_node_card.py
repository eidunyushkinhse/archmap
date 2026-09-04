"""Карточка объекта: семьи фактов по форме, состояние схем логики.

Карточка — главный инструмент чтения у агента, и всё, чего в ней нет, для него
не существует: до Ф1 эпика «Доработка MCP-сервера» так пропадали три семьи
табличных фактов, заглушки разведки и участие схем в процессах.

Фикстуры ответов сверяются схемами САМОГО БЭКЕНДА: подменённый транспорт форму
не валидирует, и без этой сверки тест зелён на выдуманных полях.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from conftest import FakeApi, backend, node

from archmap_mcp import tools
from archmap_mcp.client import ArchMapClient

NODE = "33333333-3333-3333-3333-333333333333"
DOC = "44444444-4444-4444-4444-444444444444"


def u(n: int) -> str:
    return f"{n:08d}-0000-0000-0000-000000000000"


def check(module: str, name: str, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Ответ глазами бэкенда — судья формы фикстуры."""
    schema = getattr(backend(f"schemas.{module}"), name)
    for item in items:
        schema.model_validate(item)
    return items


def base_routes(api: FakeApi, shape: str, **over: Any) -> dict[str, Any]:
    """Общий каркас карточки: сам узел, дерево, связи. Семью фактов и схемы
    докладывает конкретный тест."""
    target = node(NODE, "Узел", shape=shape, **over)
    api.get(f"/nodes/{NODE}", target)
    api.get("/nodes/all", [target])
    api.get(f"/nodes/{NODE}/edges", [])
    api.get(f"/nodes/{NODE}/docs", [])
    api.get(f"/nodes/{NODE}/processes", [])
    return target


def paths(api: FakeApi) -> list[str]:
    return [call.url.path for call in api.calls]


# ── Семьи фактов ─────────────────────────────────────────────────────────────

async def test_карточка_базы_показывает_таблицы_с_колонками(
    client: ArchMapClient, api: FakeApi
) -> None:
    base_routes(api, "database")
    api.get(f"/nodes/{NODE}/tables", check("db_doc", "DbTableResponse", [
        {
            "id": u(1), "node_id": NODE, "name": "orders", "schema_name": "public",
            "description": None, "version": 1,
            "columns": [
                {"id": u(2), "table_id": u(1), "name": "id", "type": "uuid", "nullable": False,
                 "is_primary_key": True, "references_column_id": None, "description": None,
                 "order": 0},
                {"id": u(3), "table_id": u(1), "name": "status", "type": "varchar(32)",
                 "nullable": False, "is_primary_key": False, "references_column_id": None,
                 "description": None, "order": 1},
                {"id": u(4), "table_id": u(1), "name": "note", "type": "text", "nullable": True,
                 "is_primary_key": False, "references_column_id": None, "description": None,
                 "order": 2},
            ],
        },
    ]))

    out = await tools.call("archmap_node", {"project": "Ярмарка", "node_id": NODE}, client)

    assert "СТРУКТУРА БД (1 таблица):" in out
    # Флаги независимы, как чекбоксы в разделе «Структура»: PK и NOT NULL — оба.
    assert "• public.orders: id uuid PK NOT NULL, status varchar(32) NOT NULL, note text" in out
    # Чужие семьи у базы не спрашиваются — их там не бывает по правилам форм.
    assert f"/nodes/{NODE}/tables" in " ".join(paths(api))
    assert "/channels" not in " ".join(paths(api)) and "/config" not in " ".join(paths(api))


async def test_карточка_брокера_показывает_каналы_с_полями(
    client: ArchMapClient, api: FakeApi
) -> None:
    base_routes(api, "broker")
    api.get(f"/nodes/{NODE}/channels", check("broker_channel", "BrokerChannelResponse", [
        {
            "id": u(1), "node_id": NODE, "name": "orders.created", "group_name": "",
            "kind": "topic", "partition_key": "user_id", "delivery": "at-least-once",
            "retention": "7d", "description": None, "version": 1,
            "fields": [
                {"id": u(2), "channel_id": u(1), "name": "order_id", "type": "uuid",
                 "required": True, "description": None, "order": 0},
                {"id": u(3), "channel_id": u(1), "name": "note", "type": "string",
                 "required": False, "description": None, "order": 1},
            ],
        },
    ]))

    out = await tools.call("archmap_node", {"project": "Ярмарка", "node_id": NODE}, client)

    assert "КАНАЛЫ (1 канал):" in out
    assert (
        "• orders.created [topic, ключ: user_id, at-least-once, retention: 7d]: "
        "order_id uuid обяз., note string" in out
    )
    assert "/tables" not in " ".join(paths(api))


async def test_карточка_сервиса_показывает_параметры_конфигурации(
    client: ArchMapClient, api: FakeApi
) -> None:
    base_routes(api, "service")
    api.get(f"/nodes/{NODE}/config", check("config_param", "ConfigParamResponse", [
        {"id": u(1), "node_id": NODE, "name": "ORDER_TIMEOUT", "description": "сколько ждать ответа",
         "value_type": "duration", "required": False, "default_value": "30s", "version": 1},
        {"id": u(2), "node_id": NODE, "name": "DB_DSN", "description": None,
         "value_type": "string", "required": True, "default_value": "", "version": 1},
    ]))

    out = await tools.call("archmap_node", {"project": "Ярмарка", "node_id": NODE}, client)

    assert "КОНФИГУРАЦИЯ (2 параметра):" in out
    assert "• ORDER_TIMEOUT (duration, необяз., по умолчанию «30s») — сколько ждать ответа" in out
    assert "• DB_DSN (string, обяз.)" in out
    assert "/tables" not in " ".join(paths(api)) and "/channels" not in " ".join(paths(api))


async def test_человеку_не_положена_ни_одна_семья(client: ArchMapClient, api: FakeApi) -> None:
    # У формы person фактов не бывает вовсе — карточка не должна выдумывать раздел
    # и не должна ходить за ним на сервер (маршрута нет: лишний запрос упал бы 404).
    base_routes(api, "person")

    out = await tools.call("archmap_node", {"project": "Ярмарка", "node_id": NODE}, client)

    assert "СТРУКТУРА БД" not in out and "КАНАЛЫ" not in out and "КОНФИГУРАЦИЯ" not in out


async def test_перечни_семей_обрезаются_с_честным_хвостом(
    client: ArchMapClient, api: FakeApi
) -> None:
    base_routes(api, "database")
    api.get(f"/nodes/{NODE}/tables", check("db_doc", "DbTableResponse", [
        {
            "id": u(100 + i), "node_id": NODE, "name": f"t{i}", "schema_name": "",
            "description": None, "version": 1,
            "columns": [
                {"id": u(200 + j), "table_id": u(100 + i), "name": f"c{j}", "type": "int",
                 "nullable": True, "is_primary_key": False, "references_column_id": None,
                 "description": None, "order": j}
                for j in range(25)
            ],
        }
        for i in range(45)
    ]))

    out = await tools.call("archmap_node", {"project": "Ярмарка", "node_id": NODE}, client)

    assert "СТРУКТУРА БД (45 таблиц):" in out
    assert "… и ещё 5 таблиц" in out  # 45 записей при капе 40
    assert "… и ещё 5 колонок" in out  # 25 колонок при капе 20
    assert "t44" not in out


# ── Схемы логики ─────────────────────────────────────────────────────────────

async def test_схемы_логики_видом_словарём_заглушками_и_процессами(
    client: ArchMapClient, api: FakeApi
) -> None:
    meta = check("node_doc", "NodeDocMeta", [
        {"id": DOC, "name": "POST /orders", "kind": "operation", "operation": "POST /orders",
         "version": 1, "described": True},
        {"id": u(5), "name": "Ночная сверка", "kind": "worker", "operation": None,
         "version": 1, "described": False},
    ])
    base_routes(api, "service", docs=meta)
    api.get(f"/nodes/{NODE}/docs", check("node_doc", "NodeDocResponse", [
        {"id": DOC, "node_id": NODE, "name": "POST /orders", "kind": "operation",
         "operation": "POST /orders", "content": "flowchart TD\n A --> B", "version": 1,
         "created_at": "2026-09-01T10:00:00", "updated_at": "2026-09-01T10:00:00"},
        # ⚠️ Тело у заглушки НЕ пустое (пробелы): описанность — производное поле
        # described (SQL-trim), и по content её считать нельзя.
        {"id": u(5), "node_id": NODE, "name": "Ночная сверка", "kind": "worker",
         "operation": None, "content": "   ", "version": 1,
         "created_at": "2026-09-01T10:00:00", "updated_at": "2026-09-01T10:00:00"},
    ]))
    api.get(f"/nodes/{NODE}/docs/usage", check("node_doc", "NodeDocUsage", [
        {"doc_id": DOC, "process_id": u(6), "process_name": "Оформление заказа", "steps": 2},
        {"doc_id": DOC, "process_id": u(7), "process_name": "Возврат", "steps": 1},
    ]))
    api.get(f"/nodes/{NODE}/config", [])

    out = await tools.call("archmap_node", {"project": "Ярмарка", "node_id": NODE}, client)

    assert "СХЕМЫ ЛОГИКИ (описано 1 из 2):" in out
    assert (
        "• POST /orders (операция · POST /orders) — в 2 процессах: "
        "Оформление заказа, Возврат" in out
    )
    assert "• Ночная сверка (воркер) — не описана" in out
    assert "operation" not in out and "worker" not in out  # виды — словами, не кодами


async def test_счётчик_описанности_молчит_когда_заглушек_нет(
    client: ArchMapClient, api: FakeApi
) -> None:
    meta = check("node_doc", "NodeDocMeta", [
        {"id": DOC, "name": "POST /orders", "kind": "operation", "operation": None,
         "version": 1, "described": True},
    ])
    base_routes(api, "service", docs=meta)
    api.get(f"/nodes/{NODE}/docs", [
        {"id": DOC, "node_id": NODE, "name": "POST /orders", "kind": "operation",
         "operation": None, "content": "flowchart TD", "version": 1,
         "created_at": "2026-09-01T10:00:00", "updated_at": "2026-09-01T10:00:00"},
    ])
    api.get(f"/nodes/{NODE}/docs/usage", [])
    api.get(f"/nodes/{NODE}/config", [])

    out = await tools.call("archmap_node", {"project": "Ярмарка", "node_id": NODE}, client)

    assert "СХЕМЫ ЛОГИКИ:" in out and "описано" not in out
    assert "— не описана" not in out


async def test_обратный_индекс_не_запрашивается_без_схем(
    client: ArchMapClient, api: FakeApi
) -> None:
    base_routes(api, "service")
    api.get(f"/nodes/{NODE}/config", [])

    out = await tools.call("archmap_node", {"project": "Ярмарка", "node_id": NODE}, client)

    assert "СХЕМЫ ЛОГИКИ:" in out and "(нет)" in out
    assert "/docs/usage" not in " ".join(paths(api))


def test_семьи_фактов_совпадают_с_правилом_форм_фронта() -> None:
    """Сентинел против расхождения с shapeDocs() фронта: правило «форма → семья»
    одно на продукт, и карточка агента обязана жить по нему же."""
    src = (
        Path(__file__).resolve().parents[2] / "frontend/src/types/index.ts"
    ).read_text(encoding="utf-8")
    block = src.split("export const shapeDocs")[1].split("});")[0]
    front = dict(re.findall(r"(\w+):\s*shape === \"(\w+)\"", block))

    assert {"structure": "database", "channels": "broker", "config": "service"}.items() <= front.items()
    assert set(tools.FACT_FAMILY) == {"database", "broker", "service"}
    assert tools.FACT_FAMILY["database"][0] == "tables"
    assert tools.FACT_FAMILY["broker"][0] == "channels"
    assert tools.FACT_FAMILY["service"][0] == "config"


# ── Участие в процессах ──────────────────────────────────────────────────────

async def test_карточка_называет_процессы_объекта(
    client: ArchMapClient, api: FakeApi
) -> None:
    """Вопрос «где этот сервис задействован» — про ОБЪЕКТ, а не про его схемы:
    участником процесса узел бывает и без единой схемы логики."""
    base_routes(api, "service")
    api.get(f"/nodes/{NODE}/config", [])
    api.get(f"/nodes/{NODE}/processes", check("process", "ProcessListItem", [
        {"id": u(7), "name": "Оформление заказа", "scope_node_id": None,
         "scope_name": None, "message_count": 12, "statuses": ["existing"]},
        {"id": u(8), "name": "Возврат", "scope_node_id": NODE,
         "scope_name": "Ярмарка / Заказы", "message_count": 3, "statuses": []},
    ]))

    out = await tools.call("archmap_node", {"project": "Ярмарка", "node_id": NODE}, client)

    assert "УЧАСТВУЕТ В ПРОЦЕССАХ (2):" in out
    assert "• Оформление заказа — шагов 12" in out
    assert f"id={u(8)}" in out


async def test_без_процессов_раздела_в_карточке_нет(
    client: ArchMapClient, api: FakeApi
) -> None:
    base_routes(api, "service")
    api.get(f"/nodes/{NODE}/config", [])

    out = await tools.call("archmap_node", {"project": "Ярмарка", "node_id": NODE}, client)

    assert "УЧАСТВУЕТ В ПРОЦЕССАХ" not in out
    assert f"/nodes/{NODE}/processes" in " ".join(paths(api))
