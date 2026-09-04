"""Процессы в MCP: сводка обязана говорить теми полями, что бэкенд правда отдаёт.

Прежняя версия печатала «участников ?» и «? → ?»: в ProcessListItem нет
participant_count, а концы шага — УЧАСТНИКИ (from_participant_id), не узлы.
Тот же класс дефекта чинили в Ф2 у карточки, и ловится он одинаково: фикстуры
собираются САМИМИ схемами бэкенда, поэтому выдуманное поле роняет тест, а не
зеленеет до первого живого вызова.
"""

from __future__ import annotations

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
