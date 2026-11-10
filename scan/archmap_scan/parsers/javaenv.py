"""Параметры конфигурации в коде Java (ТЗ §15 п. 14 Е4): System.getenv("X"),
System.getenv().get("X") и System.getenv().containsKey("X"), дефолт из второго аргумента
System.getenv().getOrDefault("X", "d"). Тип — по обёртке разбора (Integer.parseInt(…) —
int, Boolean.parseBoolean(…) — bool, Double.parseDouble(…) — float, Duration.parse(…) —
duration), иначе по дефолту. Имя константой раскрывается по правилам clike.py, иначе —
подсказка о динамическом имени.

Optional.ofNullable(System.getenv("X")) (ТЗ §15 п. 17 Е3): дефолт из .orElse("d") и
.orElseGet(() -> "d") той же инструкции, .orElseThrow(…) — обязательный; тип по обёртке
снаружи Optional (Integer.parseInt(Optional…orElse("9465")) — int).

Kotlin (.kt пакетов Gradle с плагином Kotlin, Е3): те же вызовы; дефолт из элвиса «?: "d"»
(литерал строки, числа, true или false; выражение — дефолт есть, но не литерал), «?: throw» и
«?: error(…)» — обязательный, без элвиса и без безопасного вызова «?.» — обязательный; тип
по преобразованию сразу за вызовом (.toInt(), .toLong(), .toBoolean(), .toDouble() и
варианты OrNull), иначе по дефолту. Имя константой const val не раскрывается (подсказка).

System.getProperty — свойство JVM, а не окружение: не параметр. System.getenv() без
обращения по имени (вся карта окружения) параметра не даёт. Стек — пакет Java (pom.xml или
build.gradle без плагина Kotlin) или Kotlin; каталоги тестов по имени не читаются (src/test/
исключён обходом по соглашению).
"""

from __future__ import annotations

import re

from archmap_scan import clike, codebase, codetext, jvm, secrets
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
# Optional.ofNullable(System.getenv("X")) и хвост .orElse / .orElseGet / .orElseThrow.
_OPTIONAL_TAIL = re.compile(rf"{SP}\){SP}\.{SP}(orElse|orElseGet|orElseThrow){SP}\(")
_LAMBDA = re.compile(rf"{SP}\({SP}\){SP}->{SP}")
_LITERAL_ARG = re.compile(rf'{SP}("[ ]*"){SP}\)')
_LAMBDA_LITERAL = re.compile(r'("[ ]*")(?=[ \t\r\n]{0,200}\))')
# Kotlin: преобразование за вызовом и элвис.
_KT_CONVERT = re.compile(
    rf"{SP}(\?)?\.{SP}(toInt|toLong|toShort|toBoolean|toDouble|toFloat|toIntOrNull|"
    rf"toLongOrNull|toBooleanStrict|toBooleanStrictOrNull|toDoubleOrNull|toFloatOrNull)"
    rf"{SP}\({SP}\)"
)
_KT_ELVIS = re.compile(rf"{SP}\?:{SP}")
_KT_LITERAL = re.compile(r'"[ ]*"|-?[0-9][0-9_]*(?:\.[0-9]+)?[LlFf]?(?![\w.])|true(?!\w)|false(?!\w)')
_KT_FAIL = re.compile(r"(?:throw|error)(?![\w$])")
_KT_SAFE = re.compile(rf"{SP}\?\.")
_KT_CLOSE = re.compile(rf"{SP}\)")
_KT_TYPES = {
    "toInt": "int", "toLong": "int", "toShort": "int", "toIntOrNull": "int",
    "toLongOrNull": "int", "toBoolean": "bool", "toBooleanStrict": "bool",
    "toBooleanStrictOrNull": "bool", "toDouble": "float", "toFloat": "float",
    "toDoubleOrNull": "float", "toFloatOrNull": "float",
}
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
        required: bool | None = None
        start = clike.chain_start(mask, m.start())
        type_: str | None = None
        if arg is not None and method is None:
            tail = _tail(code, start, arg.end())
            if tail is not None:
                start, default, has_default, required, type_ = tail
        type_ = type_ or clike.wrapped_type(mask, start, _TYPES)
        clike.read(
            found, repo, code, rel, pos, arg, NAME, _VAR, default=default,
            has_default=has_default, required=required,
            type_=type_ or secrets.value_type(default),
        )


