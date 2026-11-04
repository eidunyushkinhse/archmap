"""archmap_scan: сборщик фактов с сервера ArchMap на машине агента (фаза 3
docs/tasks/fact-collector.md).

Подпроцесс в большинстве тестов подменён (run_scanner): здесь проверяется, что уходит в
команду, как устроен кэш и что видит агент. Два теста запускают настоящий крошечный
zipapp тем же sys.executable -I -S, чтобы вызов был проверен по-настоящему: изоляция,
аргументы, таймаут с остановкой процесса.
"""

from __future__ import annotations

import hashlib
import sys
import zipapp
from pathlib import Path
from typing import Any

import httpx
import pytest
from conftest import FakeApi

from archmap_mcp import tools
from archmap_mcp.client import ArchMapClient, ArchMapError, Config

FILE = "/scan/archmap-scan.pyz"
PAYLOAD = b"#!/usr/bin/env python3\nPK-fake-archive"
SUMMARY = "Сборщик фактов ArchMap 0.1.0\n\nНайдено: 3 контейнера.\nЗаписано в "


def _serve(api: FakeApi, payload: bytes, *, version: str = "0.1.0", digest: str | None = None) -> None:
    api.get("/scan", {"version": version, "sha256": digest or hashlib.sha256(payload).hexdigest(), "size": len(payload)})
    api.get(FILE, httpx.Response(200, content=payload))


def _client(api: FakeApi, cache: Path, **extra: str) -> ArchMapClient:
    config = Config(
        {
            "ARCHMAP_URL": "http://archmap.test",
            "ARCHMAP_TOKEN": "archmap_test",
            "ARCHMAP_SCAN_DIR": str(cache),
            **extra,
        }
    )
    return ArchMapClient(config, http=httpx.AsyncClient(transport=httpx.MockTransport(api.handler())))


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    path = tmp_path / "repo"
    path.mkdir()
    (path / "docker-compose.yml").write_text("services: {}\n", encoding="utf-8")
    return path


@pytest.fixture
def cache(tmp_path: Path) -> Path:
    return tmp_path / "cache"


class FakeRunner:
    """Подмена run_scanner: пишет каталог вывода, как сборщик, и запоминает вызовы."""

    def __init__(self, code: int = 0, stderr: str = "") -> None:
        self.calls: list[tuple[list[str], Path, float]] = []
        self.code = code
        self.stderr = stderr

    async def __call__(self, argv: list[str], cwd: Path, timeout: float) -> tools.ScanRun:
        self.calls.append((argv, cwd, timeout))
        out = Path(argv[argv.index("--out") + 1])
        if self.code == 0:
            (out / "facts").mkdir(parents=True, exist_ok=True)
            (out / "agent").mkdir(exist_ok=True)
            (out / "schema.yaml").write_text("nodes: []\n", encoding="utf-8")
            for name in ("orders-db.tables.yaml", "events.channels.yaml", "orders.config.yaml"):
                (out / "facts" / name).write_text("# archmap-node: Ярмарка / x\n", encoding="utf-8")
        return tools.ScanRun(self.code, SUMMARY + str(out) + "\n", self.stderr)


@pytest.fixture
def runner(monkeypatch: pytest.MonkeyPatch) -> FakeRunner:
    fake = FakeRunner()
    monkeypatch.setattr(tools, "run_scanner", fake)
    return fake


def _downloads(api: FakeApi) -> int:
    return sum(1 for r in api.calls if r.url.path == f"/api/v1{FILE}")


