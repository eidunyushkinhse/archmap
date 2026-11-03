"""Файл сборщика фактов archmap-scan.pyz, который раздаёт сервер (docs/tasks/fact-collector.md, §3).

Путь — настройка SCAN_FILE (app/config.py). Файл маленький (около 210 КБ): читается
целиком, sha256 и версия считаются один раз и держатся в памяти процесса по ключу (путь,
st_mtime_ns, st_size). dev.sh пересобирает файл рядом с работающим бэкендом, а сборка
заменяет его атомарно (os.replace): новый файл даёт новый ключ, и кэш это замечает. Ключ
и содержимое берутся с одного открытого файла, поэтому замена посреди чтения не смешивает
старую версию с новыми байтами.

Версия — строка __version__ из члена архива archmap_scan/__init__.py: сборщик не
импортируется и не выполняется. Файла нет, он не читается как zip или в нём нет версии
сборщика — ScanFileMissing (роутер отвечает 404).
"""

import hashlib
import io
import os
import re
import stat
import zipfile
from dataclasses import dataclass
from pathlib import Path
from threading import Lock

from app.config import settings

MISSING_DETAIL = "Сборщик фактов в эту поставку не входит"
FILE_NAME = "archmap-scan.pyz"
VERSION_MEMBER = "archmap_scan/__init__.py"
# Предел файла: собранный сборщик около 210 КБ; файл больше 16 МБ им не бывает, и в память
# процесса его не берём.
MAX_BYTES = 16 * 1024 * 1024
# Предел модуля с версией: в нём докстринг и одна строка.
MAX_VERSION_MEMBER = 64 * 1024
# Версия едет в заголовок ответа: только безопасные для заголовка символы.
_VERSION = re.compile(r"""^__version__\s*=\s*["']([0-9A-Za-z.+-]{1,32})["']\s*$""", re.MULTILINE)


class ScanFileMissing(Exception):
    """Файла сборщика в этой поставке нет или это не сборщик."""


@dataclass(frozen=True)
class ScanFile:
    data: bytes
    version: str
    sha256: str

    @property
    def size(self) -> int:
        return len(self.data)


_lock = Lock()
_cache: dict[tuple[str, int, int], ScanFile] = {}


def current() -> ScanFile:
    """Файл сборщика по настройке scan_file: из кэша, если он не менялся."""
    path = Path(settings.scan_file)
    try:
        with path.open("rb") as fh:
            st = os.fstat(fh.fileno())
            if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_BYTES:
                raise ScanFileMissing
            key = (str(path.resolve()), st.st_mtime_ns, st.st_size)
            with _lock:
                cached = _cache.get(key)
            if cached is not None:
                return cached
            data = fh.read(MAX_BYTES + 1)
    except OSError as exc:
        raise ScanFileMissing from exc
    loaded = _parse(data)
    with _lock:
        # Держим одну запись: прежние версии файла никому больше не нужны.
        _cache.clear()
        _cache[key] = loaded
    return loaded


def _parse(data: bytes) -> ScanFile:
    """Версия из архива и sha256 файла; не zip-архив сборщика — ScanFileMissing."""
    if len(data) > MAX_BYTES:
        raise ScanFileMissing
    try:
        # Перед zip-архивом zipapp стоит строка shebang: zipfile её пропускает сам.
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            info = archive.getinfo(VERSION_MEMBER)
            if info.file_size > MAX_VERSION_MEMBER:
                raise ScanFileMissing
            text = archive.read(info).decode("utf-8", "replace")
    except (zipfile.BadZipFile, KeyError, OSError, EOFError, ValueError, NotImplementedError) as exc:
        raise ScanFileMissing from exc
    found = _VERSION.search(text)
    if found is None:
        raise ScanFileMissing
    return ScanFile(data=data, version=found.group(1), sha256=hashlib.sha256(data).hexdigest())


def etag(scan: ScanFile) -> str:
    """Сильный ETag файла: его sha256 в кавычках."""
    return f'"{scan.sha256}"'


def etag_matches(header: str | None, scan: ScanFile) -> bool:
    """If-None-Match совпал с ETag файла: перечень через запятую, слабая форма W/"…" и «*»
    тоже считаются (RFC 9110, слабое сравнение для GET)."""
    if not header:
        return False
    wanted = etag(scan)
    for item in header.split(","):
        tag = item.strip()
        if tag == "*":
            return True
        if tag.startswith("W/"):
            tag = tag[2:]
        if tag == wanted:
            return True
    return False
