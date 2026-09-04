"""Сводка дозаливки схем логики и спек.

Тестов у неё не было вовсе — и она читала поля, которых в отчёте нет
(`items`/`status` вместо `logic`/`specs`/`action`), печатая ПУСТОЙ план на
валидный пакет. Найдено живой проверкой Ф2; фикстуры здесь валидируются
DocsImportReport, чтобы такое не повторилось.
"""

from __future__ import annotations

from typing import Any

from conftest import FakeApi, backend

from archmap_mcp import render, tools
from archmap_mcp.client import ArchMapClient

FILES = [{"name": "probe.mmd", "content": "flowchart TD\n A --> B\n"}]


def report(**over: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "logic": [
            {"node_path": "Ярмарка / Заказы", "source": "a.mmd", "name": "Оформление",
             "kind": "operation", "operation": "POST /orders", "action": "create",
             "mermaid": "flowchart TD"},
            {"node_path": "Ярмарка / Заказы", "source": "b.mmd", "name": "Отмена",
             "kind": "operation", "operation": None, "action": "fill", "mermaid": "flowchart TD"},
            {"node_path": "Ярмарка / Заказы", "source": "c.mmd", "name": "Рассылка",
             "kind": "worker", "operation": None, "action": "skip", "mermaid": "flowchart TD"},
        ],
        "specs": [
            {"node_path": "Ярмарка / Заказы", "source": "api.yaml", "origin": "synthesized",
             "action": "overwrite", "valid_yaml": True, "looks_openapi": True,
             "oas_version": "3.0.3"},
        ],
        "errors": [],
        "warnings": [],
        "conflicts": ["a.mmd и d.mmd описывают одну схему — оставлен a.mmd"],
        "applied": False,
        "created_docs": 0, "filled_docs": 0, "updated_docs": 0, "specs_written": 0,
        "data_refs_total": 0, "channel_refs_total": 0,
    }
    data.update(over)
    return backend("schemas.docs_import").DocsImportReport.model_validate(data).model_dump(
        mode="json"
    )


async def test_превью_доков_показывает_план_а_не_пустоту(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.post("/docs-import/preview", report())

    out = await tools.call(
        "archmap_docs_preview", {"project": "Ярмарка", "files": FILES}, client
    )

    assert "СХЕМЫ ЛОГИКИ: 3 (новая 1, заполнит заглушку 1, пропуск (занято) 1)" in out
    assert "новая: «Ярмарка / Заказы» · Оформление (операция · POST /orders)" in out
    assert "заполнит заглушку: «Ярмарка / Заказы» · Отмена (операция)" in out
    assert "Рассылка (воркер)" in out
    assert "OPENAPI-СПЕКИ: 1" in out
    assert "api.yaml · OAS 3.0.3 · synthesized" in out
    assert "Конфликты файлов (1" in out
    assert "archmap_docs_apply" in out


async def test_применение_доков_печатает_числа_сервера(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.post("/docs-import/apply", report(
        applied=True, created_docs=1, filled_docs=1, updated_docs=0, specs_written=1
    ))

    out = await tools.call(
        "archmap_docs_apply", {"project": "Ярмарка", "files": FILES}, client
    )

    assert "схем создано 1, заполнено заглушек 1, перезаписано 0, спек 1" in out
    assert "Ничего не записано" not in out


async def test_пустой_пакет_говорит_что_ничего_не_принёс(
    client: ArchMapClient, api: FakeApi
) -> None:
    # Прежняя сводка на этом месте молчала, и «ничего не приедет» выглядело так же,
    # как успешный план: агент шёл применять вслепую.
    api.post("/docs-import/preview", report(logic=[], specs=[], conflicts=[]))

    out = await tools.call(
        "archmap_docs_preview", {"project": "Ярмарка", "files": FILES}, client
    )

    assert "ни схем логики, ни спек не распознано" in out


async def test_битая_спека_названа(client: ArchMapClient, api: FakeApi) -> None:
    api.post("/docs-import/preview", report(specs=[
        {"node_path": "Ярмарка", "source": "api.yaml", "origin": "found", "action": "create",
         "valid_yaml": False, "looks_openapi": False, "oas_version": None},
    ]))

    out = await tools.call(
        "archmap_docs_preview", {"project": "Ярмарка", "files": FILES}, client
    )

    assert "невалидный YAML" in out


async def test_ошибки_доков_не_тонут_в_плане(client: ArchMapClient, api: FakeApi) -> None:
    api.post("/docs-import/preview", report(
        logic=[], specs=[], conflicts=[], errors=["probe.mmd: нет шапки archmap-name"]
    ))

    out = await tools.call(
        "archmap_docs_preview", {"project": "Ярмарка", "files": FILES}, client
    )

    assert "Проблемы (1)" in out
    assert "нет шапки archmap-name" in out
    # При ошибках «пакет ничего не принёс» — вторая, лишняя причина того же отказа.
    assert "не распознано" not in out


async def test_виды_схем_и_действия_совпадают_с_бэкендом() -> None:
    from typing import get_args

    assert set(render.KIND_WORD) == set(get_args(backend("schemas.node_doc").NodeDocKind))
