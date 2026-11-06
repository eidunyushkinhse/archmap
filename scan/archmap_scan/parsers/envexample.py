"""Примеры окружения (ТЗ §6.1): файл примера опознаётся по суффиксу (is_example):
.env.example, .env.sample, .env.template, .env.dist, env.example, .env.production.sample,
example.env, sample.env, template.env. Имена и значения строк «ИМЯ=значение» (с «export» и
кавычками); значение держится только ради адреса зависимости и дефолта по инварианту 6.
Настоящие файлы окружения без суффикса примера (.env, .env.local, .env.production) не
открываются никогда."""

from __future__ import annotations

import re

from archmap_scan import paths
from archmap_scan.context import Context
from archmap_scan.model import EnvFile, EnvVar, Findings, Loc
from archmap_scan.parsers.compose import is_dynamic
from archmap_scan.walk import Files

NAME = "env-example"
# Имя файла примера (инвариант §2 п. 6): «[.]env[.что-то].суффикс» или «суффикс.env». Имя
# файла короткое, перебор «.+» ограничен его длиной.
_EXAMPLE = re.compile(
    r"\.?env(?:\..+)?\.(?:example|sample|template|dist)|(?:example|sample|template)\.env"
)
_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_.]*")


def is_example(name: str) -> bool:
    """Файл окружения с суффиксом примера: его можно открыть. Без суффикса это настоящий
    файл окружения, его сборщик не открывает никогда."""
    return _EXAMPLE.fullmatch(name) is not None


def _value(raw: str) -> str:
    v = raw.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1]
    if " #" in v:
        v = v.split(" #", 1)[0].rstrip()
    return v


def parse_text(rel: str, text: str) -> EnvFile:
    out = EnvFile(path=rel, dir=paths.parent(rel), vars=[])
    seen: set[str] = set()
    for no, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        name, eq, value = line.partition("=")
        name = name.strip()
        if not eq or _NAME.fullmatch(name) is None or name in seen:
            continue
        seen.add(name)
        text_value = _value(value)
        out.vars.append(EnvVar(name, Loc(rel, no), text_value, is_dynamic(text_value)))
    return out


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    for rel in files.select(lambda p: is_example(paths.name(p))):
        text = files.read(rel)
        if text is None:
            continue
        env = parse_text(rel, text)
        if env.vars:
            found.env_files.append(env)
    return found
