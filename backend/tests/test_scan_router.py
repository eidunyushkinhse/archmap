"""Раздача сборщика фактов /api/v1/scan (app/scan_file.py, docs/tasks/fact-collector.md, §3).

Файл подставляется настройкой scan_file: временный zip с archmap_scan/__init__.py, как у
настоящего archmap-scan.pyz (shebang и архив). Без аутентификации и в демо-режиме тоже.
"""

import hashlib
import io
import os
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import scan_file
from app.config import settings
from app.main import app

FILE_URL = "/api/v1/scan/archmap-scan.pyz"
INFO_URL = "/api/v1/scan"


def _pyz(path: Path, version: str, extra: bytes = b"") -> bytes:
    buf = io.BytesIO()
    buf.write(b"#!/usr/bin/env python3\n")
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("__main__.py", "from archmap_scan.cli import main\n\nmain()\n")
        zf.writestr(
            "archmap_scan/__init__.py",
            f'"""Сборщик фактов ArchMap."""\n\n__version__ = "{version}"\n',
        )
        if extra:
            zf.writestr("archmap_scan/extra.py", extra)
    path.write_bytes(buf.getvalue())
    return buf.getvalue()


@pytest.fixture()
def client():
    return TestClient(app)


@pytest.fixture()
def pyz(tmp_path, monkeypatch) -> Path:
    path = tmp_path / "archmap-scan.pyz"
    _pyz(path, "9.9.9")
    monkeypatch.setattr(settings, "scan_file", str(path))
    return path


def test_файл_и_заголовки(client, pyz) -> None:
    r = client.get(FILE_URL)
    assert r.status_code == 200
    body = r.content
    digest = hashlib.sha256(body).hexdigest()
    assert body == pyz.read_bytes()
    assert r.headers["content-type"] == "application/octet-stream"
    assert r.headers["content-disposition"] == 'attachment; filename="archmap-scan.pyz"'
    assert r.headers["etag"] == f'"{digest}"'
    assert r.headers["cache-control"] == "no-cache"
    assert r.headers["x-archmap-scan-version"] == "9.9.9"
    info = client.get(INFO_URL)
    assert info.status_code == 200
    assert info.json() == {"version": "9.9.9", "sha256": digest, "size": len(body)}


def test_if_none_match_304_без_тела(client, pyz) -> None:
    etag = client.get(FILE_URL).headers["etag"]
    for header in (etag, f"W/{etag}", f'"other", {etag}', "*"):
        r = client.get(FILE_URL, headers={"If-None-Match": header})
        assert r.status_code == 304, header
        assert r.content == b""
        assert r.headers["etag"] == etag
    assert client.get(FILE_URL, headers={"If-None-Match": '"other"'}).status_code == 200


def test_нет_файла_404(client, tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(settings, "scan_file", str(tmp_path / "nowhere" / "archmap-scan.pyz"))
    for url in (FILE_URL, INFO_URL):
        r = client.get(url)
        assert r.status_code == 404
        assert r.json() == {"detail": "Сборщик фактов в эту поставку не входит"}


def test_не_zip_и_каталог_404(client, tmp_path, monkeypatch) -> None:
    junk = tmp_path / "archmap-scan.pyz"
    junk.write_bytes(b"#!/usr/bin/env python3\nprint('not a zip')\n")
    monkeypatch.setattr(settings, "scan_file", str(junk))
    assert client.get(FILE_URL).status_code == 404
    # zip без модуля версии сборщика — тоже не сборщик.
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("other.py", "x = 1\n")
    junk.write_bytes(buf.getvalue())
    assert client.get(INFO_URL).status_code == 404
    monkeypatch.setattr(settings, "scan_file", str(tmp_path))
    assert client.get(INFO_URL).status_code == 404


def test_подмена_файла_замечена(client, pyz) -> None:
    first = client.get(INFO_URL).json()
    assert first["version"] == "9.9.9"
    data = _pyz(pyz, "10.0.0", extra=b"y = 2\n")
    # Другая версия, новый mtime: кэш по (путь, mtime, размер) обязан это заметить.
    stamp = pyz.stat().st_mtime_ns + 1_000_000_000
    os.utime(pyz, ns=(stamp, stamp))
    second = client.get(INFO_URL).json()
    assert second == {
        "version": "10.0.0", "sha256": hashlib.sha256(data).hexdigest(), "size": len(data),
    }
    r = client.get(FILE_URL)
    assert r.content == data and r.headers["x-archmap-scan-version"] == "10.0.0"


def test_демо_режим_не_запрещает(client, pyz, monkeypatch) -> None:
    monkeypatch.setattr(settings, "demo_mode", True)
    assert client.get(FILE_URL).status_code == 200
    assert client.get(INFO_URL).status_code == 200


def test_версия_только_безопасными_символами(tmp_path, monkeypatch) -> None:
    path = tmp_path / "archmap-scan.pyz"
    _pyz(path, "1.0\\r\\nX-Evil: 1")
    monkeypatch.setattr(settings, "scan_file", str(path))
    with pytest.raises(scan_file.ScanFileMissing):
        scan_file.current()
