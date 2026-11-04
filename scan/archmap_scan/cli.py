"""Командная строка сборщика (ТЗ §3): ключи, справка на русском, коды выхода.

Коды выхода: 0 — результат записан (даже если найдено мало), 1 — ошибка (пути нет, каталог
вывода занят чужими файлами, разбор упал). Разбор ключей свой, а не argparse: все тексты,
включая ошибки ключей, обязаны быть по-русски и лежать в texts.py.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field

from archmap_scan import __version__, texts

# Наименьший Python, на котором сборщик обещает работать (ТЗ §3).
MIN_PYTHON = (3, 10)
_VALUE_OPTS = ("--system", "--out", "--exclude", "--include")
_FLAGS = ("--no-git", "--json", "--version", "--help", "-h")


class UsageError(Exception):
    """Ошибка в ключах командной строки (текст для человека)."""


@dataclass
class Args:
    path: str = "."
    system: str | None = None
    out: str = "archmap-scan"
    excludes: list[str] = field(default_factory=list)
    includes: list[str] = field(default_factory=list)
    no_git: bool = False
    json: bool = False
    version: bool = False
    help: bool = False


def parse_args(argv: list[str]) -> Args:
    args = Args()
    paths: list[str] = []
    i = 0
    while i < len(argv):
        item = argv[i]
        i += 1
        if item == "--":
            paths.extend(argv[i:])
            break
        name, eq, inline = item.partition("=") if item.startswith("--") else (item, "", "")
        if name in _VALUE_OPTS:
            if eq:
                value = inline
            elif i < len(argv):
                value = argv[i]
                i += 1
            else:
                raise UsageError(texts.option_needs_value(name))
            _set_value(args, name, value)
        elif name in _FLAGS:
            if eq:
                raise UsageError(texts.flag_takes_no_value(name))
            _set_flag(args, name)
        elif item.startswith("-") and item != "-":
            raise UsageError(texts.unknown_option(name))
        else:
            paths.append(item)
    if len(paths) > 1:
        raise UsageError(texts.TOO_MANY_PATHS)
    if paths:
        args.path = paths[0]
    return args


def _set_value(args: Args, name: str, value: str) -> None:
    if name == "--system":
        if not value.strip():
            raise UsageError(texts.EMPTY_SYSTEM)
        args.system = value.strip()
    elif name == "--out":
        args.out = value
    elif name == "--exclude":
        args.excludes.append(value)
    else:
        args.includes.append(value)


def _set_flag(args: Args, name: str) -> None:
    if name == "--no-git":
        args.no_git = True
    elif name == "--json":
        args.json = True
    elif name == "--version":
        args.version = True
    else:
        args.help = True


def run(argv: list[str]) -> int:
    """Разобрать ключи, запустить сборщик, напечатать итог. Возвращает код выхода."""
    try:
        args = parse_args(argv)
    except UsageError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    if args.help:
        print(texts.HELP.format(product=texts.PRODUCT, version=__version__), end="")
        return 0
    if args.version:
        print(__version__)
        return 0

    import json
    from pathlib import Path

    from archmap_scan.output.outdir import OutDirError
    from archmap_scan.scan import Options
    from archmap_scan.scan import run as run_scan

    path = Path(args.path)
    if not path.exists():
        print(texts.path_not_found(args.path), file=sys.stderr)
        return 1
    if not path.is_dir():
        print(texts.path_not_dir(args.path), file=sys.stderr)
        return 1
    opts = Options(
        path=args.path,
        out=args.out,
        system=args.system,
        excludes=tuple(args.excludes),
        includes=tuple(args.includes),
        use_git=not args.no_git,
    )
    try:
        result = run_scan(opts)
    except OutDirError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except Exception as exc:  # разбор упал целиком: код 1 и понятный текст (ТЗ §3)
        print(texts.crashed(f"{type(exc).__name__}: {exc}"), file=sys.stderr)
        return 1
    if args.json:
        doc = {"out": str(result.out), "coverage": result.coverage.as_json()}
        print(json.dumps(doc, ensure_ascii=False, indent=2))
    else:
        print(result.summary, end="")
        print(texts.written_to(str(result.out)))
    return 0


def main(argv: list[str] | None = None) -> None:
    """Точка входа archmap-scan.pyz и python -m archmap_scan."""
    # Версия проверяется первой: модули сборщика написаны под Python 3.10, и на старом
    # интерпретаторе человек получил бы трассировку синтаксиса вместо понятного текста.
    if tuple(sys.version_info[:2]) < MIN_PYTHON:
        found = ".".join(str(p) for p in sys.version_info[:3])
        print(texts.python_too_old(found), file=sys.stderr)
        sys.exit(1)
    sys.exit(run(sys.argv[1:] if argv is None else argv))
