"""Чтение архива знания: zip → манифест и файлы категорий.

Модуль — ЯДРО ввоза архивов: распаковка с капами от zip-бомбы, проверка манифеста
(ключ archmap-archive и версия формата) и выборка файлов категории по манифесту.
Применение знания к проекту живёт в едином импорте (unified_import/unified_apply,
docs/plan-unified-import.md): архив там — один из N входов вперемешку с голыми
YAML-схемами, и отдельного одноархивного пути больше нет.

Кривой zip/манифест — ArchiveError: ввоз невозможен целиком, человеческий текст
уходит наружу. Частичные проблемы (пропавший файл, неразрешённый адрес) сюда не
попадают — они едут замечаниями вызывающего.
"""

import io
import zipfile
from dataclasses import dataclass, field

import yaml

from app.archive_export import ARCHIVE_FORMAT

# Капы распаковки: архив приходит от пользователя, и zip умеет быть бомбой.
MAX_FILES = 2000
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_TOTAL_BYTES = 64 * 1024 * 1024


class ArchiveError(Exception):
    """Ошибка, по которой импорт невозможен целиком (кривой zip/манифест/C4).

    Человеческий текст — наружу как detail 400; частичные проблемы сюда не
    попадают, они едут замечаниями в отчёте."""


@dataclass
class _Archive:
    manifest: dict
    files: dict[str, str] = field(default_factory=dict)


def _read_zip(payload: bytes) -> _Archive:
    try:
        zf = zipfile.ZipFile(io.BytesIO(payload))
    except zipfile.BadZipFile as e:
        raise ArchiveError("Файл не читается как zip-архив") from e
    infos = zf.infolist()
    if len(infos) > MAX_FILES:
        raise ArchiveError(f"В архиве больше {MAX_FILES} файлов")
    total = 0
    files: dict[str, str] = {}
    for info in infos:
        if info.is_dir():
            continue
        if info.file_size > MAX_FILE_BYTES:
            raise ArchiveError(f"Файл «{info.filename}» больше {MAX_FILE_BYTES // 2**20} МБ")
        total += info.file_size
        if total > MAX_TOTAL_BYTES:
            raise ArchiveError(f"Распакованный архив больше {MAX_TOTAL_BYTES // 2**20} МБ")
        try:
            files[info.filename] = zf.read(info).decode("utf-8")
        except UnicodeDecodeError as e:
            raise ArchiveError(f"Файл «{info.filename}» — не текст в UTF-8") from e
    raw = files.get("manifest.yaml")
    if raw is None:
        raise ArchiveError("В архиве нет manifest.yaml — это не архив ArchMap")
    try:
        manifest = yaml.safe_load(raw)
    except yaml.YAMLError as e:
        raise ArchiveError("manifest.yaml не разбирается как YAML") from e
    if not isinstance(manifest, dict) or "archmap-archive" not in manifest:
        raise ArchiveError("manifest.yaml без ключа archmap-archive — это не архив ArchMap")
    version = manifest.get("archmap-archive")
    if not isinstance(version, int) or version > ARCHIVE_FORMAT:
        raise ArchiveError(
            f"Архив формата {version!r}, а этот сервер понимает до {ARCHIVE_FORMAT} — "
            "обновите ArchMap"
        )
    return _Archive(manifest=manifest, files=files)


def _listed(archive: _Archive, category: str) -> list[tuple[str, str]]:
    """Файлы категории по манифесту: (имя, содержимое). Пропавший из zip файл —
    в замечания вызывающего, тут просто пропуск не делаем — пусть упадёт KeyError?
    Нет: манифест мог отстать от архива руками человека — вернём то, что есть."""
    out = []
    listed = archive.manifest.get("contents", {}).get(category) or []
    for fname in listed:
        if isinstance(fname, str) and fname in archive.files:
            out.append((fname, archive.files[fname]))
    return out
