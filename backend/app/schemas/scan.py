"""Контракт раздачи сборщика фактов (app/scan_file.py, docs/tasks/fact-collector.md, §3)."""

from pydantic import BaseModel


class ScanInfo(BaseModel):
    """Файл archmap-scan.pyz, который раздаёт этот сервер: версия сборщика, sha256 и размер
    в байтах. Тот же sha256 стоит в ETag ответа с файлом."""

    version: str
    sha256: str
    size: int
