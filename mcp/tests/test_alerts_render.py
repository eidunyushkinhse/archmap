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
from typing import Any, get_args

from conftest import FakeApi, backend

from archmap_mcp import render, tools
from archmap_mcp.client import ArchMapClient

PANEL = Path(__file__).resolve().parents[2] / "frontend/src/components/SchemaAlerts.tsx"


def panel_titles() -> list[str]:
    """Заголовки секций панели В ПОРЯДКЕ списка ALERT_SECTIONS — сентинел против
    расхождения (раздел панели — запись `section({ title: "…", … })`, аудит F-35).

    Панель переименовали или переставили — падает этот тест, а не доверие
    пользователя к сводке агента."""
    return re.findall(r'section\(\{\s*title: "([^"]+)"', PANEL.read_text(encoding="utf-8"))


def u(n: int) -> str:
    return f"{n:08d}-0000-0000-0000-000000000000"


def full_payload() -> dict[str, Any]:
    """По одной записи каждого из 16 классов."""
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
            {
                "node_id": u(4), "node_name": "Маркетплейс", "element_effective": "system",
                "has_docs": True, "has_spec": False, "has_config": False,
            }
        ],
        "component_facts": [
            {
                "node_id": u(17), "node_name": "orders/api",
                "container_id": u(18), "container_name": "orders",
                "has_spec": True, "has_config": True,
            }
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
                "container_id": u(6), "container_name": "Сервис заказов",
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
    backend("schemas.alerts").AlertsResponse.model_validate(payload)
    return payload


def test_фикстура_покрывает_все_классы_контракта() -> None:
    fields = set(backend("schemas.alerts").AlertsResponse.model_fields)
    assert set(full_payload()) == fields
    assert len(fields) == 16


def test_порядок_и_заголовки_повторяют_панель() -> None:
    titles = panel_titles()
    assert len(titles) == 16, titles

    out = render.alerts(validated_payload())
    positions = []
    for title in titles:
        assert f"{title} (" in out, f"нет секции «{title}»"
        positions.append(out.index(f"{title} ("))
    assert positions == sorted(positions), "порядок секций разошёлся с панелью"


def test_причины_пишутся_словами_а_не_кодами() -> None:
    out = render.alerts(validated_payload())
    assert "„orders.stat“ — колонки нет в таблице" in out
    assert "„order.created“ — имя неоднозначно, укажите „Брокер / канал“" in out
    assert "„TIMEOUT“ — параметра нет в конфигурации объекта" in out
    assert "unknown_column" not in out and "ambiguous" not in out
    # Связь с брокером: обе причины — разные фразы починки.
    assert "Сервис заказов → Kafka: канал не указан" in out


def panel_reasons(const: str) -> dict[str, str]:
    """Словарь причин панели (REF_REASON / CHANNEL_REASON) — ключ → текст."""
    block = re.search(
        rf"const {const}[^=]*= \{{(.*?)\}};", PANEL.read_text(encoding="utf-8"), re.S
    )
    assert block, f"в панели нет {const}"
    return dict(re.findall(r'(\w+): "([^"]+)"', block.group(1)))


def test_тексты_причин_те_же_что_в_панели() -> None:
    # Аудит P-38: тексты причин уже разъехались («— укажите» против «, укажите»),
    # и ни один тест этого не видел. Ключи сверяются с контрактом бэкенда — новая
    # причина без текста печаталась бы агенту кодом.
    schemas = backend("schemas.alerts")
    for mine, const, alert in (
        (render.DATA_REASON, "REF_REASON", schemas.UnresolvedDataRefAlert),
        (render.CHANNEL_REASON, "CHANNEL_REASON", schemas.UnresolvedChannelRefAlert),
    ):
        assert set(mine) == set(get_args(alert.model_fields["reason"].annotation))
        assert mine == panel_reasons(const)
    panel = " ".join(PANEL.read_text(encoding="utf-8").split())
    assert render.CONFIG_REASON in panel
    # Советы AL24 по элементу — словарь панели целиком, ключи — из контракта.
    own = re.search(r"const OWN_DOCS_HINT[^=]*= \{(.*?)\};", panel, re.S)
    assert own, "в панели нет OWN_DOCS_HINT"
    assert dict(re.findall(r'(\w+): "([^"]+)"', own.group(1))) == render.OWN_DOCS_HINT
    assert set(render.OWN_DOCS_HINT) == set(
        get_args(schemas.ContainerOwnDocsAlert.model_fields["element_effective"].annotation)
    )
    head, tail = render.COMPONENT_FACTS_HINT.split("{name}")
    assert f"{head}{{c.container_name}}{tail}" in panel
    assert render.CONFIG_REASON_SYSTEM in panel
    head, tail = render.CONFIG_REASON_CONTAINER.split("{name}")
    assert head in panel and tail in panel


def test_причина_AL33_называет_место_поиска() -> None:
    """Три текста по месту поиска параметра (Р11): сам владелец схемы, его контейнер
    или нигде — владелец система. Сервер до эпика поля контейнера не шлёт: текст
    прежний."""
    base = {
        "node_id": u(7), "node_name": "api", "doc_id": u(14), "doc_name": "POST /orders",
        "ref": "TIMEOUT",
    }
    own = {**base, "container_id": u(7), "container_name": "api"}
    component = {**base, "container_id": u(6), "container_name": "orders"}
    system = {**base, "container_id": None, "container_name": None}
    for record in (own, component, system):
        backend("schemas.alerts").UnresolvedConfigRefAlert.model_validate(record)

    assert render.config_reason(own) == render.CONFIG_REASON
    assert render.config_reason(base) == render.CONFIG_REASON
    assert render.config_reason(system) == render.CONFIG_REASON_SYSTEM
    line = render.alerts({"unresolved_config_refs": [component]})
    assert (
        "api · POST /orders: „TIMEOUT“ — параметра нет в конфигурации контейнера "
        "«orders»: опишите его там или, если это обычная фраза, уберите двоеточие"
    ) in line


def test_совет_AL24_по_элементу_архитектуры() -> None:
    """Система — всё не на месте, контейнер с компонентами — только схемы логики.
    Сервер до эпика элемента не шлёт: строка — одно имя, как раньше."""
    base = {"node_id": u(4), "node_name": "orders", "has_docs": True, "has_spec": False,
            "has_config": False}
    container = {**base, "element_effective": "container"}
    backend("schemas.alerts").ContainerOwnDocsAlert.model_validate(container)
    out = render.alerts({"container_own_docs": [container]})
    assert (
        "  • orders (схемы логики описывают код компонентов — перенесите их компонентам)"
        in out.splitlines()
    )
    out = render.alerts(validated_payload())
    assert (
        "  • Маркетплейс (спецификация, конфигурация и схемы логики описывают её контейнеры — "
        "перенесите их вложенным объектам)"
    ) in out.splitlines()
    assert "  • orders" in render.alerts({"container_own_docs": [base]}).splitlines()


def test_факты_компонента_называют_контейнер() -> None:
    out = render.alerts(validated_payload())
    assert (
        "  • orders/api · конфигурация, спецификация (место — у контейнера «orders»)"
        in out.splitlines()
    )
    one = {
        "node_id": u(17), "node_name": "orders/api", "container_id": u(18),
        "container_name": "orders", "has_spec": True, "has_config": False,
    }
    backend("schemas.alerts").ComponentFactsAlert.model_validate(one)
    out = render.alerts({"component_facts": [one]})
    assert out.startswith("Замечаний: 1\n")
    assert "Конфигурация и спецификации у компонентов (1):" in out
    assert "  • orders/api · спецификация (место — у контейнера «orders»)" in out.splitlines()


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
    # 15 классов по записи + 2 изолированные группы, дающие 1 недостающую связь.
    assert render.alerts(validated_payload()).startswith("Замечаний: 16\n")


def test_пустой_ответ_говорит_что_схема_завершена() -> None:
    assert render.alerts({k: [] for k in full_payload()}) == "Замечаний нет — схема завершена."


def test_ответ_старого_сервера_без_новых_списков_переживается() -> None:
    # Сервер старше клиента не отдаёт новых классов вовсе — рендер обязан не
    # упасть на отсутствующем ключе (ровно ради этого у полей бэка дефолт []).
    out = render.alerts({"disconnected_nodes": [{"node_id": u(1), "node_name": "Сирота"}]})
    assert "Объекты без связей (1)" in out and "Сирота" in out
    assert render.alerts({}) == "Замечаний нет — схема завершена."


def test_незнакомый_класс_нового_сервера_печатается_а_не_глотается() -> None:
    # Сервер новее клиента: класс, которого рендер не знает, обязан дойти до агента —
    # иначе «Замечаний нет», пока панель горит (камень 24 docs/plan-c4-elements.md).
    records = [{"node_id": u(i), "node_name": f"Объект {i}"} for i in range(7)]
    out = render.alerts({"future_class": records})
    assert out.startswith("Замечаний: 7\n")
    assert "«future_class» (7)" in out and "обновите MCP-сервер" in out
    assert '"node_name": "Объект 0"' in out and '"node_name": "Объект 4"' in out
    assert "Объект 5" not in out and "… и ещё 2" in out
    # рядом с известными классами — свой блок после них, счётчик общий
    out = render.alerts({**validated_payload(), "future_class": records[:1]})
    assert out.startswith("Замечаний: 17\n")
    assert out.index("«future_class» (1)") > out.index("Пользователи внутри системы (")
    # пустой незнакомый список и не-список — не замечания
    assert render.alerts({"future_class": [], "total": 3}) == "Замечаний нет — схема завершена."


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
    assert "16" in tool["description"]
    # Каждый заголовок панели назван в описании (строчными, как в перечне).
    desc = tool["description"].lower()
    for title in panel_titles():
        words = title.lower()
        if words.startswith("обращения к неописанным"):
            words = "обращения к неописанным"  # три семьи — одной фразой
        assert words in desc, title
