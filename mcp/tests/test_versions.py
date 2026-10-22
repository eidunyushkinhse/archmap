"""Версии документации объекта: список, дельта, текст на версии, фиксация (ТЗ §8).

Вопрос, ради которого инструменты сделаны: «как изменился процесс в новой версии
сервиса X относительно предыдущей?». Агент идёт archmap_versions → archmap_version_diff
(элемент процесса) → при нужде archmap_version_doc, поэтому тесты держат и пути
запросов (объект и корень проекта), и ключевые строки выдачи.

Фикстуры ответов сверяются схемами САМОГО БЭКЕНДА (app/schemas/versions.py):
подменённый транспорт форму не судит, и без сверки тест зелён на выдуманных полях.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from conftest import FakeApi, backend, node
from test_remote import caller, connect, text

from archmap_mcp import tools
from archmap_mcp.client import ArchMapClient, ArchMapError

NODE = "33333333-3333-3333-3333-333333333333"
DOC = "44444444-4444-4444-4444-444444444444"
PROCESS = "55555555-5555-5555-5555-555555555555"
WHEN = "2026-10-22T10:15:00Z"


def check(name: str, item: dict[str, Any]) -> dict[str, Any]:
    """Ответ глазами бэкенда — судья формы фикстуры."""
    getattr(backend("schemas.versions"), name).model_validate(item)
    return item


def changed(item_id: str, category: str, name: str, status: str = "changed") -> dict[str, Any]:
    return {"item_id": item_id, "category": category, "name": name, "status": status}


def item(
    item_id: str, category: str, name: str, status: str = "changed", summary: str = "", path: str = ""
) -> dict[str, Any]:
    return {
        "item_id": item_id, "category": category, "node_path": path, "name": name,
        "status": status, "summary": summary,
    }


def version(
    number: int,
    comment: str,
    *,
    kind: str = "manual",
    restored_from: int | None = None,
    author: str | None = "arch",
    changes: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return check("VersionOut", {
        "number": number, "comment": comment, "kind": kind, "restored_from": restored_from,
        "created_at": WHEN, "author": author,
        "stats": {
            "nodes": 1, "edges": 2, "docs": 3, "tables": 0, "channels": 0, "params": 4,
            "processes": 1, "changed": changes or [],
        },
    })


def view(
    *, text: str | None = None, lines: list[dict[str, str]] | None = None,
    columns: list[str] | None = None, rows: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {"text": text, "lines": lines, "columns": columns, "rows": rows}


def ref(number: int | None, comment: str | None) -> dict[str, Any]:
    return {"number": number, "comment": comment, "created_at": WHEN if number else None}


def paths(api: FakeApi) -> list[str]:
    """Пути запросов инструмента — без ленивого входа логином (его нет в режиме токена)."""
    found = [c.url.path.replace("/api/v1", "", 1) for c in api.calls]
    return [p for p in found if p != "/auth/login"]


@pytest.fixture
def service(api: FakeApi) -> FakeApi:
    """Объект версий — сервис заказов; имя для заголовков — из /nodes/{id}."""
    api.get(f"/nodes/{NODE}", node(NODE, "Сервис заказов"))
    return api


# ── archmap_versions ────────────────────────────────────────────────────────────

async def test_список_версий_объекта(client: ArchMapClient, service: FakeApi) -> None:
    service.get(f"/nodes/{NODE}/versions", check("VersionList", {
        "versions": [
            version(5, "Откат к v1", kind="restore", restored_from=1, author=None),
            version(4, "Перед откатом к v1", kind="pre_restore"),
            version(3, "orders 2.3 · ORD-412", changes=[
                changed(f"process:{PROCESS}", "process", "Оформление заказа"),
                changed(f"doc:{DOC}", "doc", "Создать заказ", "added"),
                changed(f"spec:{NODE}", "spec", "OpenAPI"),
                changed(f"config:{NODE}", "config", "4 параметра"),
                changed("edge:e1", "edges", "Сервис заказов → База заказов", "removed"),
                changed(f"props:{NODE}", "props", "Сервис заказов"),
                changed(f"approval:{NODE}", "approval", "Сервис заказов"),
            ]),
            version(1, "orders 2.2"),
        ],
        "pending": {"changed": True, "items": [
            item(f"doc:{DOC}", "doc", "Создать заказ", summary="+3 −2"),
            item("table:t1", "db", "public.orders", "added"),
        ]},
    }))

    out = await tools.call("archmap_versions", {"project": "Ярмарка", "node_id": NODE}, client)

    assert paths(service)[-2:] == [f"/nodes/{NODE}", f"/nodes/{NODE}/versions"]
    lines = out.splitlines()
    assert lines[0] == "Версии «Сервис заказов» (проект «Ярмарка»)"
    assert lines[1] == "Есть изменения с v5: схема логики «Создать заказ», таблица «public.orders» (новое)"
    assert "• v5 · Откат к v1 · 2026-10-22 10:15 UTC · автор удалён" in lines
    assert "• v4 · Перед откатом к v1 · 2026-10-22 10:15 UTC · arch" in lines
    assert "• v3 · orders 2.3 · ORD-412 · 2026-10-22 10:15 UTC · arch" in lines
    # До пяти элементов категорией и именем, дальше — счётчик; у спеки имя не повторяется.
    assert (
        "    изменено: процесс «Оформление заказа», схема логики «Создать заказ» (новое), "
        "OpenAPI, конфигурация «4 параметра», связь «Сервис заказов → База заказов» (удалено) "
        "и ещё 2"
    ) in lines
    # Новые сверху — как прислал сервер.
    assert [ln[:4] for ln in lines if ln.startswith("• ")] == ["• v5", "• v4", "• v3", "• v1"]


async def test_список_версий_всего_проекта(client: ArchMapClient, api: FakeApi) -> None:
    api.get("/versions", check("VersionList", {
        "versions": [version(1, "релиз 1.0")],
        "pending": {"changed": False, "items": []},
    }))

    out = await tools.call("archmap_versions", {"project": "Ярмарка"}, client)

    # Корень — ручки без объекта, и /nodes ради имени не дёргается.
    assert paths(api) == ["/projects", "/versions"]
    assert out.splitlines()[:2] == ["Версии всего проекта «Ярмарка»", "Изменений с v1 нет."]


async def test_версий_ещё_нет(client: ArchMapClient, service: FakeApi) -> None:
    service.get(f"/nodes/{NODE}/versions", check("VersionList", {
        "versions": [], "pending": {"changed": True, "items": []},
    }))

    out = await tools.call("archmap_versions", {"project": "Ярмарка", "node_id": NODE}, client)

    assert out == "Версии «Сервис заказов» (проект «Ярмарка»)\nВерсий ещё нет."


# ── archmap_version_diff: список элементов ──────────────────────────────────────

async def test_дельта_по_умолчанию_последней_версии_с_предыдущей(
    client: ArchMapClient, service: FakeApi
) -> None:
    # Номера с пропуском (v2 удалена): последняя — наибольшая из списка, а не «число версий».
    service.get(f"/nodes/{NODE}/versions", check("VersionList", {
        "versions": [version(3, "orders 2.3 · ORD-412"), version(1, "orders 2.2")],
        "pending": {"changed": False, "items": []},
    }))
    service.get(f"/nodes/{NODE}/versions/3/diff", check("VersionDiff", {
        "base": ref(1, "orders 2.2"),
        "target": ref(3, "orders 2.3 · ORD-412"),
        "items": [
            item(f"doc:{DOC}", "doc", "Создать заказ", summary="+3 −2", path="Заказы / Сервис заказов"),
            item(f"spec:{NODE}", "spec", "OpenAPI", "added", path="Заказы / Сервис заказов"),
            item(f"process:{PROCESS}", "process", "Оформление заказа", summary="+2 ~1 шага"),
        ],
    }))

    out = await tools.call("archmap_version_diff", {"project": "Ярмарка", "node_id": NODE}, client)

    assert paths(service)[-1] == f"/nodes/{NODE}/versions/3/diff"
    assert service.calls[-1].url.params["base"] == "prev"
    lines = out.splitlines()
    assert lines[0] == "«Сервис заказов» — v1 (orders 2.2) → v3 (orders 2.3 · ORD-412)"
    assert (
        f"• Схема логики «Создать заказ» (Заказы / Сервис заказов): изменено, +3 −2  item=doc:{DOC}"
    ) in lines
    assert f"• OpenAPI (Заказы / Сервис заказов): новое  item=spec:{NODE}" in lines
    assert f"• Процесс «Оформление заказа»: изменено, +2 ~1 шага  item=process:{PROCESS}" in lines
    assert "archmap_version_diff с item" in out


async def test_дельта_корня_с_текущим_состоянием(client: ArchMapClient, api: FakeApi) -> None:
    api.get("/versions/1/diff", check("VersionDiff", {
        "base": ref(1, "релиз 1.0"), "target": ref(None, None), "items": [],
    }))

    out = await tools.call(
        "archmap_version_diff", {"project": "Ярмарка", "version": 1, "base": "live"}, client
    )

    assert paths(api) == ["/projects", "/versions/1/diff"]
    assert api.calls[-1].url.params["base"] == "live"
    assert out == "Проект «Ярмарка» — v1 (релиз 1.0) → текущее состояние\nИзменений нет."


async def test_дельта_первой_версии_с_начала_и_база_номером(
    client: ArchMapClient, service: FakeApi
) -> None:
    service.get(f"/nodes/{NODE}/versions/2/diff", check("VersionDiff", {
        "base": None, "target": ref(2, None),
        "items": [item(f"props:{NODE}", "props", "Сервис заказов", "added", "объект")],
    }))

    out = await tools.call(
        "archmap_version_diff", {"project": "Ярмарка", "node_id": NODE, "version": 2, "base": 1}, client
    )

    # Номер базы уходит строкой — ручка принимает prev | live | число.
    assert service.calls[-1].url.params["base"] == "1"
    assert out.splitlines()[0] == "«Сервис заказов» — с начала → v2"
    assert f"• Свойства «Сервис заказов»: новое, объект  item=props:{NODE}" in out


async def test_дельта_без_версий_сравнивать_нечего(client: ArchMapClient, service: FakeApi) -> None:
    service.get(f"/nodes/{NODE}/versions", check("VersionList", {
        "versions": [], "pending": {"changed": True, "items": []},
    }))

    out = await tools.call("archmap_version_diff", {"project": "Ярмарка", "node_id": NODE}, client)

    assert out == "«Сервис заказов»: версий ещё нет — сравнивать нечего."
    assert not [p for p in paths(service) if "/diff" in p]


async def test_дельта_режет_список_по_категориям(client: ArchMapClient, api: FakeApi) -> None:
    # У первой версии корня всё «новое»: свойства сотни объектов не должны вытеснить
    # процесс, о котором агент и спрашивает.
    props = [item(f"props:n{i:03d}", "props", f"Объект {i}", "added", "объект") for i in range(45)]
    api.get("/versions/1/diff", check("VersionDiff", {
        "base": None, "target": ref(1, "старт"),
        "items": [*props, item(f"process:{PROCESS}", "process", "Оформление заказа", "added")],
    }))

    out = await tools.call("archmap_version_diff", {"project": "Ярмарка", "version": 1}, client)

    assert "… и ещё 5 элементов" in out
    assert f"• Процесс «Оформление заказа»: новое  item=process:{PROCESS}" in out


# ── archmap_version_diff: один элемент ──────────────────────────────────────────

PROCESS_DETAIL = {
    "item": item(f"process:{PROCESS}", "process", "Оформление заказа", summary="+1 ~1 ↕1 шага"),
    "changes": view(
        columns=["№", "Кто → кому", "Подпись"],
        rows=[
            {"mark": "", "cells": ["3", "Покупатель → Сервис заказов", "оформить заказ"]},
            {
                "mark": "mod",
                "cells": ["4", "Сервис заказов → База заказов", "проверить остаток → зарезервировать остаток"],
                "changed": [{"index": 2, "was": "проверить остаток", "now": "зарезервировать остаток"}],
            },
            {"mark": "move", "cells": ["5 → 6", "Сервис заказов → Покупатель", "заказ принят"]},
            {"mark": "add", "cells": ["5", "Сервис заказов → Kafka заказов", "заказ создан"]},
            {"mark": "del", "cells": ["7", "Сервис заказов → Почта", "письмо"]},
        ],
    ),
    "before": view(
        columns=["№", "Кто → кому", "Подпись"],
        rows=[{"mark": "", "cells": ["4", "Сервис заказов → База заказов", "проверить остаток"]}],
    ),
    "after": view(
        columns=["№", "Кто → кому", "Подпись"],
        rows=[{"mark": "", "cells": ["4", "Сервис заказов → База заказов", "зарезервировать остаток"]}],
    ),
}


async def test_дельта_процесса_таблицей(client: ArchMapClient, service: FakeApi) -> None:
    service.get(
        f"/nodes/{NODE}/versions/3/diff/process:{PROCESS}",
        check("VersionItemDetail", PROCESS_DETAIL),
    )

    out = await tools.call(
        "archmap_version_diff",
        {"project": "Ярмарка", "node_id": NODE, "version": 3, "item": f"process:{PROCESS}"},
        client,
    )

    assert paths(service)[-1] == f"/nodes/{NODE}/versions/3/diff/process:{PROCESS}"
    assert service.calls[-1].url.params["base"] == "prev"
    lines = out.splitlines()
    assert lines[:4] == [
        "«Сервис заказов» — v3 против предыдущей версии",
        f"Процесс «Оформление заказа»: изменено, +1 ~1 ↕1 шага  item=process:{PROCESS}",
        "",
        "ИЗМЕНЕНИЯ:",
    ]
    assert lines[4:] == [
        "  № | Кто → кому | Подпись",
        "  3 | Покупатель → Сервис заказов | оформить заказ",
        "~ 4 | Сервис заказов → База заказов | проверить остаток → зарезервировать остаток",
        "↕ 5 → 6 | Сервис заказов → Покупатель | заказ принят",
        "+ 5 | Сервис заказов → Kafka заказов | заказ создан",
        "− 7 | Сервис заказов → Почта | письмо",
    ]
    # «Было» и «стало» — только по просьбе: в обычной дельте их нет.
    assert "БЫЛО:" not in out and "СТАЛО:" not in out


async def test_дельта_схемы_построчно_с_было_и_стало(client: ArchMapClient, api: FakeApi) -> None:
    api.get(f"/versions/2/diff/doc:{DOC}", check("VersionItemDetail", {
        "item": item(f"doc:{DOC}", "doc", "Создать заказ", "added", "+2", "Заказы / Сервис заказов"),
        "changes": view(lines=[
            {"mark": "mod", "text": "@@ -0,0 +1,2 @@"},
            {"mark": "add", "text": "flowchart TD"},
            {"mark": "add", "text": "  A --> B"},
            {"mark": "", "text": "  B --> C"},
            {"mark": "del", "text": "  C --> D"},
        ]),
        "before": view(),
        "after": view(text="flowchart TD\n  A --> B"),
    }))

    out = await tools.call(
        "archmap_version_diff",
        {"project": "Ярмарка", "version": 2, "base": "live", "item": f"doc:{DOC}", "with_sides": True},
        client,
    )

    assert api.calls[-1].url.params["base"] == "live"
    assert out.splitlines() == [
        "Проект «Ярмарка» — v2 → текущее состояние",
        f"Схема логики «Создать заказ» (Заказы / Сервис заказов): новое, +2  item=doc:{DOC}",
        "",
        "ИЗМЕНЕНИЯ:",
        "@@ -0,0 +1,2 @@",
        "+flowchart TD",
        "+  A --> B",
        "   B --> C",
        "-  C --> D",
        "",
        "БЫЛО:",
        "(нет)",
        "",
        "СТАЛО:",
        "flowchart TD",
        "  A --> B",
    ]


async def test_дельта_одного_элемента_против_номера(client: ArchMapClient, service: FakeApi) -> None:
    service.get(f"/nodes/{NODE}/versions/3/diff/process:{PROCESS}", check("VersionItemDetail", PROCESS_DETAIL))

    out = await tools.call(
        "archmap_version_diff",
        {"project": "Ярмарка", "node_id": NODE, "version": 3, "base": "1", "item": f"process:{PROCESS}"},
        client,
    )

    assert out.splitlines()[0] == "«Сервис заказов» — v1 → v3"


# ── archmap_version_doc ─────────────────────────────────────────────────────────

async def test_схема_логики_на_версии(client: ArchMapClient, api: FakeApi) -> None:
    api.get(f"/nodes/{NODE}/versions/2/doc/{DOC}", check("VersionText", {
        "name": "Создать заказ", "text": "flowchart TD\n  A --> B\n",
    }))

    out = await tools.call(
        "archmap_version_doc", {"project": "Ярмарка", "node_id": NODE, "version": 2, "doc_id": DOC}, client
    )

    assert paths(api) == ["/projects", f"/nodes/{NODE}/versions/2/doc/{DOC}"]
    assert out == "Схема логики «Создать заказ» (v2)\n```mermaid\nflowchart TD\n  A --> B\n```"


async def test_спека_и_процесс_на_версии_корня(client: ArchMapClient, api: FakeApi) -> None:
    api.get(f"/versions/4/spec/{NODE}", check("VersionText", {
        "name": "Сервис заказов", "text": "openapi: 3.0.0",
    }))
    api.get(f"/versions/4/process/{PROCESS}", check("VersionText", {
        "name": "Оформление заказа", "text": "sequenceDiagram\n  A->>B: оформить",
    }))

    spec = await tools.call("archmap_version_doc", {"project": "Ярмарка", "version": 4, "spec_node_id": NODE}, client)
    proc = await tools.call("archmap_version_doc", {"project": "Ярмарка", "version": 4, "process_id": PROCESS}, client)

    assert spec == "OpenAPI-спека «Сервис заказов» (v4)\n```yaml\nopenapi: 3.0.0\n```"
    assert proc.startswith("Процесс «Оформление заказа» (v4)\n```mermaid\nsequenceDiagram")


@pytest.mark.parametrize(
    "ids",
    [{}, {"doc_id": DOC, "process_id": PROCESS}, {"doc_id": DOC, "spec_node_id": NODE, "process_id": PROCESS}],
)
async def test_текст_на_версии_ровно_один_адрес(
    client: ArchMapClient, api: FakeApi, ids: dict[str, str]
) -> None:
    with pytest.raises(ArchMapError, match="Нужен ровно один из doc_id, spec_node_id, process_id"):
        await tools.call("archmap_version_doc", {"project": "Ярмарка", "version": 2, **ids}, client)
    # Отказ — до любого запроса, и проект тоже не резолвится.
    assert api.calls == []


# ── archmap_version_create ──────────────────────────────────────────────────────

async def test_фиксация_версии_объекта(client: ArchMapClient, api: FakeApi) -> None:
    api.post(f"/nodes/{NODE}/versions", version(4, "orders 2.3", changes=[
        changed(f"doc:{DOC}", "doc", "Создать заказ"),
        changed(f"process:{PROCESS}", "process", "Оформление заказа", "added"),
    ]))

    out = await tools.call(
        "archmap_version_create", {"project": "Ярмарка", "node_id": NODE, "comment": "orders 2.3"}, client
    )

    request = api.calls[-1]
    assert (request.method, paths(api)[-1]) == ("POST", f"/nodes/{NODE}/versions")
    body = json.loads(request.content)
    assert body == {"comment": "orders 2.3"}
    backend("schemas.versions").VersionCreate.model_validate(body)
    assert out == (
        "v4 зафиксирована: orders 2.3; изменено: схема логики «Создать заказ», "
        "процесс «Оформление заказа» (новое)"
    )


async def test_фиксация_версии_проекта_без_изменений(client: ArchMapClient, api: FakeApi) -> None:
    api.post("/versions", version(2, "релиз 1.1"))

    out = await tools.call("archmap_version_create", {"project": "Ярмарка", "comment": "релиз 1.1"}, client)

    assert paths(api)[-1] == "/versions"
    assert out == "v2 зафиксирована: релиз 1.1; относительно предыдущей версии ничего не изменилось"


@pytest.mark.parametrize(
    ("status", "detail", "needle"),
    [
        (422, "Комментарий версии обязателен", "ArchMap отклонил данные: Комментарий версии обязателен"),
        (409, "Предел демо: не больше 30 версий", "Предел демо: не больше 30 версий"),
    ],
)
async def test_фиксация_отказы_сервера_текстом(
    client: ArchMapClient, api: FakeApi, status: int, detail: str, needle: str
) -> None:
    # Своих отказов инструмент не выдумывает: причину называет сервер, перевод — общий
    # у всех пишущих инструментов (client.py).
    api.post(f"/nodes/{NODE}/versions", httpx.Response(status, json={"detail": detail}))

    with pytest.raises(ArchMapError, match=needle):
        await tools.call("archmap_version_create", {"project": "Ярмарка", "node_id": NODE, "comment": " "}, client)


# ── Удалённый набор ────────────────────────────────────────────────────────────

def test_версии_в_удалённом_наборе_фиксация_не_для_чтения() -> None:
    reader = {t["name"] for t in tools.remote_catalog(read_only=True)}
    full = {t["name"] for t in tools.remote_catalog(read_only=False)}
    reads = {"archmap_versions", "archmap_version_diff", "archmap_version_doc"}
    assert reads <= reader and "archmap_version_create" in full - reader
    # Ни отката, ни удаления версий в каталоге нет.
    assert not [n for n in full if "restore" in n or "delete" in n]


async def test_фиксация_удалённо_токеном_только_чтение_отказ(api: FakeApi) -> None:
    async with connect(api, caller(read_only=True)) as s:
        result = await s.call_tool(
            "archmap_version_create", {"project": "Ярмарка", "node_id": NODE, "comment": "orders 2.3"}
        )
    assert result.isError is True
    assert text(result).startswith("Токен только для чтения: archmap_version_create")
    assert api.calls == []


async def test_версии_удалённо_читаются_токеном_только_чтение(api: FakeApi) -> None:
    api.get("/versions", check("VersionList", {
        "versions": [version(1, "релиз 1.0")], "pending": {"changed": False, "items": []},
    }))
    async with connect(api, caller(read_only=True)) as s:
        result = await s.call_tool("archmap_versions", {"project": "Ярмарка"})
    assert result.isError is False
    assert text(result).startswith("Версии всего проекта «Ярмарка»")
