"""Чтение нужных ключей TOML (pyproject.toml, Pipfile, Cargo.toml) на Python 3.10.

tomllib появился в 3.11. Если он есть, значения берутся им; иначе — ограниченный построчный
разбор: заголовки таблиц, «ключ = строка», массивы строк (в том числе в несколько строк) и
ключи встроенных таблиц. Номера строк ключей всегда даёт построчный разбор: tomllib их не
знает. Регулярные выражения линейные, без возвратов по экспоненте.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from typing import Any

_QUOTED = re.compile(r"\"((?:[^\"\\]|\\.)*)\"|'([^']*)'")


@dataclass
class Toml:
    """Таблицы документа: имя таблицы → ключ → значение (строка, список строк или словарь)."""

    tables: dict[str, dict[str, Any]] = field(default_factory=dict)
    lines: dict[tuple[str, str], int] = field(default_factory=dict)

    def get(self, table: str, key: str) -> Any:
        return self.tables.get(table, {}).get(key)

    def keys(self, table: str) -> list[str]:
        return list(self.tables.get(table, {}))

    def line(self, table: str, key: str) -> int | None:
        return self.lines.get((table, key))


def _unquote(raw: str) -> str:
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
        return raw[1:-1]
    return raw


def _strings(text: str) -> list[str]:
    return [m.group(1) if m.group(1) is not None else m.group(2) for m in _QUOTED.finditer(text)]


def parse_lite(text: str) -> Toml:
    """Построчный разбор подмножества TOML."""
    doc = Toml()
    table = ""
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        no = i + 1
        line = lines[i].strip()
        i += 1
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and "]" in line:
            table = _unquote(line.strip("[]").strip())
            doc.tables.setdefault(table, {})
            continue
        key, eq, value = line.partition("=")
        if not eq:
            continue
        key = _unquote(key)
        value = value.strip()
        parsed: Any
        if value.startswith("["):
            buf = value
            depth = buf.count("[") - buf.count("]")
            while depth > 0 and i < len(lines):
                nxt = lines[i].split("#", 1)[0] if "\"" not in lines[i] else lines[i]
                buf += "\n" + nxt
                depth += nxt.count("[") - nxt.count("]")
                i += 1
            parsed = _strings(buf)
        elif value.startswith("{"):
            inner = value.strip("{} ")
            parsed = {_unquote(part.split("=", 1)[0]): "" for part in inner.split(",") if "=" in part}
        else:
            strings = _strings(value)
            parsed = strings[0] if strings else value.split("#", 1)[0].strip()
        doc.tables.setdefault(table, {})[key] = parsed
        doc.lines[(table, key)] = no
    return doc


def _flatten(prefix: str, data: dict[str, Any], out: dict[str, dict[str, Any]]) -> None:
    here = out.setdefault(prefix, {})
    for key, value in data.items():
        here[key] = value
        if isinstance(value, dict):
            _flatten(f"{prefix}.{key}" if prefix else key, value, out)


def parse(text: str) -> Toml:
    """Значения через tomllib (3.11+), если он есть и документ валиден; строки — построчно."""
    lite = parse_lite(text)
    if sys.version_info >= (3, 11):
        import tomllib

        try:
            data = tomllib.loads(text)
        except (tomllib.TOMLDecodeError, RecursionError, ValueError):
            return lite
        tables: dict[str, dict[str, Any]] = {}
        _flatten("", data, tables)
        return Toml(tables=tables, lines=lite.lines)
    return lite
