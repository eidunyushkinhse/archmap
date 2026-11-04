"""Без побочных эффектов (инвариант 1 ТЗ): ни сети, ни своих процессов, кроме перечня git,
ни записи вне каталога вывода."""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
from pathlib import Path
from typing import Any

import pytest

from archmap_scan.context import GIT_COMMANDS, run_git
from archmap_scan.scan import Options, run
from tests.helpers import FIXTURES, git


class _Recorder:
    def __init__(self) -> None:
        self.calls: list[list[str]] = []


def _snapshot(root: Path) -> dict[str, tuple[int, int]]:
    return {
        p.relative_to(root).as_posix(): (p.stat().st_size, p.stat().st_mtime_ns)
        for p in sorted(root.rglob("*")) if p.is_file()
    }


@pytest.fixture
def guarded(monkeypatch: pytest.MonkeyPatch) -> _Recorder:
    """Сеть запрещена, процессы записываются; os.system и os.popen запрещены."""
    recorder = _Recorder()
    real_popen = subprocess.Popen

    def no_network(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("сборщик открыл сокет")

    class RecordingPopen(real_popen):  # type: ignore[misc, valid-type]
        def __init__(self, args: Any, *rest: Any, **kwargs: Any) -> None:
            recorder.calls.append([str(a) for a in args])
            super().__init__(args, *rest, **kwargs)

    def forbidden(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("сборщик запустил команду мимо перечня")

    monkeypatch.setattr(socket, "socket", no_network)
    monkeypatch.setattr(socket, "create_connection", no_network)
    monkeypatch.setattr(subprocess, "Popen", RecordingPopen)
    monkeypatch.setattr(os, "system", forbidden)
    monkeypatch.setattr(os, "popen", forbidden)
    return recorder


def test_only_listed_git_commands_and_no_writes(tmp_path: Path, guarded: _Recorder) -> None:
    repo = tmp_path / "repo"
    shutil.copytree(FIXTURES / "yarmarka", repo)
    git(repo, "init", "-q")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "init")
    guarded.calls.clear()
    before = _snapshot(repo)
    out = tmp_path / "out"
    run(Options(path=str(repo), out=str(out), system="Ярмарка", use_git=True))
    assert _snapshot(repo) == before
    assert guarded.calls, "git не вызывался"
    for call in guarded.calls:
        assert call[:2] == ["git", "-C"], call
        assert tuple(call[3:]) in GIT_COMMANDS, call
    # Каталог вывода содержит только файлы сборщика.
    assert (out / ".archmap-scan").is_file()


def test_no_git_runs_no_processes(tmp_path: Path, guarded: _Recorder) -> None:
    before = _snapshot(FIXTURES / "yarmarka")
    run(Options(path=str(FIXTURES / "yarmarka"), out=str(tmp_path / "out"), use_git=False))
    assert guarded.calls == []
    assert _snapshot(FIXTURES / "yarmarka") == before


def test_run_git_refuses_unlisted_commands(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        run_git(tmp_path, ("fetch",))
    with pytest.raises(ValueError):
        run_git(tmp_path, ("rev-parse", "--show-toplevel", "--git-dir"))
    assert run_git(tmp_path / "missing", ("rev-parse", "HEAD")) is None
