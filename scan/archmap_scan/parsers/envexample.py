"""Примеры окружения (ТЗ §6.1): .env.example, .env.sample, .env.template, .env.dist,
env.example. Имена и значения строк «ИМЯ=значение» (с «export» и кавычками); значение
держится только ради адреса зависимости и дефолта по инварианту 6. Настоящие файлы
окружения (.env, .env.local, .env.production) не открываются никогда."""

from __future__ import annotations

import re

from archmap_scan import paths
from archmap_scan.context import Context
from archmap_scan.model import EnvFile, EnvVar, Findings, Loc
from archmap_scan.parsers.compose import is_dynamic
from archmap_scan.walk import Files

NAME = "env-example"
EXAMPLE_NAMES = frozenset({".env.example", ".env.sample", ".env.template", ".env.dist", "env.example"})
_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_.]*")


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
    for rel in files.select(lambda p: paths.name(p) in EXAMPLE_NAMES):
        text = files.read(rel)
        if text is None:
            continue
        env = parse_text(rel, text)
        if env.vars:
            found.env_files.append(env)
    return found
