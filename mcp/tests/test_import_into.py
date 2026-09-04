"""Догрузка архивов к ЖИВОМУ проекту: диффом, аддитивно, под fence по ревизиям."""

from __future__ import annotations

import io
import zipfile
from pathlib import Path
from typing import Any

import httpx
import pytest
from conftest import PROJECT_ID, FakeApi
from test_unified_import import conflict, dump

from archmap_mcp import tools
from archmap_mcp.client import ArchMapClient, ArchMapError

PREVIEW_PATH = f"/projects/{PROJECT_ID}/import-archive/preview"
APPLY_PATH = f"/projects/{PROJECT_ID}/import-archive/apply"


def archive(tmp_path: Path, name: str = "arch.zip") -> Path:
    path = tmp_path / name
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("manifest.yaml", "archmap-archive: 1\n")
    path.write_bytes(buf.getvalue())
    return path


def preview(**over: Any) -> dict[str, Any]:
    fields: dict[str, Any] = {
        "ok": True, "nodes_new": 2, "nodes_new_paths": ["Ярмарка / Новый сервис"],
        "edges_new": 1, "base_graph_rev": 41, "base_meta_rev": 17,
    }
    fields.update(over)
    return dump("unified_import", "IntoPreviewOut", **fields)


async def test_превью_догрузки_печатает_дифф_и_обе_ревизии(
    client: ArchMapClient, api: FakeApi, tmp_path: Path
) -> None:
    api.post(PREVIEW_PATH, preview(families={"docs": 6}))

    out = await tools.call(
        "archmap_import_into_preview",
        {"project": "Ярмарка", "paths": [str(archive(tmp_path))]},
        client,
    )

    assert "объектов 2" in out and "связей 1" in out
    assert "Ярмарка / Новый сервис" in out
    assert "схем логики 6" in out
    # Fence обязан быть НАЗВАН числами: без него применение — слепая запись
    # поверх чужой параллельной правки.
    assert "base_graph_rev=41" in out and "base_meta_rev=17" in out
    assert "409" in out
    assert "Ничего не записано" in out
    assert api.calls[-1].headers["X-Project-Id"] == PROJECT_ID
    assert b'filename="arch.zip"' in api.calls[-1].content


async def test_спор_с_живым_показывает_текущего_кандидата(
    client: ArchMapClient, api: FakeApi, tmp_path: Path
) -> None:
    """Дефолт спора с живым — «оставить моё»; агент обязан видеть, какой кандидат
    из проекта, иначе выберет перезапись вслепую."""
    live = conflict(
        default="cand:0",
        allow_all=False,
        candidates=[
            {"origin": 0, "origin_label": "текущий проект", "summary": "40 строк",
             "body": "flowchart TD", "truncated": False, "current": True},
            {"origin": 1, "origin_label": "arch.zip", "summary": "12 строк",
             "body": "flowchart LR", "truncated": False},
        ],
    )
    api.post(PREVIEW_PATH, preview(family_conflicts=[live]))

    out = await tools.call(
        "archmap_import_into_preview",
        {"project": "Ярмарка", "paths": [str(archive(tmp_path))]},
        client,
    )

    assert "[текущий в проекте]" in out
    assert "по умолчанию: cand:0" in out
    assert "archmap_import_into_apply" in out


async def test_применение_шлёт_ревизии_и_резолюции_полями_формы(
    client: ArchMapClient, api: FakeApi, tmp_path: Path
) -> None:
    api.post(APPLY_PATH, dump(
        "unified_import", "IntoApplyOut", project_id=PROJECT_ID, nodes_created=2,
        nodes_filled=1, edges_created=1, docs_created=6, docs_replaced=1,
        specs_applied=2, params_replaced=0, resolved_conflicts=1,
        graph_rev=42, meta_rev=18,
        warnings=["процесс «Заказ» приехал под именем «Заказ (2)»"],
    ))

    out = await tools.call(
        "archmap_import_into_apply",
        {
            "project": "Ярмарка", "paths": [str(archive(tmp_path))],
            "resolutions": {"doc|A|B": "cand:1"},
            "base_graph_rev": 41, "base_meta_rev": 17,
        },
        client,
    )

    body = api.calls[-1].content
    assert b'name="base_graph_rev"' in body and b"41" in body
    assert b'name="base_meta_rev"' in body and b"17" in body
    assert b'name="resolutions"' in body and b"cand:1" in body
    assert "создано 2" in out and "дополнено 1" in out
    assert "заменено 1" in out
    assert "Разрешено споров содержимого: 1" in out
    assert "graph_rev=42" in out and "meta_rev=18" in out
    assert "приехал под именем" in out


async def test_расхождение_ревизий_говорит_перечитать_превью(
    client: ArchMapClient, api: FakeApi, tmp_path: Path
) -> None:
    api.routes[("POST", APPLY_PATH)] = httpx.Response(
        409, json={"detail": "Проект изменился после расчёта — обновите превью и повторите"}
    )

    with pytest.raises(ArchMapError) as exc:
        await tools.call(
            "archmap_import_into_apply",
            {"project": "Ярмарка", "paths": [str(archive(tmp_path))],
             "base_graph_rev": 1, "base_meta_rev": 1},
            client,
        )

    assert "Конфликт версий" in str(exc.value) and "перечитайте" in str(exc.value)


async def test_догрузка_без_входов_не_ходит_на_сервер(
    client: ArchMapClient, api: FakeApi
) -> None:
    with pytest.raises(ArchMapError):
        await tools.call("archmap_import_into_preview", {"project": "Ярмарка"}, client)

    assert all("import-archive" not in c.url.path for c in api.calls)


async def test_yaml_к_живому_проекту_отправляют_синком(
    client: ArchMapClient, api: FakeApi, tmp_path: Path
) -> None:
    """Догрузка принимает только архивы. YAML в существующий проект — синк: у него
    свои политики имён и пропаж, мердж архивов их не заменяет (бэкенд такой вход
    и не примет). Отказ обязан НАЗВАТЬ верный инструмент, иначе агент упрётся."""
    yaml_path = tmp_path / "схема.yaml"
    yaml_path.write_text("nodes: []\n", encoding="utf-8")

    with pytest.raises(ArchMapError) as exc:
        await tools.call(
            "archmap_import_into_preview",
            {"project": "Ярмарка", "paths": [str(yaml_path)]},
            client,
        )

    assert "archmap_sync" in str(exc.value)
    assert all("import-archive" not in c.url.path for c in api.calls)


def test_догрузка_не_обещает_агенту_текстовый_вход() -> None:
    # Класс «инструмент рекламирует то, чего бэкенд не умеет»: files здесь давал бы
    # 400 на живом сервере, а по схеме выглядел бы законным входом.
    for name in ("archmap_import_into_preview", "archmap_import_into_apply"):
        tool = next(t for t in tools.TOOLS if t["name"] == name)
        props = tool["schema"]["properties"]
        assert "files" not in props
        assert "paths" in props
        assert "paths" in tool["schema"]["required"]
        assert "archmap_sync" in tool["description"]
