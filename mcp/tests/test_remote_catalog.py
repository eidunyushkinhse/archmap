"""Удалённый набор инструментов (docs/plan-remote-mcp.md, Р5, Р6).

В удалённом режиме «диск агента» — это диск СЕРВЕРА ArchMap: инструменты с файлами
убраны, а аргументы-пути отвергаются на диспетчере ДО любого обработчика — схема их не
объявляет, но SDK лишних свойств не запрещает.
"""

from __future__ import annotations

import builtins
import json
from pathlib import Path
from typing import Any

import pytest
from conftest import FakeApi

from archmap_mcp import tools
from archmap_mcp.client import ArchMapClient, ArchMapError

TESTS = Path(__file__).resolve().parent


def test_флаг_writes_у_каждого_и_локальные_имена_без_опечаток() -> None:
    assert all(isinstance(t["writes"], bool) for t in tools.TOOLS)
    assert tools.LOCAL_ONLY <= set(tools.BY_NAME)


def test_удалённый_набор_без_локальных_и_только_чтение_без_пишущих() -> None:
    full = [t["name"] for t in tools.remote_catalog(read_only=False)]
    reader = [t["name"] for t in tools.remote_catalog(read_only=True)]
    # Числа — от флагов, а не руками: 31 − 3 локальных = 28, читающих среди них — 13.
    assert full == [t["name"] for t in tools.TOOLS if t["name"] not in tools.LOCAL_ONLY]
    assert reader == [n for n in full if not tools.BY_NAME[n]["writes"]]
    assert (len(full), len(reader)) == (28, 13)
    assert set(reader) <= set(full) and not set(full) & tools.LOCAL_ONLY


def test_удалённые_описания_и_схемы_не_зовут_к_диску() -> None:
    for t in tools.remote_catalog(read_only=False):
        text = json.dumps({"d": t["description"], "s": t["schema"]}, ensure_ascii=False)
        for word in [*tools.LOCAL_ONLY, "paths", "out_path", "с диска", "С ДИСКА"]:
            assert word not in text, (t["name"], word)


def test_удалённый_ввоз_принимает_yaml_текстом() -> None:
    for name in ("archmap_import_preview", "archmap_import_apply"):
        schema = tools.REMOTE_BY_NAME[name]["schema"]
        assert "files" in schema["required"] and "paths" not in schema["properties"]
    # локальный вариант прежний
    assert "paths" in tools.BY_NAME["archmap_import_apply"]["schema"]["properties"]


def test_каждый_инструмент_чтения_исполняется_в_тестах() -> None:
    """Сторож «чтение шлёт только GET» (conftest.reads_send_only_get) видит лишь те
    инструменты, что тесты исполняют: новый инструмент чтения без сценария он бы
    пропустил молча."""
    source = "\n".join(p.read_text(encoding="utf-8") for p in TESTS.glob("test_*.py") if p.name != Path(__file__).name)
    missing = [t["name"] for t in tools.TOOLS if not t["writes"] and f'"{t["name"]}"' not in source]
    assert missing == []


@pytest.fixture
def no_disk(monkeypatch: pytest.MonkeyPatch) -> None:
    """Файловая система, падающая при любом обращении: отказ обязан случиться раньше."""

    def boom(*_a: Any, **_k: Any) -> Any:
        raise AssertionError("удалённый вызов тронул файловую систему")

    for attr in ("read_bytes", "read_text", "is_file", "exists", "stat", "open", "write_bytes", "mkdir"):
        monkeypatch.setattr(Path, attr, boom)
    monkeypatch.setattr(builtins, "open", boom)


@pytest.mark.parametrize(
    ("name", "args"),
    [
        ("archmap_export_archive", {"project": "Ярмарка", "out_path": "/data/x.zip"}),
        ("archmap_import_into_preview", {"project": "Ярмарка", "paths": ["/etc/passwd"]}),
        ("archmap_import_into_apply", {"project": "Ярмарка", "paths": ["/a.zip"], "base_graph_rev": 1, "base_meta_rev": 1}),
        ("archmap_import_preview", {"files": [{"name": "a.yaml", "content": "x"}], "paths": ["/data/secret.key"]}),
        ("archmap_import_apply", {"name": "Новый", "paths": ["/etc/shadow"]}),
        ("archmap_export", {"project": "Ярмарка", "out_path": "/tmp/x.yaml"}),
        ("archmap_projects", {"paths": []}),
    ],
)
async def test_диск_в_удалённом_вызове_отказ_до_обработчика(
    name: str, args: dict[str, Any], client: ArchMapClient, api: FakeApi, no_disk: None
) -> None:
    with pytest.raises(ArchMapError) as exc:
        await tools.call_remote(name, args, client, read_only=False)
    assert "в подключении по адресу" in str(exc.value)
    assert api.calls == []


async def test_только_чтение_отказ_пишущему_до_обработчика(client: ArchMapClient, api: FakeApi) -> None:
    with pytest.raises(ArchMapError) as exc:
        await tools.call_remote("archmap_create_node", {"project": "Ярмарка", "name": "x"}, client, read_only=True)
    assert str(exc.value).startswith("Токен только для чтения: archmap_create_node меняет данные.")
    assert api.calls == []


async def test_удалённый_вызов_чтения_работает(client: ArchMapClient, api: FakeApi) -> None:
    out = await tools.call_remote("archmap_projects", {}, client, read_only=True)
    assert "Ярмарка" in out


async def test_неизвестный_инструмент_в_удалённом_режиме(client: ArchMapClient) -> None:
    with pytest.raises(ArchMapError, match="Неизвестный инструмент: archmap_nope"):
        await tools.call_remote("archmap_nope", {}, client, read_only=False)