# Хвост чтения: начало выражения для типа обёртки, дефолт, есть ли дефолт, обязательный ли, тип.
Tail = tuple[int, str | None, bool, bool | None, str | None]


def _tail(code: codetext.Code, start: int, end: int) -> Tail | None:
    """Дефолт после вызова System.getenv("X"), кончающегося на end: Java — хвост Optional,
    Kotlin — преобразование и элвис. (начало выражения для типа обёртки, дефолт, есть ли
    дефолт, обязательный ли, тип); None — хвоста нет."""
    if code.lang == codetext.KOTLIN:
        return _kotlin_tail(code, start, end)
    optional = _optional_start(code.mask, start)
    if optional < 0:
        return None
    m = _OPTIONAL_TAIL.match(code.mask, end)
    if m is None:
        return optional, None, False, None, None
    if m.group(1) == "orElseThrow":
        return optional, None, False, True, None
    pos = m.end()
    if m.group(1) == "orElseGet":
        lam = _LAMBDA.match(code.mask, pos)
        if lam is None:
            return optional, None, True, None, None
        pos = lam.end()
        lit = _LAMBDA_LITERAL.match(code.mask, pos)
    else:
        lit = _LITERAL_ARG.match(code.mask, pos)
    if lit is None:
        return optional, None, True, None, None
    return optional, clike.literal_value(code, *lit.span(1)), True, None, None


def _optional_start(mask: str, start: int) -> int:
    """Начало Optional.ofNullable(…), аргумент которого начинается на start; -1 — не он."""
    paren = clike.skip_back(mask, start)
    if paren == 0 or mask[paren - 1] != "(":
        return -1
    name_end = clike.skip_back(mask, paren - 1)
    method = clike.ident_before(mask, name_end)
    if method is None or mask[method:name_end] != "ofNullable":
        return -1
    dot = clike.skip_back(mask, method)
    if dot == 0 or mask[dot - 1] != ".":
        return -1
    cls_end = clike.skip_back(mask, dot - 1)
    cls = clike.ident_before(mask, cls_end)
    if cls is None or mask[cls:cls_end] != "Optional":
        return -1
    return clike.chain_start(mask, cls)


def _kotlin_tail(code: codetext.Code, start: int, end: int) -> Tail:
    mask = code.mask
    pos = end
    type_: str | None = None
    safe = False
    conv = _KT_CONVERT.match(mask, pos)
    if conv is not None:
        safe = conv.group(1) is not None
        type_ = _KT_TYPES[conv.group(2)]
        pos = conv.end()
    elvis = _KT_ELVIS.match(mask, pos)
    if elvis is None:
        safe = safe or _KT_SAFE.match(mask, pos) is not None
        return start, None, False, None if safe else True, type_
    pos = elvis.end()
    if _KT_FAIL.match(mask, pos):
        return start, None, False, True, type_
    lit = _KT_LITERAL.match(mask, pos)
    if lit is None:
        return start, None, True, None, type_
    text = lit.group()
    # «(System.getenv("X") ?: "5").toInt()»: преобразование за скобкой вокруг элвиса.
    close = _KT_CLOSE.match(mask, lit.end())
    outer = _KT_CONVERT.match(mask, close.end()) if close is not None and type_ is None else None
    if outer is not None:
        type_ = _KT_TYPES[outer.group(2)]
    if text.startswith('"'):
        if code.joined(*lit.span()):
            return start, None, True, None, type_
        value, dynamic = jvm.literal(code, *lit.span())
        return start, None if dynamic else value, True, None, type_
    return start, text.rstrip("LlFf").replace("_", ""), True, None, type_ or _number_type(text)


def _number_type(text: str) -> str | None:
    if text in ("true", "false"):
        return "bool"
    return "float" if "." in text else "int"


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    for language, lang in ((codebase.JAVA, codetext.JAVA), (codebase.KOTLIN, codetext.KOTLIN)):
        if not codebase.stack_present(files, ctx, language):
            continue
        found.applied.add(NAME)
        repo = clike.Repo(files, ctx, language, lang)
        for rel, code in clike.sources(
            files, ctx, language, lang, _NEEDLES, repo, clike.in_jvm_test_dir,
        ):
            _scan(files, code, rel, repo, found)
    return found
