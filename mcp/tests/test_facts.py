"""Семьи табличных фактов: одна тройка инструментов на три сущности.

Каждое тело сверяется со схемой СВОЕЙ ручки, каждая фикстура отчёта — со схемой
своего отчёта: три семьи похожи ровно настолько, чтобы разница в полях
(tables/channels/params, *_written) прошла мимо глаз и всплыла на живом сервере.
"""

from __future__ import annotations

import json
from typing import Any, get_args

import pytest
from conftest import FakeApi, backend

from archmap_mcp import render, tools
from archmap_mcp.client import ArchMapClient, ArchMapError

NODE_ID = "44444444-4444-4444-4444-444444444444"
FILES = [{"name": "archmap-data.yaml", "content": "tables: []\n"}]

# Семья → (модуль схем бэка, схема входа, схема отчёта, префикс ручек).
SCHEMAS = {
    "tables": ("data_import", "DataImportIn", "DataImportReport", "/data-import"),
    "channels": ("channels_import", "ChannelsImportIn", "ChannelsImportReport", "/channels-import"),
    "config": ("config_import", "ConfigImportIn", "ConfigImportReport", "/config-import"),
}

REPORTS: dict[str, dict[str, Any]] = {
    "tables": {
        "tables": [
            {"node_path": "Ярмарка / Заказы БД", "source": "a.yaml", "schema_name": "public",
             "name": "orders", "columns": 12, "action": "create"},
            {"node_path": "Ярмарка / Заказы БД", "source": "a.yaml", "schema_name": "",
             "name": "items", "columns": 3, "action": "skip"},
        ],
        "warnings": ["в файле a.yaml таблица без колонок"],
        "tables_written": 2, "columns_written": 15,
    },
    "channels": {
        "channels": [
            {"node_path": "Ярмарка / Kafka", "source": "b.yaml", "group_name": "orders",
             "name": "created", "fields": 5, "action": "create"},
        ],
        "channels_written": 1, "fields_written": 5,
    },
    "config": {
        "params": [
            {"node_path": "Ярмарка / Сервис заказов", "source": "c.yaml", "name": "DB_POOL_SIZE",
             "value_type": "int", "required": False, "action": "overwrite"},
        ],
        "params_written": 1,
    },
}


def report(family: str, **over: Any) -> dict[str, Any]:
    """Фикстура отчёта глазами бэкенда: поля именно те, что приедут с живой ручки."""
    module, _in, out, _prefix = SCHEMAS[family]
    data = dict(REPORTS[family])
    data.update(over)
    return getattr(backend(f"schemas.{module}"), out).model_validate(data).model_dump(mode="json")


def check_in(family: str, body: dict[str, Any]) -> None:
    module, schema, _out, _prefix = SCHEMAS[family]
    getattr(backend(f"schemas.{module}"), schema).model_validate(body)


# ── Промпт ───────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("family", list(SCHEMAS))
async def test_промпт_семьи_идёт_на_свою_ручку(
    client: ArchMapClient, api: FakeApi, family: str
) -> None:
    prefix = SCHEMAS[family][3]
    api.get(f"{prefix}/prompt", {"prompt": f"правила {family}"})

    out = await tools.call(
        "archmap_facts_prompt", {"project": "Ярмарка", "family": family}, client
    )

    assert out == f"правила {family}"
    assert api.calls[-1].url.path == f"/api/v1{prefix}/prompt"
    assert api.calls[-1].url.query == b""  # без variant вызов прежний байт-в-байт


async def test_промпт_семьи_проносит_вариант(client: ArchMapClient, api: FakeApi) -> None:
    api.get("/config-import/prompt", {"prompt": "аудит"})

    await tools.call(
        "archmap_facts_prompt",
        {"project": "Ярмарка", "family": "config", "variant": "skeptic"},
        client,
    )

    assert api.calls[-1].url.params["variant"] == "skeptic"


# ── Превью и применение ──────────────────────────────────────────────────────

@pytest.mark.parametrize("family", list(SCHEMAS))
async def test_превью_семьи_шлёт_своё_тело(
    client: ArchMapClient, api: FakeApi, family: str
) -> None:
    prefix = SCHEMAS[family][3]
    api.post(f"{prefix}/preview", report(family))

    await tools.call(
        "archmap_facts_preview",
        {"project": "Ярмарка", "family": family, "files": FILES, "node_id": NODE_ID,
         "overwrite": True},
        client,
    )

    assert api.calls[-1].url.path == f"/api/v1{prefix}/preview"
    body = json.loads(api.calls[-1].content)
    assert body["files"] == FILES
    assert body["node_id"] == NODE_ID
    assert body["overwrite"] is True
    check_in(family, body)


