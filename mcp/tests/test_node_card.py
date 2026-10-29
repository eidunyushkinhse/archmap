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

from archmap_mcp import render, tools
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


# ── Источник объекта ────────────────────────────────────────────────────────────
#
# Источник — чем ArchMap опознаёт объект при обновлениях из кода. В карточке до Ф4
# его не было вовсе: агент правил имя объекта, не зная, переживёт ли объект эту
# правку как тот же самый или следующий прогон сделает из него дубль.

def anchored(api: FakeApi, source: dict[str, Any] | None, source_ref: str | None) -> None:
    """Карточка узла с ЯКОРЕМ. Форма ответа сверяется NodeResponse бэкенда:
    подменённый транспорт её не валидирует, и без сверки тест зелён на выдумке."""
    target = node(NODE, "Оркестратор заказа", shape="service")
    target |= {
        "docs": [], "child_count": 0, "has_children": False,
        "element": None, "element_effective": "container",
        "source_ref": source_ref, "source": source, "version": 3,
        "created_at": "2026-09-04T10:00:00", "updated_at": "2026-09-04T10:00:00",
    }
    backend("schemas.node").NodeResponse.model_validate(target)
    api.get(f"/nodes/{NODE}", target)
    api.get("/nodes/all", [target])
    api.get(f"/nodes/{NODE}/edges", [])
    api.get(f"/nodes/{NODE}/docs", [])
    api.get(f"/nodes/{NODE}/processes", [])
    api.get(f"/nodes/{NODE}/config", [])


async def test_карточка_печатает_источник_кода(client: ArchMapClient, api: FakeApi) -> None:
    anchored(
        api,
        {"repo": "github.com/org/repo", "path": "src/api", "host": None},
        "git:github.com/org/repo#src/api",
    )

    out = await tools.call("archmap_node", {"project": "Ярмарка", "node_id": NODE}, client)

    assert "Источник: код github.com/org/repo, путь src/api" in out


async def test_карточка_печатает_имя_зависимости(client: ArchMapClient, api: FakeApi) -> None:
    anchored(api, {"repo": None, "path": None, "host": "postgres"}, "host:postgres")

    out = await tools.call("archmap_node", {"project": "Ярмарка", "node_id": NODE}, client)

    assert "Источник: имя зависимости postgres" in out


async def test_без_источника_карточка_называет_последствие(
    client: ArchMapClient, api: FakeApi
) -> None:
    # Не «пусто», а по чему объект тогда узнают: молчание тут читается как
    # «источник есть», и агент правит имя, не зная цены правки.
    anchored(api, None, None)

    out = await tools.call("archmap_node", {"project": "Ярмарка", "node_id": NODE}, client)

    assert "Источник: нет — опознаётся по имени" in out


async def test_слова_источника_те_же_что_в_интерфейсе() -> None:
    """N36 docs/specs/node.md: MCP и экран называют источник одинаково. Судья —
    сам словарь фронта (anchorText.ts), а не память автора теста."""
    text = (
        Path(__file__).resolve().parents[2]
        / "frontend/src/components/anchor/anchorText.ts"
    ).read_text(encoding="utf-8")
    assert 'code: "код", dependency: "имя зависимости"' in text
    assert f'NO_ANCHOR = "{render.NO_ANCHOR}"' in text
    for word in render.BASIS_LABEL.values():
        assert f'"{word}"' in text
    assert "источника нет — будет опознаваться по имени" in text


# ── Статус страницы (docs/tasks/page-status.md) ──────────────────────────────

async def test_статус_страницы_листа(client: ArchMapClient, api: FakeApi) -> None:
    base_routes(api, "service", approval="approved", approval_effective="approved")
    api.get(f"/nodes/{NODE}/config", [])

    out = await tools.call("archmap_node", {"project": "Ярмарка", "node_id": NODE}, client)

    assert "Статус страницы: согласовано" in out.splitlines()
    # Строка стоит в шапке карточки, сразу после источника.
    lines = out.splitlines()
    assert lines.index("Статус страницы: согласовано") == lines.index(render.anchor_line(node(NODE, "Узел"))) + 1


