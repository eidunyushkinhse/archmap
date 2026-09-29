"""Поиск по проекту (archmap_search) и одна схема (archmap_doc).

Фикстуры ответов сверяются схемами САМОГО БЭКЕНДА (SearchResponse,
NodeDocDetail, NodeDocMeta): подменённый транспорт форму не валидирует, и без
этой сверки тест зелён на выдуманных полях.
"""

from __future__ import annotations

from typing import Any

import pytest
from conftest import PROJECT_ID, FakeApi, backend, node

from archmap_mcp import tools
from archmap_mcp.client import ArchMapClient, ArchMapError

SERVER = "00000000-0000-0000-0000-00000000000a"
ALERTER = "00000000-0000-0000-0000-00000000000b"
DOC = "00000000-0000-0000-0000-0000000000d1"
PROC = "00000000-0000-0000-0000-0000000000f1"
MSG = "00000000-0000-0000-0000-0000000000e1"


def checked(module: str, name: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Ответ глазами бэкенда — судья формы фикстуры."""
    getattr(backend(f"schemas.{module}"), name).model_validate(payload)
    return payload


def hit(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "kind": "doc", "node_id": ALERTER, "node_path": "Zabbix server / Alerter",
        "title": "SMS: отправка", "doc_id": DOC, "process_id": None, "message_id": None,
        "line_no": 4, "snippet": "B -->|нет| E[Ошибка: SMSDevices not configured for <устройство>]",
        "score": 8.04, "matched": ["not", "configured", "smsdevices"], "more_in_group": 0,
    }
    base.update(over)
    return base


SEARCH = {
    "query": "failed to send SMS: SMSDevices not configured for /dev/ttyUSB0",
    "tokens": ["failed", "send", "sms", "smsdevices", "not", "configured", "dev", "ttyusb0"],
    "total": 9,
    "hits": [
        hit(more_in_group=2),
        hit(kind="step", node_id=None, node_path=None, title="Отправка оповещения",
            doc_id=DOC, process_id=PROC, message_id=MSG, line_no=None,
            snippet="SMSDevices not configured", score=6.1, matched=["not", "configured"]),
        hit(kind="param", node_id=SERVER, node_path="Zabbix server", title="SMSDevices",
            doc_id=None, line_no=None, snippet="SMSDevices · Модемы для SMS", score=3.4,
            matched=["smsdevices", "sms"]),
        hit(line_no=2, snippet="A[Получено задание SMS] --> B{SMSDevices?}", score=3.3,
            matched=["smsdevices", "sms"], more_in_group=2),
    ],
}


async def test_поиск_группирует_по_объектам_и_ведёт_дальше(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.get("/search", checked("search", "SearchResponse", SEARCH))

    out = await tools.call(
        "archmap_search",
        {"project": "Ярмарка", "query": SEARCH["query"], "limit": 5, "kinds": ["doc", "step", "param"]},
        client,
    )

    # Запрос ушёл как есть, со скоупом проекта; kinds — повторяемым параметром.
    call = api.calls[-1]
    assert call.url.path == "/api/v1/search"
    assert call.headers["X-Project-Id"] == PROJECT_ID
    assert call.url.params["q"] == SEARCH["query"]
    assert call.url.params["limit"] == "5"
    assert call.url.params.get_list("kinds") == ["doc", "step", "param"]

    assert "Найдено 9, показаны лучшие 4 (искали по: failed, send, sms," in out
    # Две строки одной схемы — под одним заголовком с doc_id, с «ещё N».
    group = out.index(f"▸ Zabbix server / Alerter  node_id={ALERTER}")
    schema = out.index(f"  • схема «SMS: отправка»  doc_id={DOC}")
    line4 = out.index("      стр. 4: B -->|нет| E[Ошибка: SMSDevices not configured")
    line2 = out.index("      стр. 2: A[Получено задание SMS]")
    more = out.index("      … ещё 2 строки в этой схеме")
    assert group < schema < line4 < line2 < more
    assert out.count("схема «SMS: отправка»") == 1
    # Шаг — в группе своего процесса, с id шага и схемой, которой он задокументирован.
    assert f"▸ процесс «Отправка оповещения»  process_id={PROC}" in out
    assert f"  • шаг: SMSDevices not configured  message_id={MSG}" in out
    assert f"(задокументирован схемой doc_id={DOC})" in out
    # Параметр — в группе своего объекта.
    assert f"▸ Zabbix server  node_id={SERVER}" in out
    assert "  • параметр SMSDevices: SMSDevices · Модемы для SMS" in out
    assert "совпало: not, configured, smsdevices" in out
    # Порядок групп — по лучшей находке.
    assert out.index("▸ Zabbix server / Alerter") < out.index("▸ процесс") < out.index(
        "▸ Zabbix server  node_id"
    )
    assert out.rstrip().endswith(
        "archmap_doc(doc_id), объект — archmap_node(node_id), процесс с шагами — "
        "archmap_processes(process_id)."
    )


async def test_поиск_без_находок(client: ArchMapClient, api: FakeApi) -> None:
    api.get("/search", checked("search", "SearchResponse", {
        "query": "quantum flux", "tokens": ["quantum", "flux"], "total": 0, "hits": [],
    }))

    out = await tools.call("archmap_search", {"project": "Ярмарка", "query": "quantum flux"}, client)

    assert "Ничего не нашлось (искали по: quantum, flux)" in out
    # Пустая выдача не тупик: агенту сказано, как переспросить.
    assert "Попробуйте одно характерное слово из строки" in out
    # limit и kinds не переданы — и в запрос не уходят.
    assert set(api.calls[-1].url.params.keys()) == {"q"}


async def test_поиск_спека_и_объект(client: ArchMapClient, api: FakeApi) -> None:
    api.get("/search", checked("search", "SearchResponse", {
        "query": "alerts retries", "tokens": ["alerts", "retries"], "total": 2,
        "hits": [
            hit(kind="spec", title="OpenAPI", doc_id=None, line_no=12,
                snippet="retries: {type: integer}", more_in_group=1),
            hit(kind="node", title="Alerter", doc_id=None, line_no=None,
                snippet="Alerter · retries alerts"),
        ],
    }))

    out = await tools.call("archmap_search", {"project": "Ярмарка", "query": "alerts retries"}, client)

    assert "Найдено 2 (искали по: alerts, retries)" in out
    assert "  • OpenAPI-спека объекта (archmap_node с include_spec)" in out
    assert "      стр. 12: retries: {type: integer}" in out
    assert "      … ещё 1 строка в спеке" in out
    assert "  • объект: Alerter · retries alerts" in out


# ── archmap_doc ──────────────────────────────────────────────────────────────


def doc_meta(doc_id: str, name: str, described: bool = True) -> dict[str, Any]:
    return checked("node_doc", "NodeDocMeta", {
        "id": doc_id, "name": name, "kind": "operation", "operation": None,
        "version": 1, "described": described,
    })


def detail(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": DOC, "node_id": ALERTER, "name": "SMS: отправка", "kind": "worker",
        "operation": None, "content": "flowchart TD\n  B -->|нет| E[Ошибка]\n\n", "version": 3,
        "created_at": "2026-09-29T10:00:00Z", "updated_at": "2026-09-29T11:00:00Z",
        "node_path": "Zabbix server / Alerter", "described": True,
        "processes": [{"doc_id": DOC, "process_id": PROC, "process_name": "Отправка оповещения",
                       "steps": 2}],
    }
    base.update(over)
    return checked("node_doc", "NodeDocDetail", base)


def doc_routes(api: FakeApi, payload: dict[str, Any]) -> None:
    api.get("/nodes/all", [
        node(SERVER, "Zabbix server", docs=[]),
        node(ALERTER, "Alerter", SERVER, docs=[doc_meta(DOC, "SMS: отправка")]),
    ])
    api.get(f"/nodes/{ALERTER}/docs/{DOC}", payload)


async def test_одна_схема_целиком(client: ArchMapClient, api: FakeApi) -> None:
    doc_routes(api, detail())

    out = await tools.call("archmap_doc", {"project": "Ярмарка", "doc_id": DOC}, client)

    # Объект схемы найден по мете в плоском списке — запрос ушёл по его адресу.
    assert api.calls[-1].url.path == f"/api/v1/nodes/{ALERTER}/docs/{DOC}"
    assert f"Объект: Zabbix server / Alerter  node_id={ALERTER}" in out
    assert f"Схема: «SMS: отправка» (воркер)  doc_id={DOC}" in out
    assert "В 1 процессе:" in out
    assert f"  • Отправка оповещения — 2 шага  process_id={PROC}" in out
    assert "```mermaid\nflowchart TD\n  B -->|нет| E[Ошибка]\n```" in out
    assert "Не описана" not in out


async def test_одна_схема_заглушка_с_эндпоинтом(client: ArchMapClient, api: FakeApi) -> None:
    doc_routes(api, detail(kind="operation", operation="POST /api/jsonrpc", content="",
                           described=False, processes=[]))

    out = await tools.call("archmap_doc", {"project": "Ярмарка", "doc_id": DOC}, client)

    assert "(операция · POST /api/jsonrpc)" in out
    assert "Не описана: это заглушка разведки, тела у схемы нет." in out
    assert "В процессах шаги этой схемой не задокументированы." in out
    assert "```mermaid" not in out


async def test_одна_схема_не_найдена(client: ArchMapClient, api: FakeApi) -> None:
    doc_routes(api, detail())

    with pytest.raises(ArchMapError, match="не найдена в проекте «Ярмарка»"):
        await tools.call(
            "archmap_doc",
            {"project": "Ярмарка", "doc_id": "00000000-0000-0000-0000-0000000000ff"},
            client,
        )


def test_каталог_31_инструмент_и_описание_поиска_направляет() -> None:
    names = [t["name"] for t in tools.TOOLS]
    assert len(names) == 31 and len(set(names)) == 31
    assert {"archmap_search", "archmap_doc"} <= set(names)
    desc = tools.BY_NAME["archmap_search"]["description"]
    assert "ЦЕЛИКОМ" in desc and "ПЕРЕД тем, как открывать карточки" in desc
    assert "по словам, а не по смыслу" in desc
    # Перечень видов в схеме аргумента — ровно Literal бэкенда.
    kinds = tools.BY_NAME["archmap_search"]["schema"]["properties"]["kinds"]["items"]["enum"]
    from typing import get_args

    assert kinds == list(get_args(backend("schemas.search").SearchKind))