@pytest.mark.parametrize("family", list(SCHEMAS))
async def test_применение_семьи_печатает_числа_сервера(
    client: ArchMapClient, api: FakeApi, family: str
) -> None:
    prefix = SCHEMAS[family][3]
    api.post(f"{prefix}/apply", report(family, applied=True))

    out = await tools.call(
        "archmap_facts_apply",
        {"project": "Ярмарка", "family": family, "files": FILES},
        client,
    )

    assert api.calls[-1].url.path == f"/api/v1{prefix}/apply"
    assert "Записано: " in out
    assert "Ничего не записано" not in out
    body = json.loads(api.calls[-1].content)
    assert body["overwrite"] is False  # дефолт — «описанное раньше побеждает»
    check_in(family, body)


async def test_сводка_таблиц_адресует_каждую_строку(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.post("/data-import/preview", report("tables"))

    out = await tools.call(
        "archmap_facts_preview", {"project": "Ярмарка", "family": "tables", "files": FILES}, client
    )

    assert "ТАБЛИЦЫ: 2 таблицы (новых 1)" in out
    # Адрес объекта В КАЖДОЙ строке: один пакет описывает несколько БД монолита.
    assert "новая: «Ярмарка / Заказы БД» · public.orders · колонок 12" in out
    assert "пропуск (занято): «Ярмарка / Заказы БД» · items · колонок 3" in out
    assert "Предупреждения (1)" in out
    assert "archmap_facts_apply" in out


async def test_сводка_каналов_и_параметров_рисует_свои_поля(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.post("/channels-import/preview", report("channels"))
    api.post("/config-import/preview", report("config"))

    каналы = await tools.call(
        "archmap_facts_preview", {"project": "Ярмарка", "family": "channels", "files": FILES},
        client,
    )
    параметры = await tools.call(
        "archmap_facts_preview", {"project": "Ярмарка", "family": "config", "files": FILES},
        client,
    )

    assert "КАНАЛЫ: 1 канал (новых 1)" in каналы
    assert "новая: «Ярмарка / Kafka» · orders/created · полей 5" in каналы
    assert "ПАРАМЕТРЫ: 1 параметр" in параметры
    assert "перезапись: «Ярмарка / Сервис заказов» · DB_POOL_SIZE (int, необяз.)" in параметры


# ── Границы ──────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("tool", ["archmap_facts_prompt", "archmap_facts_preview"])
async def test_неизвестная_семья_отвечает_списком(client: ArchMapClient, tool: str) -> None:
    # Модель промахивается мимо enum регулярно, и 422 от сервера ей не подсказка.
    with pytest.raises(ArchMapError) as exc:
        await tools.call(tool, {"project": "Ярмарка", "family": "таблицы", "files": FILES}, client)

    text = str(exc.value)
    assert "tables" in text and "channels" in text and "config" in text
    assert "database" in text and "broker" in text and "service" in text


async def test_семьи_каталога_и_рендера_совпадают() -> None:
    # Три места знают о семьях: enum схемы, карта путей и карта рисования. Разойдись
    # они — инструмент либо уедет на несуществующую ручку, либо упадёт на KeyError.
    assert set(tools.FACT_PATH) == set(render.FACT_FAMILIES)
    assert set(tools.FAMILY_ARG["enum"]) == set(tools.FACT_PATH)
    assert set(tools.FACT_OWNER) == set(tools.FACT_PATH)


async def test_слова_действий_те_же_что_у_бэкенда() -> None:
    # Незнакомое значение action печаталось бы кодом вместо слова — молча и во всех
    # трёх семьях сразу (DocsAction у них общий).
    assert set(render.ACTION_WORD) == set(get_args(backend("schemas.docs_import").DocsAction))


async def test_строки_семьи_режутся_с_честным_хвостом() -> None:
    many = {
        "tables": [
            {"node_path": "БД", "source": "a", "schema_name": "", "name": f"t{i}",
             "columns": 1, "action": "create"}
            for i in range(render.FACT_REPORT_CAP + 3)
        ],
    }
    out = render.facts_report(many, "tables", applied=False)

    # Согласование числительного, а не просто наличие хвоста: «3 таблиц» —
    # подстрока правильного «3 таблицы», и небрежная проверка пропустила бы ошибку.
    assert out.rstrip().splitlines()[-3] == "… и ещё 3 таблицы"