async def test_статус_страницы_системы_складывается_из_вложенных_объектов(
    client: ArchMapClient, api: FakeApi
) -> None:
    # Хранимое «согласовано» у системы не показывается: статус — вычисленный сервером,
    # счётчик — по единицам любой глубины: контейнер и его компонент считаются оба,
    # вложенная система — нет (её объекты — да).
    target = base_routes(
        api, "service", has_children=True, approval="approved", approval_effective="in_progress",
        element=None, element_effective="system",
    )
    api.get("/nodes/all", [
        target,
        node(u(1), "orders", NODE, element="container", element_effective="container",
             has_children=True, approval="approved", approval_effective="approved"),
        node(u(2), "orders/api", u(1), element=None, element_effective="component",
             approval="in_progress", approval_effective="in_progress"),
        node(u(3), "Склад", NODE, element=None, element_effective="system", has_children=True,
             approval="approved", approval_effective="approved"),
        node(u(4), "Остатки", u(3), element=None, element_effective="container",
             approval="approved", approval_effective="approved"),
        node(u(5), "Покупатель", NODE, shape="person", element=None, element_effective=None,
             approval="in_progress", approval_effective="in_progress"),
    ])
    api.get(f"/nodes/{NODE}/config", [])

    out = await tools.call("archmap_node", {"project": "Ярмарка", "node_id": NODE}, client)

    assert (
        "Статус страницы: в работе — складывается из вложенных объектов, согласовано 2 из 4"
        in out.splitlines()
    )


async def test_статус_страницы_контейнера_с_компонентами_свой(
    client: ArchMapClient, api: FakeApi
) -> None:
    # Р14: у контейнера с компонентами статус свой, как у листа, — без счётчика.
    target = base_routes(
        api, "service", has_children=True, approval="approved", approval_effective="approved",
        element="container", element_effective="container",
    )
    api.get("/nodes/all", [
        target,
        node(u(1), "orders/api", NODE, element=None, element_effective="component",
             approval="in_progress", approval_effective="in_progress"),
    ])
    api.get(f"/nodes/{NODE}/config", [])

    out = await tools.call("archmap_node", {"project": "Ярмарка", "node_id": NODE}, client)

    assert "Статус страницы: согласовано" in out.splitlines()


async def test_старый_сервер_статус_по_прямым_детям(
    client: ArchMapClient, api: FakeApi
) -> None:
    # Сервер без элементов архитектуры (нет element_effective): как до эпика —
    # складывается из детей, счётчик по прямым детям (внук не считается).
    target = base_routes(
        api, "service", has_children=True, approval="approved", approval_effective="in_progress"
    )
    api.get("/nodes/all", [
        target,
        node(u(1), "Сервис заказов", NODE, approval="approved", approval_effective="approved"),
        node(u(2), "База заказов", NODE, shape="database",
             approval="in_progress", approval_effective="in_progress"),
        node(u(3), "Kafka заказов", NODE, shape="broker",
             approval="approved", approval_effective="approved"),
        node(u(4), "Внук", u(1), approval="in_progress", approval_effective="in_progress"),
    ])
    api.get(f"/nodes/{NODE}/config", [])

    out = await tools.call("archmap_node", {"project": "Ярмарка", "node_id": NODE}, client)

    assert "Статус страницы: в работе — складывается из детей, согласовано 2 из 3" in out


async def test_сервер_без_статуса_страниц_строки_не_выдумывает(
    client: ArchMapClient, api: FakeApi
) -> None:
    base_routes(api, "service")
    api.get(f"/nodes/{NODE}/config", [])

    out = await tools.call("archmap_node", {"project": "Ярмарка", "node_id": NODE}, client)

    assert "Статус страницы" not in out


async def test_слова_статуса_страницы_те_же_что_в_интерфейсе() -> None:
    """Агент и экран называют статус одинаково: судья — словарь фронта (nodeTerms.ts)."""
    text = (
        Path(__file__).resolve().parents[2] / "frontend/src/components/nodeTerms.ts"
    ).read_text(encoding="utf-8")
    block = text.split("export const APPROVAL_LABEL", 1)[1].split("};", 1)[0]
    labels = dict(re.findall(r'(in_progress|approved): "([^"]+)"', block))
    assert {k: v.lower() for k, v in labels.items()} == render.APPROVAL_WORD


# ── Размещение на площадках (Ф4 эпика развёртывания) ─────────────────────────

