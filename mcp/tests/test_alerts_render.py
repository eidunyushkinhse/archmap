"""Сводка алертов: те же классы, тот же порядок и те же слова, что в панели.

Почему отдельный файл: у класса замечаний два независимых источника правды —
контракт бэкенда (какие списки вообще бывают) и панель SchemaAlerts.tsx (как они
называются и в каком порядке идут). Тест сверяется с ОБОИМИ, иначе рендер тихо
разъедется с интерфейсом, и агент с человеком станут называть одну проблему
разными словами.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from conftest import FakeApi, backend

from archmap_mcp import render, tools
from archmap_mcp.client import ArchMapClient

PANEL = Path(__file__).resolve().parents[2] / "frontend/src/components/SchemaAlerts.tsx"


def panel_titles() -> list[str]:
    """Заголовки секций панели В ПОРЯДКЕ JSX — сентинел против расхождения.

    Панель переименовали или переставили — падает этот тест, а не доверие
    пользователя к сводке агента."""
    return re.findall(r"<Section[^>]*title=\"([^\"]+)\"", PANEL.read_text(encoding="utf-8"))


def u(n: int) -> str:
    return f"{n:08d}-0000-0000-0000-000000000000"


def full_payload() -> dict[str, Any]:
    """По одной записи каждого из 15 классов."""
    return {
        "disconnected_nodes": [{"node_id": u(1), "node_name": "Сирота"}],
        "intermediate_edges": [
            {
                "edge_id": u(2), "label": "заказ",
                "source_id": u(3), "source_name": "Покупатель",
                "target_id": u(4), "target_name": "Маркетплейс",
                "source_is_intermediate": False, "target_is_intermediate": True,
            }
        ],
        "descendant_edges": [
            {
                "edge_id": u(5), "label": None,
                "source_id": u(4), "source_name": "Маркетплейс",
                "target_id": u(6), "target_name": "Сервис заказов",
                "source_is_part": False,
            }
        ],
        "isolated_groups": [
            {"node_ids": [u(7), u(8)], "node_names": ["Почта", "Шлюз"]},
            {"node_ids": [u(9)], "node_names": ["Биллинг"]},
        ],
        "container_own_docs": [
            {"node_id": u(4), "node_name": "Маркетплейс", "has_docs": True, "has_spec": False}
        ],
        "persons_inside": [
            {"node_id": u(3), "node_name": "Покупатель", "parent_id": u(4), "parent_name": "Маркетплейс"}
        ],
        "dangling_messages": [
            {
                "process_id": u(10), "process_name": "Оформление заказа", "message_id": u(11),
                "caption": "создать заказ", "from_name": "Покупатель", "to_name": "Сервис заказов",
            }
        ],
        "unbound_participants": [
            {
                "process_id": u(10), "process_name": "Оформление заказа",
                "participant_id": u(12), "name": "Склад",
            }
        ],
        "orphan_legs": [
            {
                "process_id": u(10), "process_name": "Оформление заказа", "message_id": u(13),
                "caption": None, "edge_label": "orders.created",
                "from_name": "Сервис заказов", "to_name": "Kafka",
            }
        ],
        "unresolved_data_refs": [
            {
                "node_id": u(6), "node_name": "Сервис заказов", "doc_id": u(14),
                "doc_name": "POST /orders", "ref": "orders.stat", "mode": "write",
                "reason": "unknown_column",
            }
        ],
        "unresolved_channel_refs": [
            {
                "node_id": u(6), "node_name": "Сервис заказов", "doc_id": u(14),
                "doc_name": "POST /orders", "ref": "order.created", "mode": "publish",
                "reason": "ambiguous",
            }
        ],
        "unresolved_config_refs": [
            {
                "node_id": u(6), "node_name": "Сервис заказов", "doc_id": u(14),
                "doc_name": "POST /orders", "ref": "TIMEOUT",
            }
        ],
        "broker_edge_channels": [
            {
                "edge_id": u(15), "source_name": "Сервис заказов", "target_name": "Kafka",
                "broker_name": "Kafka", "channel": None, "reason": "missing",
            }
        ],
        "unlinked_messages": [
            {
                "process_id": u(10), "process_name": "Оформление заказа", "message_id": u(16),
                "caption": "ответ", "from_name": "Сервис заказов", "to_name": "Покупатель",
            }
        ],
        "undescribed_docs": [{"node_id": u(6), "node_name": "Сервис заказов", "count": 3}],
    }


def validated_payload() -> dict[str, Any]:
    """Фикстура глазами БЭКЕНДА: подменённый транспорт форму ответа не проверяет,
    поэтому судьёй берём саму AlertsResponse — иначе тест зелёный на выдуманных
    полях, а живой сервер отдаёт другие."""
    payload = full_payload()
    backend("schemas.node").AlertsResponse.model_validate(payload)
    return payload


def test_фикстура_покрывает_все_классы_контракта() -> None:
    fields = set(backend("schemas.node").AlertsResponse.model_fields)
    assert set(full_payload()) == fields
    assert len(fields) == 15


def test_порядок_и_заголовки_повторяют_панель() -> None:
    titles = panel_titles()
    assert len(titles) == 15, titles

    out = render.alerts(validated_payload())
    positions = []
    for title in titles:
        assert f"{title} (" in out, f"нет секции «{title}»"
        positions.append(out.index(f"{title} ("))
    assert positions == sorted(positions), "порядок секций разошёлся с панелью"


def test_причины_пишутся_словами_а_не_кодами() -> None:
    out = render.alerts(validated_payload())
    assert "„orders.stat“ — колонки нет в таблице" in out
    assert "„order.created“ — имя неоднозначно — укажите „Брокер / канал“" in out
    assert "„TIMEOUT“ — параметра нет в конфигурации объекта" in out
    assert "unknown_column" not in out and "ambiguous" not in out
    # Связь с брокером: обе причины — разные фразы починки.
    assert "Сервис заказов → Kafka: канал не указан" in out


def test_строки_называют_имена_и_детали() -> None:
    out = render.alerts(validated_payload())
    assert "Покупатель → «Маркетплейс»" in out  # проблемный конец выделен
    assert "«Сервис заказов» — часть «Маркетплейс»" in out
    assert "Группа 1: Почта, Шлюз" in out and "Группа 2: Биллинг" in out
    assert "Оформление заказа: «создать заказ» (Покупатель → Сервис заказов)" in out
    assert "Оформление заказа: без подписи (Сервис заказов → Kafka · канал «orders.created»)" in out
    assert "Оформление заказа: Склад" in out
    assert "Сервис заказов — 3 схемы" in out
    assert "Покупатель внутри Маркетплейс" in out


def test_счётчик_считает_группы_как_недостающие_связи() -> None:
    # 14 классов по записи + 2 изолированные группы, дающие 1 недостающую связь.
    assert render.alerts(validated_payload()).startswith("Замечаний: 15\n")


def test_пустой_ответ_говорит_что_схема_завершена() -> None:
    assert render.alerts({k: [] for k in full_payload()}) == "Замечаний нет — схема завершена."


def test_ответ_старого_сервера_без_новых_списков_переживается() -> None:
    # Сервер старше клиента не отдаёт новых классов вовсе — рендер обязан не
    # упасть на отсутствующем ключе (ровно ради этого у полей бэка дефолт []).
    out = render.alerts({"disconnected_nodes": [{"node_id": u(1), "node_name": "Сирота"}]})
    assert "Объекты без связей (1)" in out and "Сирота" in out
    assert render.alerts({}) == "Замечаний нет — схема завершена."


async def test_инструмент_алертов_отдаёт_полную_сводку(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.get("/nodes/alerts", validated_payload())

    out = await tools.call("archmap_alerts", {"project": "Ярмарка"}, client)

    assert "Проект «Ярмарка» — незавершённость схемы" in out
    for title in panel_titles():
        assert title in out


def test_описание_инструмента_обещает_все_классы() -> None:
    tool = next(t for t in tools.TOOLS if t["name"] == "archmap_alerts")
    assert "15" in tool["description"]
