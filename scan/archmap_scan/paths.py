"""Пути от корня репозитория: всегда POSIX, без «./», корень — пустая строка."""

from __future__ import annotations

import posixpath


def parent(rel: str) -> str:
    """Каталог файла: «a/b/c.yml» → «a/b», «c.yml» → «»."""
    head = posixpath.dirname(rel)
    return "" if head in (".", "") else head


def name(rel: str) -> str:
    return posixpath.basename(rel)


def join(base: str, rel: str) -> str | None:
    """Путь rel от каталога base, нормализованный. None — путь уходит выше корня или
    абсолютный (каталог сборки вне репозитория кодом этого репозитория не считается)."""
    if not rel or rel.startswith("/"):
        return None if rel.startswith("/") else base
    joined = posixpath.normpath(posixpath.join(base, rel) if base else rel)
    if joined == ".":
        return ""
    if joined == ".." or joined.startswith("../"):
        return None
    return joined


def under(rel: str, folder: str) -> bool:
    """Файл rel лежит в каталоге folder (корень «» содержит всё)."""
    return folder == "" or rel == folder or rel.startswith(folder + "/")


def show_dir(folder: str) -> str:
    """Каталог для людей: «services/orders/», корень — «./»."""
    return folder + "/" if folder else "./"
