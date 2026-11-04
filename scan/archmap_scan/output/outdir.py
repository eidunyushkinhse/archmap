"""Каталог вывода и маркер владения им (ТЗ §5).

Существующий каталог без маркера сборщик не трогает: там могут лежать чужие файлы. С
маркером каталог перезаписывается целиком, чтобы от прошлого запуска не осталось файлов
объектов, которых больше нет. Пустой существующий каталог принимается как свой.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from archmap_scan import __version__, texts
from archmap_scan.walk import MARKER


class OutDirError(Exception):
    """Каталог вывода занят чужими файлами или это не каталог."""


def check(out: Path) -> None:
    """Отказать заранее, до обхода репозитория, если каталог занят чужими файлами."""
    if out.is_symlink() or (out.exists() and not out.is_dir()):
        raise OutDirError(texts.out_not_dir(str(out)))
    if out.is_dir() and not (out / MARKER).is_file() and any(out.iterdir()):
        raise OutDirError(texts.out_busy(str(out)))


def prepare(out: Path) -> None:
    """Подготовить каталог: создать или очистить свой, отказать в чужом."""
    check(out)
    if out.is_dir() and (out / MARKER).is_file():
        for child in sorted(out.iterdir()):
            if child.is_dir() and not child.is_symlink():
                shutil.rmtree(child)
            else:
                child.unlink()
    out.mkdir(parents=True, exist_ok=True)
    write(out, MARKER, f"archmap-scan {__version__}\n{texts.MARKER}")


def write(out: Path, rel: str, text: str) -> None:
    """Записать текстовый файл вывода (UTF-8, переводы строк \\n)."""
    target = out / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