async def test_скачивает_запускает_и_называет_файлы(
    api: FakeApi, repo: Path, cache: Path, runner: FakeRunner
) -> None:
    _serve(api, PAYLOAD)
    client = _client(api, cache)

    out = await tools.call(
        "archmap_scan",
        {"path": str(repo), "system": "Ярмарка", "excludes": ["legacy/", "**/gen/**"]},
        client,
    )

    [(argv, cwd, timeout)] = runner.calls
    pyz = cache / f"archmap-scan-0.1.0-{hashlib.sha256(PAYLOAD).hexdigest()[:12]}.pyz"
    target = repo.resolve() / "archmap-scan"
    assert argv == [
        sys.executable, "-I", "-S", "-X", "utf8", str(pyz), str(repo.resolve()), "--out", str(target),
        "--system", "Ярмарка", "--exclude", "legacy/", "--exclude", "**/gen/**",
    ]
    assert cwd == repo.resolve() and timeout == tools.SCAN_TIMEOUT_DEFAULT
    assert pyz.read_bytes() == PAYLOAD
    assert out.startswith(SUMMARY)
    assert f"Файлы (каталог {target}):" in out
    assert f"  • схема: {target / 'schema.yaml'}" in out
    assert f"{target / 'facts' / 'orders-db.tables.yaml'} (family tables)" in out
    assert f"{target / 'facts' / 'events.channels.yaml'} (family channels)" in out
    assert f"{target / 'facts' / 'orders.config.yaml'} (family config)" in out
    assert "archmap_import_preview" in out and "archmap_sync_preview" in out
    assert "archmap_facts_preview и archmap_facts_apply" in out
    assert str(target / "agent" / "hints.yaml") in out
    assert str(target / "coverage.yaml") in out


async def test_второй_вызов_берёт_файл_из_кэша(
    api: FakeApi, repo: Path, cache: Path, runner: FakeRunner
) -> None:
    _serve(api, PAYLOAD)
    client = _client(api, cache)

    await tools.call("archmap_scan", {"path": str(repo)}, client)
    await tools.call("archmap_scan", {"path": str(repo)}, client)

    assert _downloads(api) == 1 and len(runner.calls) == 2
    # Без system и excludes в команде их нет: имя сборщик берёт сам.
    assert "--system" not in runner.calls[1][0] and "--exclude" not in runner.calls[1][0]


async def test_испорченный_кэш_скачивается_заново(
    api: FakeApi, repo: Path, cache: Path, runner: FakeRunner
) -> None:
    _serve(api, PAYLOAD)
    cache.mkdir()
    (cache / f"archmap-scan-0.1.0-{hashlib.sha256(PAYLOAD).hexdigest()[:12]}.pyz").write_bytes(b"x")

    await tools.call("archmap_scan", {"path": str(repo)}, _client(api, cache))

    assert _downloads(api) == 1


async def test_sha256_не_сошёлся_отказ_и_кэш_пуст(
    api: FakeApi, repo: Path, cache: Path, runner: FakeRunner
) -> None:
    _serve(api, PAYLOAD, digest="0" * 64)

    with pytest.raises(ArchMapError, match="Файл сборщика пришёл повреждённым"):
        await tools.call("archmap_scan", {"path": str(repo)}, _client(api, cache))
    assert runner.calls == [] and not list(cache.glob("*.pyz"))


async def test_нет_файла_в_поставке_отказ_текстом_сервера(
    api: FakeApi, repo: Path, cache: Path, runner: FakeRunner
) -> None:
    api.get("/scan", httpx.Response(404, json={"detail": "Сборщик фактов в эту поставку не входит"}))

    with pytest.raises(ArchMapError, match="Сборщик фактов в эту поставку не входит"):
        await tools.call("archmap_scan", {"path": str(repo)}, _client(api, cache))
    assert runner.calls == []


async def test_непонятная_версия_с_сервера_в_имя_файла_не_идёт(
    api: FakeApi, repo: Path, cache: Path, runner: FakeRunner
) -> None:
    _serve(api, PAYLOAD, version="../../etc/x")

    with pytest.raises(ArchMapError, match="непонятные версию"):
        await tools.call("archmap_scan", {"path": str(repo)}, _client(api, cache))
    assert not cache.exists()


