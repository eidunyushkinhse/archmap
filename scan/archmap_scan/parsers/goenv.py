"""Параметры конфигурации в коде Go (ТЗ §6.2): os.Getenv("X"), os.LookupEnv("X") (чтение
с проверкой наличия, поэтому required), теги структур env:"X" (caarlos0/env,
sethvargo/go-envconfig: «X,required», «X,default=v») и envconfig:"X", дефолт из
envDefault:"v" и default:"v", required:"true". Поиск по маске кода (codetext.py); теги
читаются из сырых строк в обратных кавычках не длиннее 1000 символов."""

from __future__ import annotations

import re

from archmap_scan import codebase, codetext, secrets, texts
from archmap_scan.codetext import SP, STR
from archmap_scan.context import Context
from archmap_scan.model import CodeParam, Findings, Hint, Loc
from archmap_scan.walk import Files

NAME = "go-env"
_CALL = re.compile(rf"os[ \t]*\.[ \t]*(Getenv|LookupEnv)[ \t]*\({SP}({STR})?")
_RAW = re.compile(r"`[ \n]*`")
_VAR = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,199}")
_MAX_TAG = 1000
_NEEDLES = ("os.Getenv", "os.LookupEnv", 'env:"', 'envconfig:"')


def _tags(raw: str) -> dict[str, str]:
    """Теги структуры Go: «env:"X,required" envDefault:"v"» → {env: «X,required», …}.
    Разбор ручной: ключ — слово перед «:"», значение — до следующей кавычки."""
    out: dict[str, str] = {}
    pos = 0
    while True:
        colon = raw.find(':"', pos)
        if colon == -1:
            return out
        start = colon
        while start > 0 and colon - start < 64 and (raw[start - 1].isalnum() or raw[start - 1] == "_"):
            start -= 1
        end = raw.find('"', colon + 2)
        if end == -1:
            return out
        out.setdefault(raw[start:colon], raw[colon + 2:end])
        pos = end + 1


def _tag_param(rel: str, line: int, raw: str) -> CodeParam | None:
    tags = _tags(raw)
    spec = tags.get("env", tags.get("envconfig"))
    if not spec:
        return None
    name, *opts = [part.strip() for part in spec.split(",")]
    if not _VAR.fullmatch(name):
        return None
    default = tags.get("envDefault", tags.get("default"))
    for opt in opts:
        if opt.startswith("default="):
            default = opt[len("default="):]
    required = "required" in opts or tags.get("required") == "true"
    return CodeParam(
        name=name, loc=Loc(rel, line), parser=NAME, default=default,
        has_default=default is not None, required=True if required and default is None else None,
        type=secrets.value_type(default),
    )


def _scan(code: codetext.Code, rel: str, found: Findings) -> None:
    for m in _CALL.finditer(code.mask):
        if m.group(2) is None:
            found.hints.append(Hint("dynamic_names", {
                "kind": "config", "name": code.expression(m.end()),
                "reason": texts.REASON_DYNAMIC_PARAM, "source": str(Loc(rel, code.line(m.start()))),
            }))
            continue
        name, _dyn = code.literal(m.start(2), m.end(2))
        if _VAR.fullmatch(name):
            found.code_params.append(CodeParam(
                name=name, loc=Loc(rel, code.line(m.start())), parser=NAME,
                required=True if m.group(1) == "LookupEnv" else None,
            ))
    if 'env:"' not in code.text and 'envconfig:"' not in code.text:
        return
    for m in _RAW.finditer(code.mask):
        if m.end() - m.start() > _MAX_TAG:
            continue
        param = _tag_param(rel, code.line(m.start()), code.text[m.start() + 1:m.end() - 1])
        if param is not None:
            found.code_params.append(param)


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not codebase.stack_present(files, ctx, codebase.GO):
        return found
    found.applied.add(NAME)
    for rel, text in codebase.sources(files, ctx, codebase.GO, None, _NEEDLES):
        code = codetext.load(files, rel, text, codetext.GO)
        if code is not None:
            _scan(code, rel, found)
    return found
