"""Единый импорт: N входов любого типа, споры содержимого, имя из манифеста.

Фикстуры ответов строятся СХЕМАМИ БЭКЕНДА и сериализуются ими же: подменённый
транспорт формы не проверяет, и «почти такой» словарь прятал бы расхождение до
живого сервера (ловушка, ради которой заведён conftest.backend).
"""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from typing import Any

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
