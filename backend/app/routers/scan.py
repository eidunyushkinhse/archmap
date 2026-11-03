"""Раздача сборщика фактов: /api/v1/scan (app/scan_file.py, docs/tasks/fact-collector.md, §3).

Без аутентификации, как /health: содержимое публичное (AGPL), а агенту иначе пришлось бы
носить токен в curl. Демо-режим раздачу не запрещает, ограничений частоты нет: файл
маленький и лежит в памяти процесса.

GET "" — версия, sha256 и размер; GET /archmap-scan.pyz — сам файл с ETag по sha256
(If-None-Match с тем же ETag даёт 304 без тела). Файла в поставке нет — 404 на обоих
адресах.
"""

from fastapi import APIRouter, Header, HTTPException, Response, status

from app import scan_file
from app.schemas.scan import ScanInfo

router = APIRouter(prefix="/scan", tags=["scan"])

_MISSING = {"description": scan_file.MISSING_DETAIL}


def _file() -> scan_file.ScanFile:
    try:
        return scan_file.current()
    except scan_file.ScanFileMissing as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=scan_file.MISSING_DETAIL) from exc


@router.get("", response_model=ScanInfo, responses={404: _MISSING})
def scan_info() -> ScanInfo:
    """Версия, sha256 и размер файла сборщика, который раздаёт этот сервер."""
    found = _file()
    return ScanInfo(version=found.version, sha256=found.sha256, size=found.size)


@router.get(
    f"/{scan_file.FILE_NAME}",
    response_class=Response,
    responses={
        200: {
            "description": "Файл сборщика фактов",
            "content": {"application/octet-stream": {"schema": {"type": "string", "format": "binary"}}},
        },
        304: {"description": "Файл не изменился (If-None-Match)"},
        404: _MISSING,
    },
)
def scan_download(if_none_match: str | None = Header(default=None)) -> Response:
    """Файл archmap-scan.pyz: запускается python3 archmap-scan.pyz в репозитории."""
    found = _file()
    headers = {
        "ETag": scan_file.etag(found),
        "Cache-Control": "no-cache",
        "X-ArchMap-Scan-Version": found.version,
    }
    if scan_file.etag_matches(if_none_match, found):
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    headers["Content-Disposition"] = f'attachment; filename="{scan_file.FILE_NAME}"'
    return Response(content=found.data, media_type="application/octet-stream", headers=headers)
