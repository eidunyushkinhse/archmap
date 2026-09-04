"""Разведка точек входа: форма тела, параметры промпта, сводка отчёта.

Тела и фикстуры сверяются со схемами САМОГО БЭКЕНДА: подменённый транспорт форму
не валидирует, и без этого судьи тест зелёный там, где живой сервер отвечает 422
(история /projects/import/preview).
"""

from __future__ import annotations

import json
from typing import get_args

from conftest import FakeApi, backend

from archmap_mcp import render, tools
from archmap_mcp.client import ArchMapClient

# ⚠ node_id у контракта — UUID, а не свободная строка: подсунутое «n2» бэкенд
# отклонит 422 (поймано схемой ReconImportIn прямо здесь).
NODE_ID = "33333333-3333-3333-3333-333333333333"

FILES = [{"name": "archmap-recon.yaml", "content": "# archmap-recon\nnode: Ярмарка\n"}]


def check_in(body: dict[str, object]) -> None:
    """Тело глазами бэкенда: ReconImportIn — то, что разберёт живая ручка."""
    backend("schemas.recon").ReconImportIn.model_validate(body)


def report(**over: object) -> dict[str, object]:
    """Фикстура отчёта через ReconImportReport: поля и значения action — те, что
    реально приезжают, а не те, что кажутся автору теста."""
    data: dict[str, object] = {
        "node_path": "Ярмарка / backend",
        "items": [
            {"name": "POST /orders", "kind": "operation", "operation": "POST /orders",
             "action": "create"},
            {"name": "email_senders", "kind": "worker", "operation": None, "action": "create"},
            {"name": "GET /orders", "kind": "operation", "operation": "GET /orders",
             "action": "unchanged"},
            {"name": "POST /messages", "kind": "operation", "operation": "POST /messages",
             "action": "described", "doc_name": "Отправка сообщения"},
            {"name": "legacy_worker", "kind": "worker", "operation": None, "action": "vanished"},
        ],
        "errors": [],
        "warnings": ["в перечне нет строки node — адресуем объекту окна"],
        "applied": False,
        "created": 0,
    }
    data.update(over)
    return backend("schemas.recon").ReconImportReport.model_validate(data).model_dump(mode="json")


# ── Промпт ───────────────────────────────────────────────────────────────────

async def test_промпт_разведки_шлёт_адрес_объекта(
    client: ArchMapClient, api: FakeApi
) -> None:
    # node_id ОБЯЗАТЕЛЕН у ручки: без него 422, и потерять его в params — значит
    # получить отказ на живом сервере при зелёных тестах.
    api.get("/recon/prompt", {"prompt": "обойди репозиторий"})

    out = await tools.call(
        "archmap_recon_prompt", {"project": "Ярмарка", "node_id": NODE_ID}, client
    )

    assert api.calls[-1].url.query == f"node_id={NODE_ID}".encode()  # прежний вызов — без variant
    assert out == "обойди репозиторий"


async def test_промпт_разведки_проносит_вариант(client: ArchMapClient, api: FakeApi) -> None:
    api.get("/recon/prompt", {"prompt": "оркестратор"})

    await tools.call(
        "archmap_recon_prompt",
        {"project": "Ярмарка", "node_id": NODE_ID, "variant": "orchestrated"},
        client,
    )

    params = api.calls[-1].url.params
    assert params["node_id"] == NODE_ID and params["variant"] == "orchestrated"


# ── Превью и применение ──────────────────────────────────────────────────────

async def test_превью_разведки_шлёт_файлы_записями(
    client: ArchMapClient, api: FakeApi
) -> None:
    # ⚠ У разведки форма ДРУГАЯ, чем у импорта: ReconImportIn.files — записи
    # {name, content} (имя файла нужно для префиксов ошибок), а не список текстов.
    api.post("/recon/preview", report())

    await tools.call(
        "archmap_recon_preview",
        {"project": "Ярмарка", "files": FILES, "node_id": NODE_ID},
        client,
    )

    body = json.loads(api.calls[-1].content)
    assert body["files"] == FILES
    assert body["node_id"] == NODE_ID
    assert "overwrite" not in body  # поля нет в контракте вовсе (Р13 плана разведки)
    check_in(body)


async def test_превью_разведки_не_пишет_и_говорит_об_этом(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.post("/recon/preview", report())

    out = await tools.call(
        "archmap_recon_preview", {"project": "Ярмарка", "files": FILES}, client
    )

    assert "Объект: Ярмарка / backend" in out
    assert "Создадим заглушки (2)" in out
    assert "• POST /orders (операция)" in out
    assert "• email_senders (воркер)" in out
    assert "Уже описаны — не тронем (1)" in out
    assert "→ Отправка сообщения" in out  # что именно закрыло операцию
    assert "Есть в документации, но не найдено в коде (1)" in out
    assert "Предупреждения (1)" in out
    assert "archmap_recon_apply" in out
    # Записи не было: применения среди вызовов нет.
    assert all(c.url.path != "/api/v1/recon/apply" for c in api.calls)


async def test_применение_разведки_печатает_созданное(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.post("/recon/apply", report(applied=True, created=2))

    out = await tools.call(
        "archmap_recon_apply", {"project": "Ярмарка", "files": FILES}, client
    )

    assert "Создано заглушек: 2" in out
    assert "Ничего не записано" not in out
    body = json.loads(api.calls[-1].content)
    check_in(body)


async def test_ошибки_разведки_видны_отдельно_от_предупреждений(
    client: ArchMapClient, api: FakeApi
) -> None:
    # При errors бэкенд не пишет ничего вовсе — агент обязан отличать это от
    # предупреждений, которые записи не мешают.
    api.post("/recon/preview", report(errors=["archmap-recon.yaml: нет корня archmap-recon"]))

    out = await tools.call(
        "archmap_recon_preview", {"project": "Ярмарка", "files": FILES}, client
    )

    assert "Проблемы (1)" in out
    assert "нет корня archmap-recon" in out


async def test_действия_разведки_те_же_что_у_бэкенда() -> None:
    # Сводка обещает четыре группы — они должны быть ровно те, что отдаёт ручка:
    # незнакомое значение action молча выпало бы из вывода, и агент не увидел бы
    # часть перечня.
    assert {a for a, _t, _n, _s in render.RECON_GROUPS} == set(
        get_args(backend("schemas.recon").ReconAction)
    )


async def test_перечень_режется_с_честным_хвостом() -> None:
    # Молча обрезать — значит соврать о полноте: у монолита сотни точек входа.
    many = {
        "node_path": "Ярмарка",
        "items": [
            {"name": f"GET /p{i}", "kind": "operation", "operation": f"GET /p{i}",
             "action": "create"}
            for i in range(render.RECON_GROUP_CAP + 5)
        ],
    }
    out = render.recon_report(many, applied=False)

    assert f"Создадим заглушки ({render.RECON_GROUP_CAP + 5})" in out
    assert "… и ещё 5 строк" in out


async def test_разведка_требует_адрес_у_промпта() -> None:
    # Схема инструмента обязана требовать node_id: иначе агент узнает о нём из 422.
    schema = tools.BY_NAME["archmap_recon_prompt"]["schema"]
    assert "node_id" in schema["required"]
