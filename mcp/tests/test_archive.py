"""Архив проекта: выгрузка в файл, сводка манифеста, защита от перезаписи."""

from __future__ import annotations

import io
import zipfile
from pathlib import Path
from typing import Any

import httpx
import pytest
import yaml
from conftest import PROJECT_ID, FakeApi

from archmap_mcp import tools
from archmap_mcp.client import ArchMapClient, ArchMapError


def make_archive(**over: Any) -> bytes:
    """Zip той же формы, что собирает backend/app/archive_export.py: manifest.yaml
    с ключами archmap-archive / project / contents плюс сами файлы категорий."""
    manifest: dict[str, Any] = {
        "archmap-archive": 1,
        "project": {"name": "Маркетплейс «Ярмарка» v2", "description": "демо"},
        "contents": {
            "c4": "c4.yaml",
            "docs": ["docs/01-api.mmd", "docs/02-worker.mmd"],
            "db": ["db/01-orders.yaml"],
            "processes": [{"file": "processes/01-заказ.mmd", "name": "Заказ"}],
        },
    }
    manifest.update(over)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.yaml", yaml.safe_dump(manifest, allow_unicode=True))
        zf.writestr("c4.yaml", "nodes: []\n")
        for name in ("docs/01-api.mmd", "docs/02-worker.mmd"):
            zf.writestr(name, "flowchart TD\n")
        zf.writestr("db/01-orders.yaml", "tables: []\n")
        zf.writestr("processes/01-заказ.mmd", "sequenceDiagram\n")
    return buf.getvalue()


def serve(api: FakeApi, payload: bytes) -> None:
    api.routes[("GET", "/export/archive")] = httpx.Response(
        200, content=payload, headers={"content-type": "application/zip"}
    )


async def test_архив_пишется_в_файл_и_сводка_называет_состав(
    client: ArchMapClient, api: FakeApi, tmp_path: Path
) -> None:
    payload = make_archive()
    serve(api, payload)
    out = tmp_path / "вложенный" / "arch.zip"

    text = await tools.call(
        "archmap_export_archive", {"project": PROJECT_ID, "out_path": str(out)}, client
    )

    assert out.read_bytes() == payload  # байт-в-байт: архив — бэкап, не пересказ
    # Истинное имя проекта берётся из манифеста, а не из Content-Disposition
    # (там кириллица вычищена в ASCII-огрызок).
    assert "Маркетплейс «Ярмарка» v2" in text
    assert "схемы логики: 2" in text
    assert "структура БД: 1" in text
    assert "бизнес-процессы: 1" in text
    assert "схема C4: 1" in text
    assert str(out) in text
    assert api.calls[-1].headers["X-Project-Id"] == PROJECT_ID
    # Содержимого файлов в выводе нет — иначе весь проект уедет в контекст модели.
    assert "flowchart" not in text


async def test_существующий_файл_без_overwrite_отказ(
    client: ArchMapClient, api: FakeApi, tmp_path: Path
) -> None:
    serve(api, make_archive())
    out = tmp_path / "arch.zip"
    out.write_bytes("чужой бэкап".encode())

    with pytest.raises(ArchMapError) as exc:
        await tools.call(
            "archmap_export_archive", {"project": PROJECT_ID, "out_path": str(out)}, client
        )

    assert str(out) in str(exc.value)
    assert out.read_bytes() == "чужой бэкап".encode()


async def test_overwrite_перезаписывает(
    client: ArchMapClient, api: FakeApi, tmp_path: Path
) -> None:
    payload = make_archive()
    serve(api, payload)
    out = tmp_path / "arch.zip"
    out.write_bytes("старое".encode())

    await tools.call(
        "archmap_export_archive", {"project": PROJECT_ID, "out_path": str(out), "overwrite": True}, client
    )

    assert out.read_bytes() == payload


async def test_незнакомая_категория_манифеста_не_теряется(
    client: ArchMapClient, api: FakeApi, tmp_path: Path
) -> None:
    """Архив обгоняет MCP-сервер — ровно это и лечит эпик. Новая категория обязана
    показаться сырым ключом, а не исчезнуть из сводки."""
    serve(api, make_archive(contents={"c4": "c4.yaml", "мемуары": ["m/1.txt"]}))

    text = await tools.call(
        "archmap_export_archive", {"project": PROJECT_ID, "out_path": str(tmp_path / "a.zip")}, client
    )

    assert "мемуары: 1" in text


async def test_не_архив_в_ответе_даёт_понятную_ошибку(
    client: ArchMapClient, api: FakeApi, tmp_path: Path
) -> None:
    api.routes[("GET", "/export/archive")] = httpx.Response(200, content="не zip вовсе".encode())
    out = tmp_path / "a.zip"

    with pytest.raises(ArchMapError):
        await tools.call(
            "archmap_export_archive", {"project": PROJECT_ID, "out_path": str(out)}, client
        )

    assert not out.exists()  # мусор на диск не кладём
