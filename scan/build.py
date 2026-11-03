#!/usr/bin/env python3
"""Сборка scan/dist/archmap-scan.pyz (ТЗ §3): один файл для python3 3.10 и новее.

Формат zipapp: строка shebang и zip-архив с __main__.py в корне. Внутри пакет archmap_scan
и чистая Python-часть PyYAML из site-packages того интерпретатора, которым запущен скрипт
(без _yaml*.so, __pycache__ и dist-info). Сборка воспроизводима: записи отсортированы, даты
и права у всех записей одинаковые, поэтому одинаковые исходники дают одинаковый sha256.
zipapp.create_archive берёт даты из файлов, поэтому архив собирается через zipfile.

Запуск: python3 scan/build.py [--out ПУТЬ]
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import importlib.util
import io
import os
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PACKAGE = HERE / "archmap_scan"
TARGET = HERE / "dist" / "archmap-scan.pyz"
SHEBANG = b"#!/usr/bin/env python3\n"
# Самая ранняя дата, которую умеет zip: одинакова на любой машине и в любом часовом поясе.
ZIP_DATE = (1980, 1, 1, 0, 0, 0)
MAIN = b"from archmap_scan.cli import main\n\nmain()\n"


def _python_files(root: Path, prefix: str) -> list[tuple[str, bytes]]:
    out: list[tuple[str, bytes]] = []
    for path in sorted(root.rglob("*.py")):
        rel = path.relative_to(root)
        if "__pycache__" in rel.parts:
            continue
        out.append((f"{prefix}/{rel.as_posix()}", path.read_bytes()))
    return out


def yaml_dir() -> Path:
    spec = importlib.util.find_spec("yaml")
    if spec is None or not spec.submodule_search_locations:
        raise SystemExit(
            f"PyYAML не найден у интерпретатора {sys.executable}: установите его "
            "(pip install PyYAML) или запустите сборку другим python3."
        )
    return Path(next(iter(spec.submodule_search_locations)))


def yaml_license() -> bytes | None:
    """Текст лицензии PyYAML (MIT требует класть его в копии) из метаданных пакета."""
    try:
        dist = importlib.metadata.distribution("PyYAML")
    except importlib.metadata.PackageNotFoundError:
        return None
    for item in dist.files or []:
        if Path(str(item)).name.upper().startswith(("LICENSE", "COPYING")):
            path = Path(str(dist.locate_file(item)))
            if path.is_file():
                return path.read_bytes()
    return None


def entries() -> list[tuple[str, bytes]]:
    files = _python_files(PACKAGE, "archmap_scan") + _python_files(yaml_dir(), "yaml")
    files.append(("__main__.py", MAIN))
    license_text = yaml_license()
    if license_text is not None:
        files.append(("LICENSE.PyYAML", license_text))
    else:
        print("Внимание: файл лицензии PyYAML не найден, в архив он не попал.", file=sys.stderr)
    return sorted(files)


def archive(files: list[tuple[str, bytes]]) -> bytes:
    buf = io.BytesIO()
    buf.write(SHEBANG)
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in files:
            info = zipfile.ZipInfo(name, date_time=ZIP_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3  # unix: права записи одинаковы на любой ОС сборки
            info.external_attr = 0o644 << 16
            zf.writestr(info, data, compresslevel=9)
    return buf.getvalue()


def build(target: Path = TARGET) -> tuple[int, str]:
    """Собрать файл; вернуть размер и sha256."""
    blob = archive(entries())
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_bytes(blob)
    tmp.chmod(0o755)
    os.replace(tmp, target)
    return len(blob), hashlib.sha256(blob).hexdigest()


def main(argv: list[str]) -> int:
    target = TARGET
    if argv[:1] == ["--out"] and len(argv) == 2:
        target = Path(argv[1]).resolve()
    elif argv:
        print("Запуск: python3 scan/build.py [--out ПУТЬ]", file=sys.stderr)
        return 2
    size, digest = build(target)
    print(f"{target}")
    print(f"размер {size} байт")
    print(f"sha256 {digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
