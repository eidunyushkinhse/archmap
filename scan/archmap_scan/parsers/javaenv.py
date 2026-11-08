"""Параметры конфигурации в коде Java (ТЗ §15 п. 14 Е4): System.getenv("X"),
System.getenv().get("X") и System.getenv().containsKey("X"), дефолт из второго аргумента
System.getenv().getOrDefault("X", "d"). Тип — по обёртке разбора (Integer.parseInt(…) —
int, Boolean.parseBoolean(…) — bool, Double.parseDouble(…) — float, Duration.parse(…) —
duration), иначе по дефолту. Имя константой раскрывается по правилам clike.py, иначе —
подсказка о динамическом имени.

System.getProperty — свойство JVM, а не окружение: не параметр. System.getenv() без
обращения по имени (вся карта окружения) параметра не даёт. Стек — пакет Java (pom.xml или
build.gradle без плагина Kotlin); каталоги тестов по имени не читаются (src/test/ исключён
обходом по соглашению).
"""

from __future__ import annotations

import re

from archmap_scan import clike, codebase, codetext, secrets
from archmap_scan.codetext import SP
from archmap_scan.context import Context
from archmap_scan.model import Findings
from archmap_scan.walk import Files

NAME = "java-env"
_NEEDLES = ("System.getenv",)
_GETENV = re.compile(r"System[ \t]*\.[ \t]*getenv[ \t]*\(")
# System.getenv() и обращение к карте окружения по имени.
_MAP = re.compile(rf"{SP}\){SP}\.{SP}(get|getOrDefault|containsKey){SP}\(")
_EMPTY = re.compile(rf"{SP}\)")
_SECOND = re.compile(rf'{SP}("[ ]*"){SP}\)')
_VAR = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,199}")
_TYPES = {
    "Integer.parseInt": "int", "Integer.valueOf": "int", "Long.parseLong": "int",
    "Long.valueOf": "int", "Short.parseShort": "int", "Boolean.parseBoolean": "bool",
    "Boolean.valueOf": "bool", "Double.parseDouble": "float", "Double.valueOf": "float",
    "Float.parseFloat": "float", "Float.valueOf": "float", "Duration.parse": "duration",
}


def _scan(
    files: Files, code: codetext.Code, rel: str, repo: clike.Repo, found: Findings,
) -> None:
    mask = code.mask
    for m in clike.matches(files, rel, _GETENV, mask) or []:
        pos = m.end()
        method = None
        bare = _MAP.match(mask, pos)
        if bare is not None:
            method, pos = bare.group(1), bare.end()
        elif _EMPTY.match(mask, pos):
            continue
        arg = clike.ARG.match(mask, pos)
        if arg is not None and arg.group("end") == "]":
            arg = None
        default: str | None = None
        has_default = False
        if method == "getOrDefault" and arg is not None and arg.group("end") == ",":
            has_default = True
            second = _SECOND.match(mask, arg.end())
            if second is not None:
                default = clike.literal_value(code, *second.span(1))
        type_ = clike.wrapped_type(mask, clike.chain_start(mask, m.start()), _TYPES)
        clike.read(
            found, repo, code, rel, pos, arg, NAME, _VAR, default=default,
            has_default=has_default, type_=type_ or secrets.value_type(default),
        )


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not codebase.stack_present(files, ctx, codebase.JAVA):
        return found
    found.applied.add(NAME)
    repo = clike.Repo(files, ctx, codebase.JAVA, codetext.JAVA)
    for rel, code in clike.sources(files, ctx, codebase.JAVA, codetext.JAVA, _NEEDLES, repo):
        _scan(files, code, rel, repo, found)
    return found