async def test_ошибка_сборщика_отказ_с_его_текстом(
    api: FakeApi, repo: Path, cache: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _serve(api, PAYLOAD)
    monkeypatch.setattr(tools, "run_scanner", FakeRunner(code=1, stderr="Каталог вывода занят чужими файлами\n"))

    with pytest.raises(ArchMapError) as exc:
        await tools.call("archmap_scan", {"path": str(repo)}, _client(api, cache))
    assert str(exc.value) == "Сборщик фактов завершился с ошибкой (код 1): Каталог вывода занят чужими файлами"


@pytest.mark.parametrize(
    ("args", "error"),
    [
        ({"path": "/нет/такого/каталога"}, "каталога репозитория нет"),
        ({"out_dir": "../outside"}, "каталог вывода задаётся внутри path"),
        ({"out_dir": "/tmp"}, "каталог вывода задаётся внутри path"),
        ({"out_dir": "link"}, "символическая ссылка"),
        ({"out_dir": "link/sub"}, "каталог вывода задаётся внутри path"),
    ],
)
async def test_пути_проверяются_до_сети(
    api: FakeApi, repo: Path, cache: Path, runner: FakeRunner, tmp_path: Path, args: dict[str, Any], error: str
) -> None:
    (tmp_path / "elsewhere").mkdir()
    (repo / "link").symlink_to(tmp_path / "elsewhere")

    with pytest.raises(ArchMapError, match=error):
        await tools.call("archmap_scan", {"path": str(repo), **args}, _client(api, cache))
    assert api.calls == [] and runner.calls == []


async def test_вывод_в_подкаталог_относительно_репозитория(
    api: FakeApi, repo: Path, cache: Path, runner: FakeRunner
) -> None:
    _serve(api, PAYLOAD)

    await tools.call("archmap_scan", {"path": str(repo), "out_dir": "build/scan"}, _client(api, cache))

    argv = runner.calls[0][0]
    assert argv[argv.index("--out") + 1] == str(repo.resolve() / "build" / "scan")


async def test_кривой_таймаут_в_настройках(
    api: FakeApi, repo: Path, cache: Path, runner: FakeRunner
) -> None:
    with pytest.raises(ArchMapError, match="ARCHMAP_SCAN_TIMEOUT=минута"):
        await tools.call("archmap_scan", {"path": str(repo)}, _client(api, cache, ARCHMAP_SCAN_TIMEOUT="минута"))


# ── Настоящий подпроцесс ─────────────────────────────────────────────────────

FAKE_SCANNER = '''
import sys
from pathlib import Path

args = sys.argv[1:]
out = Path(args[args.index("--out") + 1])
(out / "facts").mkdir(parents=True, exist_ok=True)
(out / "schema.yaml").write_text("nodes: []\\n", encoding="utf-8")
(out / "facts" / "orders-db.tables.yaml").write_text("tables: []\\n", encoding="utf-8")
print("Сборщик фактов ArchMap 0.0.1")
print(f"изоляция={sys.flags.isolated} без_site={sys.flags.no_site} utf8={sys.flags.utf8_mode}")
print("аргументы: " + " ".join(args[1:]))
print(f"Записано в {out}")
'''

SLEEPY_SCANNER = '''
import time
time.sleep(60)
'''


def _zipapp(tmp_path: Path, name: str, main: str) -> bytes:
    src = tmp_path / f"src-{name}"
    src.mkdir()
    (src / "__main__.py").write_text(main, encoding="utf-8")
    target = tmp_path / f"{name}.pyz"
    zipapp.create_archive(src, target, interpreter="/usr/bin/env python3")
    return target.read_bytes()


async def test_настоящий_zipapp_под_изоляцией(api: FakeApi, repo: Path, cache: Path, tmp_path: Path) -> None:
    _serve(api, _zipapp(tmp_path, "scanner", FAKE_SCANNER), version="0.0.1")

    out = await tools.call("archmap_scan", {"path": str(repo), "system": "Ярмарка"}, _client(api, cache))

    target = repo.resolve() / "archmap-scan"
    assert out.startswith("Сборщик фактов ArchMap 0.0.1\nизоляция=1 без_site=1 utf8=1\n")
    assert f"аргументы: --out {target} --system Ярмарка" in out
    assert (target / "schema.yaml").read_text(encoding="utf-8") == "nodes: []\n"
    assert f"{target / 'facts' / 'orders-db.tables.yaml'} (family tables)" in out


async def test_таймаут_останавливает_сборщик(api: FakeApi, repo: Path, cache: Path, tmp_path: Path) -> None:
    _serve(api, _zipapp(tmp_path, "sleepy", SLEEPY_SCANNER), version="0.0.2")
    client = _client(api, cache, ARCHMAP_SCAN_TIMEOUT="0.5")

    with pytest.raises(ArchMapError, match=r"не уложился в 0\.5 с и остановлен"):
        await tools.call("archmap_scan", {"path": str(repo)}, client)


async def test_вывод_сборщика_ограничен_в_памяти(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(tools, "SCAN_OUTPUT_CAP", 10)
    run = await tools.run_scanner(
        [sys.executable, "-I", "-S", "-c", "import sys; sys.stdout.write('x' * 200000)"], tmp_path, 30
    )
    assert run.code == 0 and run.stdout == "x" * 10
