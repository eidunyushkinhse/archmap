"""Сборка archmap-scan.pyz: воспроизводимость и запуск собранного файла без site-packages."""

from __future__ import annotations

import hashlib
import importlib.util
import subprocess
import sys
import zipfile
from pathlib import Path
from types import ModuleType

from tests.helpers import FIXTURES

SCAN = Path(__file__).resolve().parent.parent


def _build_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("archmap_scan_build", SCAN / "build.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_build_is_reproducible_and_runs(tmp_path: Path) -> None:
    build = _build_module()
    size, digest = build.build(tmp_path / "a.pyz")
    _, again = build.build(tmp_path / "b.pyz")
    assert digest == again
    blob = (tmp_path / "a.pyz").read_bytes()
    assert len(blob) == size and hashlib.sha256(blob).hexdigest() == digest
    assert blob.startswith(b"#!/usr/bin/env python3\n")
    with zipfile.ZipFile(tmp_path / "a.pyz") as zf:
        names = zf.namelist()
    assert names == sorted(names)
    assert "__main__.py" in names and "archmap_scan/cli.py" in names
    assert "yaml/__init__.py" in names
    assert not any(n.endswith(".so") or "__pycache__" in n or "dist-info" in n for n in names)

    # -I -S: без site-packages, PyYAML только из архива.
    out = tmp_path / "out"
    done = subprocess.run(
        [sys.executable, "-I", "-S", str(tmp_path / "a.pyz"), str(FIXTURES / "yarmarka"),
         "--out", str(out), "--no-git", "--system", "Ярмарка"],
        capture_output=True, text=True, check=False,
    )
    assert done.returncode == 0, done.stderr
    expected = FIXTURES / "yarmarka.expected"
    listed = sorted(p.relative_to(out).as_posix() for p in out.rglob("*") if p.is_file())
    assert listed == sorted(
        p.relative_to(expected).as_posix() for p in expected.rglob("*") if p.is_file()
    )
    for path in sorted(expected.rglob("*")):
        if path.is_file():
            rel = path.relative_to(expected)
            assert (out / rel).read_bytes() == path.read_bytes(), rel
