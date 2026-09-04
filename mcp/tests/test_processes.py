"""Процессы в MCP: сводка обязана говорить теми полями, что бэкенд правда отдаёт.

Прежняя версия печатала «участников ?» и «? → ?»: в ProcessListItem нет
participant_count, а концы шага — УЧАСТНИКИ (from_participant_id), не узлы.
Тот же класс дефекта чинили в Ф2 у карточки, и ловится он одинаково: фикстуры
собираются САМИМИ схемами бэкенда, поэтому выдуманное поле роняет тест, а не
зеленеет до первого живого вызова.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from conftest import FakeApi, backend

from archmap_mcp import tools
from archmap_mcp.client import ArchMapClient, ArchMapError

PROC = "22222222-2222-2222-2222-222222222222"
BUYER = "33333333-3333-3333-3333-333333333331"
ORDERS = "33333333-3333-3333-3333-333333333332"
M1 = "44444444-4444-4444-4444-444444444441"
M2 = "44444444-4444-4444-4444-444444444442"
DOC = "55555555-5555-5555-5555-555555555551"
NODE = "66666666-6666-6666-6666-666666666661"


def dump(model: str, **fields: Any) -> dict[str, Any]:
    """Ответ бэкенда как он есть: модель собирается, валидируется, сериализуется."""
    return getattr(backend("schemas.process"), model)(**fields).model_dump(mode="json")


def item(**over: Any) -> dict[str, Any]:
    fields: dict[str, Any] = {
        "id": PROC, "name": "Оформление заказа", "scope_node_id": None,
        "scope_name": None, "message_count": 4, "statuses": ["existing"],
    }
    fields.update(over)
    return dump("ProcessListItem", **fields)


def participant(**over: Any) -> dict[str, Any]:
    fields: dict[str, Any] = {
        "id": BUYER, "node_id": NODE, "name": "Покупатель", "role": None,
        "shape": "person", "is_external": True, "status": "existing", "order": 0,
    }
    fields.update(over)
    return dump("ParticipantOut", **fields)


def message(**over: Any) -> dict[str, Any]:
    fields: dict[str, Any] = {
        "id": M1, "order": 0, "edge_id": None, "leg": "forward", "kind": "forward",
        "caption": "создать заказ", "technology": "HTTP",
        "from_participant_id": BUYER, "to_participant_id": ORDERS,
        "valid": True, "version": 3,
    }
    fields.update(over)
    return dump("MessageOut", **fields)


def detail(**over: Any) -> dict[str, Any]:
    fields: dict[str, Any] = {
        "id": PROC, "name": "Оформление заказа", "scope_node_id": None,
        "scope_name": None,
        "participants": [
            participant(),
            participant(id=ORDERS, node_id=None, name="Сервис заказов", shape="service",
                        is_external=False, order=1),
        ],
        "messages": [message()],
        "fragments": [],
    }
    fields.update(over)
    return dump("ProcessDetail", **fields)


# ── Список ───────────────────────────────────────────────────────────────────

async def test_список_процессов_называет_область_и_число_шагов(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.get("/processes", [
        item(),
        item(id=M1, name="Возврат", scope_node_id=NODE, scope_name="Ярмарка / Заказы",
             message_count=11),
    ])

    out = await tools.call("archmap_processes", {"project": "Ярмарка"}, client)

    # «Участников N» здесь не бывает вовсе — контракт списка их не считает.
    assert "участников" not in out
    assert "Оформление заказа — область: весь проект, шагов 4" in out
    assert "Возврат — область: Ярмарка / Заказы, шагов 11" in out
    assert f"id={PROC}" in out


# ── Шаги ─────────────────────────────────────────────────────────────────────

async def test_шаг_печатает_имена_концов_привязку_и_версию(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.get(f"/processes/{PROC}", detail(messages=[
        message(doc_id=DOC, doc_node_id=NODE, doc_name="POST /orders",
                doc_node_path="Ярмарка / Заказы"),
        message(id=M2, order=1, leg="return", kind="return", caption="ответ",
                from_participant_id=ORDERS, to_participant_id=BUYER,
                technology=None, version=1),
    ]))

    out = await tools.call(
        "archmap_processes", {"project": "Ярмарка", "process_id": PROC}, client
    )

    assert "0. Покупатель → Сервис заказов: создать заказ" in out
    assert "1. Сервис заказов → Покупатель: ответ" in out
    assert "· ответ" in out  # плечо названо словом, а не кодом kind
    assert "→ схема «POST /orders» (Ярмарка / Заказы)" in out
    assert "— схема не привязана" in out
    # id и version — вход archmap_bind_step: без них пришлось бы перечитывать процесс.
    assert f"id={M1} version=3" in out
    assert f"id={M2} version=1" in out


async def test_сломанный_шаг_назван_словами_интерфейса(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.get(f"/processes/{PROC}", detail(messages=[
        message(valid=False, invalid_reason="edge_deleted"),
        message(id=M2, order=1, valid=False, invalid_reason="leg_gone",
                leg="return", kind="return"),
    ]))

    out = await tools.call(
        "archmap_processes", {"project": "Ярмарка", "process_id": PROC}, client
    )

    assert "⚠ связь удалена" in out
    assert "⚠ канал без ответа" in out


async def test_непривязанный_участник_и_фрагменты_видны(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.get(f"/processes/{PROC}", detail(
        scope_node_id=NODE, scope_name="Ярмарка / Заказы",
        fragments=[dump("FragmentOut", id=DOC, kind="alt", from_order=0, to_order=1,
                        guard="оплата прошла",
                        branches=[{"start_order": 1, "guard": "отказ"}])],
    ))

    out = await tools.call(
        "archmap_processes", {"project": "Ярмарка", "process_id": PROC}, client
    )

    assert "Область: Ярмарка / Заказы" in out
    assert "0. Покупатель — внешний" in out
    assert "1. Сервис заказов — не привязан к объекту" in out
    assert "alt шаги 0–1 «оплата прошла», ветвей ещё 1" in out


async def test_пустой_процесс_не_врёт_прочерками(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.get(f"/processes/{PROC}", detail(participants=[], messages=[]))

    out = await tools.call(
        "archmap_processes", {"project": "Ярмарка", "process_id": PROC}, client
    )

    assert out.count("(нет)") == 2


async def test_процессов_нет_говорится_прямо(client: ArchMapClient, api: FakeApi) -> None:
    api.get("/processes", [])

    assert "процессов нет" in await tools.call(
        "archmap_processes", {"project": "Ярмарка"}, client
    )


async def test_чужой_процесс_отвечает_понятной_ошибкой(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.routes[("GET", f"/processes/{PROC}")] = httpx.Response(
        404, json={"detail": "Процесс не найден"}
    )

    with pytest.raises(ArchMapError) as exc:
        await tools.call(
            "archmap_processes", {"project": "Ярмарка", "process_id": PROC}, client
        )

    assert "не найден" in str(exc.value)


# ── Каталог схем шага ────────────────────────────────────────────────────────

CATALOG_PATH = f"/processes/{PROC}/messages/{M1}/docs"
BIND_PATH = f"/processes/{PROC}/messages/{M1}"


def choice(**over: Any) -> dict[str, Any]:
    fields: dict[str, Any] = {
        "id": DOC, "node_id": NODE, "node_path": "Ярмарка / Заказы",
        "name": "POST /orders", "kind": "operation", "operation": "POST /orders",
        "described": True,
    }
    fields.update(over)
    return dump("DocChoiceOut", **fields)


def catalog(**over: Any) -> dict[str, Any]:
    fields: dict[str, Any] = {"default_node_id": NODE, "docs": [choice()]}
    fields.update(over)
    return dump("MessageDocCatalog", **fields)


async def test_каталог_шага_метит_исполнителя_и_заглушки(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.get(CATALOG_PATH, catalog(docs=[
        choice(),
        choice(id=M2, node_id=BUYER, node_path="Ярмарка / Склад", name="резерв",
               kind="worker", operation=None, described=False),
    ]))

    out = await tools.call(
        "archmap_step_docs",
        {"project": "Ярмарка", "process_id": PROC, "message_id": M1},
        client,
    )

    assert "ПОДХОДЯЩИЕ СХЕМЫ ЛОГИКИ (2)" in out
    assert "POST /orders (операция · POST /orders) — Ярмарка / Заказы [исполнитель]" in out
    assert "резерв (воркер) — Ярмарка / Склад [не описана]" in out
    assert f"id={DOC}" in out


async def test_пустой_каталог_говорит_что_описывать_нечем(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.get(CATALOG_PATH, catalog(default_node_id=None, docs=[]))

    out = await tools.call(
        "archmap_step_docs",
        {"project": "Ярмарка", "process_id": PROC, "message_id": M1},
        client,
    )

    assert "Подходящих схем логики нет" in out
    assert "archmap_docs" in out


async def test_длинный_каталог_обрезан_с_честным_хвостом(
    client: ArchMapClient, api: FakeApi
) -> None:
    many = [
        choice(id=f"55555555-5555-5555-5555-{i:012d}", name=f"схема {i}")
        for i in range(1, 96)
    ]
    api.get(CATALOG_PATH, catalog(docs=many))

    out = await tools.call(
        "archmap_step_docs",
        {"project": "Ярмарка", "process_id": PROC, "message_id": M1},
        client,
    )

    assert "ПОДХОДЯЩИЕ СХЕМЫ ЛОГИКИ (95)" in out
    assert "… и ещё 15 схем" in out


# ── Привязка ─────────────────────────────────────────────────────────────────

def bind_body(api: FakeApi) -> Any:
    """Тело PATCH глазами САМОГО бэкенда: сверяем не словарь, а схему входа."""
    payload = json.loads(api.calls[-1].content)
    return backend("schemas.process").MessageUpdate.model_validate(payload), payload


async def test_привязка_шлёт_только_doc_id_и_версию(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.patch(BIND_PATH, message(doc_id=DOC, doc_node_id=NODE, doc_name="POST /orders",
                                 doc_node_path="Ярмарка / Заказы", version=4))

    out = await tools.call(
        "archmap_bind_step",
        {"project": "Ярмарка", "process_id": PROC, "message_id": M1,
         "doc_id": DOC, "base_version": 3},
        client,
    )

    body, raw = bind_body(api)
    # ⚠️ Лишний ключ здесь не безобиден: бэкенд применяет ПРИШЕДШИЕ поля
    # (exclude_unset), и случайный caption переписал бы подпись шага.
    assert set(raw) == {"doc_id", "base_version"}
    assert str(body.doc_id) == DOC and body.base_version == 3
    assert "→ схема «POST /orders» (Ярмарка / Заказы)" in out
    assert "version=4" in out


async def test_снятие_привязки_передаёт_настоящий_null(
    client: ArchMapClient, api: FakeApi
) -> None:
    """Пропуск ключа бэкенд читает как «не трогать» (exclude_unset), поэтому
    снятие обязано приехать явным null — иначе отвязка молча ничего не делает."""
    api.patch(BIND_PATH, message(version=5))

    out = await tools.call(
        "archmap_bind_step",
        {"project": "Ярмарка", "process_id": PROC, "message_id": M1,
         "doc_id": None, "base_version": 4},
        client,
    )

    body, raw = bind_body(api)
    assert raw["doc_id"] is None
    assert "doc_id" in body.model_fields_set and body.doc_id is None
    assert "— схема не привязана" in out


async def test_пустая_строка_тоже_снимает_привязку(
    client: ArchMapClient, api: FakeApi
) -> None:
    # Клиенты MCP охотно выбрасывают настоящий null из аргументов; без синонима
    # снятие стало бы невыразимым.
    api.patch(BIND_PATH, message(version=5))

    await tools.call(
        "archmap_bind_step",
        {"project": "Ярмарка", "process_id": PROC, "message_id": M1,
         "doc_id": "", "base_version": 4},
        client,
    )

    _, raw = bind_body(api)
    assert raw["doc_id"] is None


async def test_без_doc_id_привязка_не_ходит_на_сервер(
    client: ArchMapClient, api: FakeApi
) -> None:
    with pytest.raises(ArchMapError) as exc:
        await tools.call(
            "archmap_bind_step",
            {"project": "Ярмарка", "process_id": PROC, "message_id": M1,
             "base_version": 3},
            client,
        )

    assert "doc_id" in str(exc.value)
    assert all(c.method != "PATCH" for c in api.calls)


async def test_устаревшая_версия_шага_даёт_конфликт(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.routes[("PATCH", BIND_PATH)] = httpx.Response(
        409, json={"detail": "Шаг изменён в другой сессии"}
    )

    with pytest.raises(ArchMapError) as exc:
        await tools.call(
            "archmap_bind_step",
            {"project": "Ярмарка", "process_id": PROC, "message_id": M1,
             "doc_id": DOC, "base_version": 1},
            client,
        )

    assert "Конфликт версий" in str(exc.value) and "перечитайте" in str(exc.value)
