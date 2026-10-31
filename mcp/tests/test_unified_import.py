"""Единый импорт: N входов любого типа, споры содержимого, имя из манифеста.

Фикстуры ответов строятся СХЕМАМИ БЭКЕНДА и сериализуются ими же: подменённый
транспорт формы не проверяет, и «почти такой» словарь прятал бы расхождение до
живого сервера (ловушка, ради которой заведён conftest.backend).
"""

from __future__ import annotations

import io
import json
import re
import zipfile
from pathlib import Path
from typing import Any

import httpx
import pytest
from conftest import PROJECT_ID, FakeApi, backend

from archmap_mcp import tools
from archmap_mcp.client import ArchMapClient, ArchMapError

PREVIEW_PATH = "/projects/import/unified-preview"
APPLY_PATH = "/projects/import-unified"


def dump(module: str, model: str, **fields: Any) -> dict[str, Any]:
    """Ответ бэкенда как он есть: модель собирается, валидируется и сериализуется."""
    return getattr(backend(f"schemas.{module}"), model)(**fields).model_dump(mode="json")


def c4(**over: Any) -> dict[str, Any]:
    fields: dict[str, Any] = {
        "ok": True, "errors": [], "node_count": 12, "edge_count": 9,
        "roots": ["Маркетплейс"], "files": 2,
    }
    fields.update(over)
    return dump("project", "ImportPreviewOut", **fields)


def conflict(**over: Any) -> dict[str, Any]:
    fields: dict[str, Any] = {
        "id": "doc|Маркетплейс/API|Оформление заказа",
        "family": "doc",
        "node_path": "Маркетплейс / API",
        "key": "Оформление заказа",
        "candidates": [
            {"origin": 0, "origin_label": "a.zip", "summary": "42 строки",
             "body": "flowchart TD", "truncated": False},
            {"origin": 1, "origin_label": "b.zip", "summary": "30 строк",
             "body": "flowchart LR", "truncated": True},
        ],
        "default": "all",
        "allow_all": True,
    }
    fields.update(over)
    return fields


def zip_input(tmp_path: Path, name: str = "arch.zip") -> Path:
    path = tmp_path / name
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("manifest.yaml", "archmap-archive: 1\n")
    path.write_bytes(buf.getvalue())
    return path


# ── Превью ───────────────────────────────────────────────────────────────────

async def test_старый_вызов_одним_yaml_даёт_прежнюю_сводку(
    client: ArchMapClient, api: FakeApi
) -> None:
    """Сентинел обратной совместимости: инструмент переехал на единый путь, но
    агент, зовущий его одним YAML-текстом, обязан увидеть то же самое."""
    api.post(PREVIEW_PATH, dump(
        "unified_import", "UnifiedPreviewOut", ok=True,
        c4=c4(files=1, warnings=["актор внутри системы: Покупатель"]),
    ))

    out = await tools.call(
        "archmap_import_preview", {"files": [{"name": "a.yaml", "content": "x"}]}, client
    )

    assert "объектов 12, связей 9" in out
    assert "актор внутри системы" in out
    assert "НЕ создан" in out or "Ничего не создано" in out
    assert all(c.url.path != "/api/v1/projects" or c.method != "POST" for c in api.calls)


async def test_входы_едут_multipart_в_порядке_files_потом_paths(
    client: ArchMapClient, api: FakeApi, tmp_path: Path
) -> None:
    # Порядок значим: номер входа в замечаниях бэка («вход 2») и origin кандидата
    # спора считаются по позиции в multipart.
    api.post(PREVIEW_PATH, dump("unified_import", "UnifiedPreviewOut", ok=True, c4=c4()))
    archive = zip_input(tmp_path)

    await tools.call(
        "archmap_import_preview",
        {"files": [{"name": "a.yaml", "content": "nodes: []"}], "paths": [str(archive)]},
        client,
    )

    body = api.calls[-1].content
    assert api.calls[-1].headers["content-type"].startswith("multipart/form-data")
    assert b'name="files"; filename="a.yaml"' in body
    assert b'name="files"; filename="arch.zip"' in body
    assert body.index(b'filename="a.yaml"') < body.index(b'filename="arch.zip"')
    assert b"application/zip" in body