def site_ref(site_id: str, name: str, parent_name: str | None = None,
             partial: bool = False) -> dict[str, Any]:
    """Строка NodeResponse.sites — площадка объекта (у контейнера partial — стоит часть)."""
    return {
        "id": site_id, "name": name, "kind": "kubernetes",
        "parent_id": u(71) if parent_name else None, "parent_name": parent_name,
        "partial": partial,
    }


async def test_карточка_называет_размещение_после_источника(
    client: ArchMapClient, api: FakeApi
) -> None:
    base_routes(api, "service", sites=check("node", "NodeSiteOut", [
        site_ref(u(70), "Кластер prod", "Облако"), site_ref(u(72), "ВМ-2"),
    ]))
    api.get(f"/nodes/{NODE}/config", [])

    out = await tools.call("archmap_node", {"project": "Ярмарка", "node_id": NODE}, client)

    lines = out.splitlines()
    i = lines.index("Размещение: Кластер prod (в Облако), ВМ-2")
    assert lines[i - 1].startswith("Источник:")
    # Вид площадки словом — в archmap_deployment; карточке хватает имён.
    assert "kubernetes" not in out


async def test_частичное_размещение_контейнера_помечено(
    client: ArchMapClient, api: FakeApi
) -> None:
    base_routes(api, "service", sites=check("node", "NodeSiteOut", [
        site_ref(u(70), "Кластер prod", "Облако", partial=True), site_ref(u(72), "ВМ-2", partial=True),
    ]))
    api.get(f"/nodes/{NODE}/config", [])

    out = await tools.call("archmap_node", {"project": "Ярмарка", "node_id": NODE}, client)

    assert "Размещение: Кластер prod (в Облако, часть объектов), ВМ-2 (часть объектов)" in out


async def test_без_размещения_строки_нет(client: ArchMapClient, api: FakeApi) -> None:
    base_routes(api, "service", sites=[])
    api.get(f"/nodes/{NODE}/config", [])

    out = await tools.call("archmap_node", {"project": "Ярмарка", "node_id": NODE}, client)

    assert "Размещение" not in out


# ── Элемент архитектуры (docs/plan-c4-elements.md, Ф1) ─────────────────────────

def element_routes(api: FakeApi, target: dict[str, Any], others: list[dict[str, Any]]) -> None:
    api.get(f"/nodes/{NODE}", target)
    api.get("/nodes/all", [*others, target])
    api.get(f"/nodes/{NODE}/edges", [])
    api.get(f"/nodes/{NODE}/docs", [])
    api.get(f"/nodes/{NODE}/processes", [])
    api.get(f"/nodes/{NODE}/config", [])


async def test_карточка_компонента_называет_его_контейнер(
    client: ArchMapClient, api: FakeApi
) -> None:
    # Составной компонент jobs между узлом и контейнером: имя берётся у ближайшего
    # предка-контейнера, а не у родителя.
    target = node(NODE, "nightly", u(3), element=None, element_effective="component")
    element_routes(api, target, [
        node(u(1), "shop", element=None, element_effective="system", has_children=True),
        node(u(2), "orders", u(1), element="container", element_effective="container",
             has_children=True),
        node(u(3), "jobs", u(2), element=None, element_effective="component", has_children=True),
    ])

    out = await tools.call("archmap_node", {"project": "Ярмарка", "node_id": NODE}, client)

    lines = out.splitlines()
    i = lines.index("Элемент архитектуры: компонент контейнера «orders»")
    assert lines[i - 1].startswith("Объект: nightly")
    assert lines[i + 1].startswith("Источник:")


async def test_карточка_контейнера(client: ArchMapClient, api: FakeApi) -> None:
    target = node(NODE, "orders", element="container", element_effective="container",
                  has_children=True)
    element_routes(api, target, [])

    out = await tools.call("archmap_node", {"project": "Ярмарка", "node_id": NODE}, client)

    assert "Элемент архитектуры: контейнер" in out.splitlines()


async def test_карточка_без_элемента_от_старого_сервера(
    client: ArchMapClient, api: FakeApi
) -> None:
    # Сервер, который элемента не знает, поле не отдаёт — строки нет, а не выдумка.
    base_routes(api, "service")
    api.get(f"/nodes/{NODE}/config", [])

    out = await tools.call("archmap_node", {"project": "Ярмарка", "node_id": NODE}, client)

    assert "Элемент архитектуры" not in out
