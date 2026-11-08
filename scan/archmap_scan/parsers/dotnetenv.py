"""Параметры конфигурации в коде C# (ТЗ §15 п. 14 Е4): Configuration["X"] и
configuration["X"] (у builder.Configuration, _configuration и любого имени configuration;
ключ с двоеточием «A:B» — параметр с именем как написано) и
Environment.GetEnvironmentVariable("X"). Дефолт — литерал после «??»; «?? throw» — параметр
обязателен. Тип — по обёртке разбора (bool.TryParse(…) — bool, int.Parse(…) — int,
Convert.ToInt32(…) — int, TimeSpan.Parse(…) — duration), иначе по дефолту. Имя константой
раскрывается по правилам clike.py, иначе — подсказка о динамическом имени.

Configuration.GetSection("X") — раздел, а не параметр. Запись «Configuration["X"] = …»
не чтение. Подстановки интерполированных строк $"{configuration["X"]}/…" — код (маска
codetext.CS). Стек — проект .NET (*.csproj); каталоги тестов по имени (Cart.UnitTests/) не
читаются.
"""

from __future__ import annotations

import re

from archmap_scan import clike, codebase, codetext, secrets
from archmap_scan.codetext import SP
from archmap_scan.context import Context
from archmap_scan.model import Findings
from archmap_scan.walk import Files

NAME = "dotnet-env"
_NEEDLES = ("Configuration[", "configuration[", "GetEnvironmentVariable(")
_INDEX = re.compile(r"onfiguration[ \t]*\[")
_ENV = re.compile(r"GetEnvironmentVariable[ \t]*\(")
_ASSIGN = re.compile(rf"{SP}=(?!=)")
_COALESCE = re.compile(
    rf'{SP}\?\?{SP}(?:(?P<throw>throw)\b|(?P<lit>"[ ]*")(?!{SP}[+.\[(])|)'
)
# Ключ конфигурации .NET: имя переменной окружения или путь раздела через «:».
_VAR = re.compile(r"[A-Za-z_][A-Za-z0-9_:.\-]{0,199}")
_TYPES = {
    "bool.Parse": "bool", "bool.TryParse": "bool", "Boolean.Parse": "bool",
    "Boolean.TryParse": "bool", "int.Parse": "int", "int.TryParse": "int",
    "Int32.Parse": "int", "Int32.TryParse": "int", "long.Parse": "int", "long.TryParse": "int",
    "Int64.Parse": "int", "double.Parse": "float", "double.TryParse": "float",
    "float.Parse": "float", "decimal.Parse": "float", "Convert.ToInt32": "int",
    "Convert.ToInt64": "int", "Convert.ToBoolean": "bool", "Convert.ToDouble": "float",
    "TimeSpan.Parse": "duration", "TimeSpan.TryParse": "duration",
}


def _receiver(mask: str, end: int) -> tuple[int, str] | None:
    """Имя перед позицией end (без пробелов) и его начало."""
    stop = clike.skip_back(mask, end)
    start = clike.ident_before(mask, stop)
    return None if start is None else (start, mask[start:stop])


def _read(
    found: Findings, repo: clike.Repo, code: codetext.Code, rel: str, start: int, pos: int,
    arg: re.Match[str] | None,
) -> None:
    """Чтение с аргументом на позиции pos: дефолт и обязательность по «??» за ним."""
    default: str | None = None
    has_default = False
    required: bool | None = None
    if arg is not None:
        tail = _COALESCE.match(code.mask, arg.end())
        if tail is not None:
            if tail.group("throw"):
                required = True
            else:
                has_default = True
                if tail.group("lit"):
                    default = clike.literal_value(code, *tail.span("lit"))
    type_ = clike.wrapped_type(code.mask, clike.chain_start(code.mask, start), _TYPES)
    clike.read(
        found, repo, code, rel, pos, arg, NAME, _VAR, default=default, has_default=has_default,
        required=required, type_=type_ or secrets.value_type(default),
    )


def _scan(
    files: Files, code: codetext.Code, rel: str, repo: clike.Repo, found: Findings,
) -> None:
    mask = code.mask
    index = clike.matches(files, rel, _INDEX, mask)
    env = clike.matches(files, rel, _ENV, mask) if index is not None else None
    if index is None or env is None:
        return
    for m in index:
        bracket = m.end() - 1
        recv = _receiver(mask, bracket)
        if recv is None or recv[1].lstrip("_").lower() != "configuration":
            continue
        arg = clike.ARG.match(mask, m.end())
        if arg is not None:
            if arg.group("end") != "]":
                arg = None
            elif _ASSIGN.match(mask, arg.end()):
                continue
        _read(found, repo, code, rel, recv[0], m.end(), arg)
    for m in env:
        dot = clike.skip_back(mask, m.start())
        recv = _receiver(mask, dot - 1) if dot > 0 and mask[dot - 1] == "." else None
        if recv is None or recv[1] != "Environment":
            continue
        arg = clike.ARG.match(mask, m.end())
        if arg is not None and arg.group("end") == "]":
            arg = None
        if arg is not None and arg.group("end") == ",":
            # Второй аргумент — область окружения (EnvironmentVariableTarget): «??» не ищется.
            clike.read(found, repo, code, rel, m.end(), arg, NAME, _VAR)
            continue
        _read(found, repo, code, rel, recv[0], m.end(), arg)


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not codebase.stack_present(files, ctx, codebase.DOTNET):
        return found
    found.applied.add(NAME)
    repo = clike.Repo(files, ctx, codebase.DOTNET, codetext.CS)
    for rel, code in clike.sources(files, ctx, codebase.DOTNET, codetext.CS, _NEEDLES, repo):
        _scan(files, code, rel, repo, found)
    return found