async def test_споры_печатаются_с_id_и_кандидатами(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.post(PREVIEW_PATH, dump(
        "unified_import", "UnifiedPreviewOut", ok=True, c4=c4(),
        families={"docs": 4, "tables": 7},
        family_conflicts=[conflict()],
    ))

    out = await tools.call(
        "archmap_import_preview", {"files": [{"name": "a.yaml", "content": "x"}]}, client
    )

    assert "doc|Маркетплейс/API|Оформление заказа" in out
    assert "cand:0 — a.zip · 42 строки" in out
    assert "cand:1 — b.zip · 30 строк" in out
    assert "по умолчанию: all" in out
    assert "resolutions" in out  # агент обязан узнать, чем решить спор
    assert "схем логики 4" in out and "таблиц 7" in out
    # Тел кандидатов в выводе нет: спор различают по сводке.
    assert "flowchart" not in out


async def test_имя_из_манифеста_названо_явно(client: ArchMapClient, api: FakeApi) -> None:
    api.post(PREVIEW_PATH, dump(
        "unified_import", "UnifiedPreviewOut", ok=True, c4=c4(),
        name_source="manifest", manifest_name="Маркетплейс «Ярмарка» v2",
    ))

    out = await tools.call(
        "archmap_import_preview", {"files": [{"name": "a.yaml", "content": "x"}]}, client
    )

    assert "Маркетплейс «Ярмарка» v2" in out


async def test_непройдёт_показывает_ошибки(client: ArchMapClient, api: FakeApi) -> None:
    api.post(PREVIEW_PATH, dump(
        "unified_import", "UnifiedPreviewOut", ok=False,
        errors=["вход 1: не найден корневой узел"],
    ))

    out = await tools.call(
        "archmap_import_preview", {"files": [{"name": "a.yaml", "content": "!"}]}, client
    )

    assert "НЕ пройдёт" in out and "не найден корневой узел" in out


async def test_несуществующий_путь_называет_файл(client: ArchMapClient) -> None:
    with pytest.raises(ArchMapError) as exc:
        await tools.call("archmap_import_preview", {"paths": ["/нет/такого/arch.zip"]}, client)

    assert "/нет/такого/arch.zip" in str(exc.value)


async def test_пустой_вызов_объясняет_чего_ждут(client: ArchMapClient) -> None:
    with pytest.raises(ArchMapError) as exc:
        await tools.call("archmap_import_preview", {}, client)

    assert "paths" in str(exc.value) and "files" in str(exc.value)


async def test_чужое_расширение_не_уезжает_на_сервер(
    client: ArchMapClient, api: FakeApi, tmp_path: Path
) -> None:
    stray = tmp_path / "readme.md"
    stray.write_text("не схема", encoding="utf-8")

    with pytest.raises(ArchMapError) as exc:
        await tools.call("archmap_import_preview", {"paths": [str(stray)]}, client)

    assert ".zip" in str(exc.value)


# ── Применение ───────────────────────────────────────────────────────────────

def result(**over: Any) -> dict[str, Any]:
    fields: dict[str, Any] = {
        "project_id": PROJECT_ID, "project_name": "Zabbix", "nodes": 12, "edges": 9,
        "docs_created": 5, "specs_applied": 2,
    }
    fields.update(over)
    return dump("archive", "ArchiveImportResult", **fields)


async def test_применение_шлёт_поля_формы_и_резолюции_строкой(
    client: ArchMapClient, api: FakeApi, tmp_path: Path
) -> None:
    # ⚠️ resolutions уходит СТРОКОЙ JSON: тело multipart, а бэкенд разбирает
    # словарь из текста поля формы (_parse_resolutions).
    api.post(APPLY_PATH, result())
    archive = zip_input(tmp_path)

    out = await tools.call(
        "archmap_import_apply",
        {
            "name": "Zabbix", "description": "из архива",
            "files": [{"name": "a.yaml", "content": "nodes: []"}],
            "paths": [str(archive)],
            "resolutions": {"doc|A|B": "cand:1"},
        },
        client,
    )

    body = api.calls[-1].content
    assert b'name="name"' in body and b"Zabbix" in body
    assert b'name="description"' in body
    assert b'name="resolutions"' in body
    assert json.dumps({"doc|A|B": "cand:1"}, ensure_ascii=False).encode() in body
    assert "Проект «Zabbix» создан" in out and "объектов 12" in out
    assert str(PROJECT_ID) in out


async def test_отчёт_создания_печатает_семьи_и_процессы(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.post(APPLY_PATH, result(
        db=dump("data_import", "DataImportReport", tables=[], tables_written=3, columns_written=17),
        processes=[dump(
            "process_import", "ProcessImportResult", process_id=PROJECT_ID, participants=4,
            unbound=0, messages=12, attached=11, dangling=1, fragments=0, unsupported=[],
            doc_linked=9, doc_unresolved=2,
        )],
        warnings=["адрес схемы не разрешён: Ярмарка / Нет такого"],
        resolved_conflicts=3,
    ))

    out = await tools.call(
        "archmap_import_apply",
        {"name": "Zabbix", "files": [{"name": "a.yaml", "content": "x"}]},
        client,
    )

    assert "таблиц 3" in out and "колонок 17" in out
    assert "шагов 12" in out and "повисло 1" in out and "схема не найдена у 2" in out
    assert "Разрешено споров содержимого: 3" in out
    assert "адрес схемы не разрешён" in out


# ── Основание склейки (Ф4 docs/plan-anchor-ux.md) ────────────────────────────

async def test_превью_называет_основание_каждой_склейки(
    client: ArchMapClient, api: FakeApi, tmp_path: Path
) -> None:
    """«Склеено 2» без «почему» — невидимая магия: ложная склейка хуже дубля
    именно тем, что выглядит правильной схемой. Агент читает основание словами."""
    api.post(PREVIEW_PATH, dump(
        "unified_import", "UnifiedPreviewOut",
        ok=True,
        c4=c4(
            merged_count=3,
            merged=["Маркетплейс / Заказы", "Маркетплейс / Kafka", "Маркетплейс / Каталог"],
            merged_nodes=[
                {"path": "Маркетплейс / Заказы", "basis": "code"},
                {"path": "Маркетплейс / Kafka", "basis": "dependency"},
                {"path": "Маркетплейс / Каталог", "basis": "name"},
            ],
            nodes_without_anchor=5,
        ),
    ))

    out = await tools.call(
        "archmap_import_preview", {"paths": [str(zip_input(tmp_path))]}, client
    )

    assert "• Маркетплейс / Заказы — по коду" in out
    assert "• Маркетплейс / Kafka — по имени зависимости" in out
    # У матча по имени называем ГДЕ: имя решает только внутри своего контейнера.
    assert "• Маркетплейс / Каталог — по имени внутри «Маркетплейс»" in out
    assert "Без источника: 5 объектов — будут опознаваться по имени" in out


async def test_без_склеек_и_безъякорных_лишних_строк_нет(
    client: ArchMapClient, api: FakeApi, tmp_path: Path
) -> None:
    api.post(PREVIEW_PATH, dump("unified_import", "UnifiedPreviewOut", ok=True, c4=c4()))

    out = await tools.call(
        "archmap_import_preview", {"paths": [str(zip_input(tmp_path))]}, client
    )

    assert "Без источника" not in out and "по коду" not in out


async def test_заглушки_каналов_по_связям_названы_отдельной_строкой(
    client: ArchMapClient, api: FakeApi
) -> None:
    """Импорт C4 заводит брокерам заглушки каналов по channel связей (2026-09-06):
    агент должен увидеть, сколько их и чем закрыть — пакетом каналов."""
    api.post(APPLY_PATH, result(channel_stubs=3))

    out = await tools.call(
        "archmap_import_apply", {"files": [{"name": "a.yaml", "content": "x"}], "name": "Z"}, client
    )

    assert "заведено по связям схемы: 3 заглушки без описания" in out
    # подсказка называет семью значением из enum инструмента, иначе вызов по ней — отказ
    family = re.search(r"archmap_facts_prompt family=(\w+)", out)
    assert family and family.group(1) in tools.FAMILY_ARG["enum"]

    api.post(APPLY_PATH, result())
    out = await tools.call(
        "archmap_import_apply", {"files": [{"name": "a.yaml", "content": "x"}], "name": "Z"}, client
    )
    assert "заглуш" not in out


# ── Размер входов с диска (аудит P-11) ──────────────────────────────────────


async def test_входы_больше_предела_не_читаются(
    client: ArchMapClient, api: FakeApi, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Предел проверяется по размеру файла ДО чтения и по сумме входов одного запроса.
    monkeypatch.setattr(tools, "MAX_INPUT_BYTES", 100)
    small = tmp_path / "a.yaml"
    small.write_text("x" * 60)
    other = tmp_path / "b.yaml"
    other.write_text("y" * 60)
    calls = len(api.calls)

    with pytest.raises(ArchMapError, match="больше"):
        await tools.call("archmap_import_preview", {"paths": [str(small), str(other)]}, client)

    assert len(api.calls) == calls  # до сервера не дошло


# ── Вопросы разбора остатка и ответы decisions (MCP 0.12.0) ──────────────────

CONVERTED = "Похожие имена: «Ярмарка / billing» (a.yaml) и «Ярмарка / biling» (b.yaml)"
KEPT = "Связь «web → Kafka» с брокером без канала"


def remainder(**over: Any) -> dict[str, Any]:
    """Остаток всех классов глазами бэкенда (RemainderOut)."""
    fields: dict[str, Any] = {
        "field_conflicts": [{
            "id": "field|Ярмарка/orders|description", "node_path": "Ярмарка / orders",
            "field": "description", "default": 0,
            "candidates": [
                {"origin": 0, "origin_label": "1 · a.yaml", "source_label": "Из файла a.yaml", "value": "Принимает заказы"},
                {"origin": 1, "origin_label": "2 · b.yaml", "source_label": "Из файла b.yaml", "value": "Заказы и корзина"},
            ],
        }, {
            "id": "field|Ярмарка/orders|element", "node_path": "Ярмарка / orders",
            "field": "element", "default": 1,
            "candidates": [
                {"origin": 0, "origin_label": "1 · a.yaml", "source_label": "Из файла a.yaml", "value": "system"},
                {"origin": 1, "origin_label": "2 · b.yaml", "source_label": "Из файла b.yaml", "value": "container"},
            ],
        }],
        "container_hints": [{
            "id": "hint|Ярмарка/payments", "node_path": "Ярмарка / payments",
            "children": ["api", "worker"], "folder": "src/payments", "repo": "github.com/org/shop",
        }],
        "container_edges": [{
            "id": "edge|Ярмарка/web|Ярмарка/orders|создать заказ|target",
            "from_path": "Ярмарка / web", "to_path": "Ярмарка / orders", "label": "создать заказ",
            "end": "target", "container_path": "Ярмарка / orders", "container_element": "container",
            "components": [
                {"path": "Ярмарка / orders / api", "has_children": False, "element_effective": "component"},
                {"path": "Ярмарка / orders / jobs", "has_children": True, "element_effective": "component"},
            ],
        }],
        "isolated_groups": [{"id": "group|Ярмарка/mailer", "node_paths": ["Ярмарка / mailer", "Ярмарка / smtp"]}],
        "fuzzy_pairs": [{
            "id": "pair|Ярмарка/billing|Ярмарка/biling", "a_path": "Ярмарка / billing",
            "b_path": "Ярмарка / biling", "a_source": "Из файла a.yaml", "b_source": "Из файла b.yaml",
            "a_edges": 3, "b_edges": 1, "where": "внутри «Ярмарка»",
        }],
        "unfixable": [{"id": "u1", "text": "У связи «web → Kafka» с брокером «Kafka» не указан канал. Укажите его в свойствах связи."}],
        "converted_warnings": [CONVERTED],
    }
    fields.update(over)
    return dump("unified_import", "RemainderOut", **fields)


async def test_превью_печатает_вопросы_разбора_с_id_и_ответами(
    client: ArchMapClient, api: FakeApi
) -> None:
    api.post(PREVIEW_PATH, dump(
        "unified_import", "UnifiedPreviewOut", ok=True,
        c4=c4(
            warnings=[CONVERTED, KEPT],
            file_remarks=[{"file": 1, "errors": [], "warnings": [CONVERTED]}],
        ),
        remainder=remainder(),
    ))

    out = await tools.call(
        "archmap_import_preview", {"files": [{"name": "a.yaml", "content": "x"}]}, client
    )

    lines = out.splitlines()
    assert any(line.startswith("Вопросы разбора (6) — ") and "archmap_import_apply аргументом decisions" in line for line in lines)
    # Спор поля: кандидаты с номерами и источниками, значения элемента — словами.
    assert '  • "field|Ярмарка/orders|description" — описание у «Ярмарка / orders» задано по-разному в 2 файлах:' in lines
    assert "      0 — «Принимает заказы» (из файла a.yaml)" in lines
    assert '    Без ответа — 0. Ответ: decisions.fields["field|Ярмарка/orders|description"] = номер.' in lines
    assert '  • "field|Ярмарка/orders|element" — элемент архитектуры у «Ярмарка / orders» задан по-разному в 2 файлах:' in lines
    assert "      1 — «контейнер» (из файла b.yaml)" in lines
    # «Похоже на контейнер»
    assert any("«Ярмарка / payments» — контейнер с компонентами: api, worker лежат в src/payments репозитория github.com/org/shop" in line for line in lines)
    assert '    Без ответа останется системой. Ответ: decisions.container_hints["hint|Ярмарка/payments"] = "container".' in lines
    # Связь в контейнер: цели путями, вложенный объект помечен
    assert any(
        "связь «Ярмарка / web → Ярмарка / orders» («создать заказ») приходит в контейнер «Ярмарка / orders» целиком; "
        "цели внутри: Ярмарка / orders / api, Ярмарка / orders / jobs (контейнер)." in line
        for line in lines
    )
    assert any('decisions.edges["edge|Ярмарка/web|Ярмарка/orders|создать заказ|target"] = {"to_path": ' in line for line in lines)
    # Похожие имена и группа без связей
    assert any('decisions.merges["pair|Ярмарка/billing|Ярмарка/biling"] = {"name": ' in line for line in lines)
    assert any("нет связей с остальной схемой у 2 объектов: Ярмарка / mailer, Ярмарка / smtp." in line for line in lines)
    assert any('decisions.new_edges = [{"group_id": "group|Ярмарка/mailer", "from_path": ' in line for line in lines)
    # Свёртка «Придётся подправить вручную» — текстом, без id
    assert "Придётся подправить вручную (1):" in lines
    assert "  • У связи «web → Kafka» с брокером «Kafka» не указан канал. Укажите его в свойствах связи." in lines
    # Строка, ставшая вопросом, не повторяется замечанием — ни в общем списке, ни у входа.
    assert CONVERTED not in out
    assert f"  • {KEPT}" in lines
    # Вопросы — после замечаний
    assert out.index(KEPT) < out.index("Вопросы разбора")


async def test_пустой_остаток_раздела_не_даёт(client: ArchMapClient, api: FakeApi) -> None:
    api.post(PREVIEW_PATH, dump("unified_import", "UnifiedPreviewOut", ok=True, c4=c4()))

    out = await tools.call(
        "archmap_import_preview", {"files": [{"name": "a.yaml", "content": "x"}]}, client
    )

    assert "Вопросы разбора" not in out and "подправить вручную" not in out


async def test_применение_шлёт_decisions_строкой_формы(client: ArchMapClient, api: FakeApi) -> None:
    api.post(APPLY_PATH, result())
    decisions = {
        "fields": {"field|Ярмарка/orders|description": 1},
        "container_hints": {"hint|Ярмарка/payments": "container"},
        "edges": {"edge|Ярмарка/web|Ярмарка/orders|создать заказ|target": {"to_path": "Ярмарка / orders / api"}},
        "merges": {"pair|Ярмарка/billing|Ярмарка/biling": {"name": "billing"}},
        "new_edges": [{"group_id": "group|Ярмарка/mailer", "from_path": "Ярмарка / mailer", "to_path": "Ярмарка / orders"}],
    }

    await tools.call(
        "archmap_import_apply",
        {"name": "Z", "files": [{"name": "a.yaml", "content": "x"}], "decisions": decisions},
        client,
    )

    body = api.calls[-1].content
    assert b'name="decisions"' in body
    assert json.dumps(decisions, ensure_ascii=False).encode() in body


async def test_без_decisions_поля_формы_нет(client: ArchMapClient, api: FakeApi) -> None:
    api.post(APPLY_PATH, result())

    await tools.call("archmap_import_apply", {"name": "Z", "files": [{"name": "a.yaml", "content": "x"}]}, client)

    assert b'name="decisions"' not in api.calls[-1].content


async def test_кривой_decisions_отказ_словами_сервера(client: ArchMapClient, api: FakeApi) -> None:
    detail = "Поле decisions: неизвестный раздел «answers»"
    api.post(APPLY_PATH, httpx.Response(400, json={"detail": detail}))

    with pytest.raises(ArchMapError) as exc:
        await tools.call(
            "archmap_import_apply",
            {"name": "Z", "files": [{"name": "a.yaml", "content": "x"}], "decisions": {"answers": {}}},
            client,
        )

    assert detail in str(exc.value)
    with pytest.raises(ArchMapError, match="decisions — объект"):
        await tools.call(
            "archmap_import_apply",
            {"name": "Z", "files": [{"name": "a.yaml", "content": "x"}], "decisions": ["fields"]},
            client,
        )


def test_описания_ввоза_говорят_о_вопросах_и_decisions() -> None:
    for catalog in (tools.BY_NAME, tools.REMOTE_BY_NAME):
        assert "ВОПРОСЫ РАЗБОРА" in catalog["archmap_import_preview"]["description"]
        assert "MCP не задаёт" not in catalog["archmap_import_preview"]["description"]
        apply = catalog["archmap_import_apply"]
        assert "decisions" in apply["description"] and "decisions" in apply["schema"]["properties"]
