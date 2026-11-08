"""Параметры конфигурации в коде Node (ТЗ §6.2): process.env.X и process.env['X'], дефолт
из «|| 'v'» и «?? 'v'» сразу за чтением (строка, число, true или false). Поиск по маске
кода (codetext.py): чтение в комментарии не находится. Имя не строкой
(process.env[name]) уходит в hints.dynamic_names.

Схема zod (ТЗ §15 п. 14 Е3: immich server/src/dtos/env.dto.ts): ключи z.object({…}) схемы
с именем, которую файл применяет к окружению (Схема.safeParse(process.env), .parse,
.parseAsync, .safeParseAsync), — параметры. Схема объявлена в этом файле
(const Схема = z.object(…)) или импортирована «import { Схема } from '…'» из модуля
репозитория (относительный путь от файла или единственный модуль с тем же хвостом пути:
псевдоним src/…). Основание — строка ключа и место применения, владелец — по файлу схемы.
Тип по валидатору цепочки (z.string — string, z.number и z.coerce.number — int при .int()
или целом дефолте, иначе float, z.boolean, z.coerce.boolean и z.stringbool — bool, z.enum
— string с перечнем значений в описании), имя константы-валидатора того же файла
раскрывается её цепочкой; дефолт из .default(литерал); required — без .optional(),
.nullish() и дефолта, если вид валидатора известен. Ключ с вычисляемым именем уходит в
hints.dynamic_names."""

from __future__ import annotations

import re

from archmap_scan import codebase, codetext, gocode, paths, secrets, texts
from archmap_scan.codetext import SP, STR
from archmap_scan.context import Context
from archmap_scan.model import CodeParam, Findings, Hint, Loc
from archmap_scan.walk import Files

NAME = "node-env"
# Дефолт сразу за чтением: «|| 'v'», «?? 20», «|| true».
_DEFAULT = (
    rf"(?:[ \t]*(?:\|\||\?\?)[ \t]*"
    rf"({STR}|-?[0-9]{{1,20}}(?:\.[0-9]{{1,20}})?|true|false))?"
)
_DOT = re.compile(
    rf"process[ \t]*\.[ \t]*env[ \t]*\.[ \t]*([A-Za-z_][A-Za-z0-9_]{{0,199}}){_DEFAULT}"
)
_BRACKET = re.compile(rf"process[ \t]*\.[ \t]*env[ \t]*\[[ \t]*({STR})?")
_BRACKET_TAIL = re.compile(rf"[ \t]*\]{_DEFAULT}")
_VAR = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,199}")
_STR = re.compile(STR)


def _add(code: codetext.Code, rel: str, found: Findings, name: str, at: int,
         default: tuple[int, int] | None) -> None:
    text: str | None = None
    if default is not None:
        start, end = default
        if _STR.fullmatch(code.mask, start, end):
            # Дефолт в склейке («|| "http://" + host») литералом не считается.
            value, dynamic = code.literal(start, end)
            text = None if dynamic else value
        else:
            text = code.text[start:end]
    found.code_params.append(CodeParam(
        name=name, loc=Loc(rel, code.line(at)), parser=NAME, default=text,
        has_default=default is not None, type=secrets.value_type(text),
    ))


def _scan(code: codetext.Code, rel: str, found: Findings) -> None:
    for m in _DOT.finditer(code.mask):
        span = m.span(2) if m.group(2) is not None else None
        _add(code, rel, found, m.group(1), m.start(), span)
    for m in _BRACKET.finditer(code.mask):
        name, dynamic = code.literal(m.start(1), m.end(1)) if m.group(1) else ("", True)
        if dynamic:
            reason = (
                code.reason(m.start(1), m.end(1), texts.REASON_DYNAMIC_PARAM) if m.group(1)
                else texts.REASON_DYNAMIC_PARAM
            )
            found.hints.append(Hint("dynamic_names", {
                "kind": "config", "name": code.expression(m.start(1) if m.group(1) else m.end()),
                "reason": reason,
                "source": str(Loc(rel, code.line(m.start()))),
            }))
            continue
        if not _VAR.fullmatch(name):
            continue
        tail = _BRACKET_TAIL.match(code.mask, m.end())
        span = tail.span(1) if tail is not None and tail.group(1) is not None else None
        _add(code, rel, found, name, m.start(), span)


# Применение схемы к окружению: «.safeParse(process.env)» (имя схемы — перед точкой).
_APPLY = re.compile(
    rf"\.{SP}(?:safeParse|parse|safeParseAsync|parseAsync){SP}\({SP}process{SP}\.{SP}env{SP}\)"
)
_IMPORT = re.compile(rf"\bimport[ \t]+(?:type[ \t]+)?\{{([^{{}}]{{0,5000}})\}}{SP}from{SP}({STR})")
_JS_EXTS = (".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".tsx", ".jsx")
_MEMBER = re.compile(rf"\.{SP}([A-Za-z_$][A-Za-z0-9_$]{{0,99}})")
_HEAD = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]{0,99}")
_KEY = re.compile(rf"(?:([A-Za-z_$][A-Za-z0-9_$]{{0,199}})|({STR})|(\[)){SP}(:)?")
_LITERAL = re.compile(rf"{STR}|-?[0-9]{{1,20}}(?:\.[0-9]{{1,20}})?|true|false")
# Длина объекта схемы и объявления константы-валидатора, которые просматриваются, и сколько
# разных констант-валидаторов раскрывается в одном файле.
_MAX_OBJECT = 200_000
_MAX_STATEMENT = 5000
_MAX_LOCALS = 200
_MAX_DEPTH = 3
_ZOD_TYPES = {
    "string": "string", "boolean": "bool", "stringbool": "bool", "enum": "string",
    "bigint": "int", "date": "string",
}


def _definition(mask: str, name: str) -> re.Match[str] | None:
    """Объявление «const Имя = z.object(» (let, var, export перед ним допустимы)."""
    pattern = re.compile(
        rf"\b(?:const|let|var)[ \t]+{re.escape(name)}[ \t]*(?::[^=\n]{{0,200}})?={SP}z{SP}\.{SP}"
        rf"object{SP}\("
    )
    return pattern.search(mask)


def _module(spec: str, rel: str, index: dict[str, list[str]]) -> str | None:
    """Файл модуля по спецификатору импорта: относительный путь от файла, иначе единственный
    файл кода с тем же хвостом пути без расширения (псевдоним src/… или ~/…)."""
    stem = spec
    for ext in _JS_EXTS:
        if stem.endswith(ext):
            stem = stem[: -len(ext)]
            break
    if spec.startswith("."):
        base = paths.join(paths.parent(rel), stem)
        if base is None:
            return None
        hits = index.get(base, []) or index.get(base + "/index", [])
        return hits[0] if len(hits) == 1 else None
    tail = stem.lstrip("~@/").strip("/")
    if not tail:
        return None
    hits = [f for key, found in index.items() if key == tail or key.endswith("/" + tail) for f in found]
    return hits[0] if len(hits) == 1 else None


def _imported(code: codetext.Code, name: str) -> str | None:
    """Спецификатор модуля, из которого файл импортирует имя name (с «as» — по псевдониму)."""
    for m in _IMPORT.finditer(code.mask):
        for item in code.text[m.start(1):m.end(1)].split(","):
            parts = item.split()
            if parts and parts[0] == "type":
                parts = parts[1:]
            if (len(parts) == 1 and parts[0] == name) or (
                len(parts) == 3 and parts[1] == "as" and parts[2] == name
            ):
                return code.text[m.start(2) + 1:m.end(2) - 1]
    return None


class _Chain:
    """Сведения цепочки валидатора: вид, необязательность, дефолт, перечень enum."""

    def __init__(self) -> None:
        self.kind: str | None = None
        self.known = False
        self.optional = False
        self.default: str | None = None
        self.has_default = False
        self.choices: list[str] = []
        self.integer = False


_Locals = dict[str, tuple[int, int] | None]


def _local(mask: str, name: str, locals_: _Locals) -> tuple[int, int] | None:
    """Выражение объявления «const name = …» в файле (позиции в маске) с кэшем по имени;
    больше _MAX_LOCALS разных имён не раскрывается."""
    if name in locals_:
        return locals_[name]
    span: tuple[int, int] | None = None
    if len(locals_) < _MAX_LOCALS:
        found = re.compile(
            rf"\b(?:const|let|var)[ \t]+{re.escape(name)}[ \t]*(?::[^=\n]{{0,200}})?={SP}"
        ).search(mask)
        if found is not None:
            span = (found.end(), _statement_end(mask, found.end()))
    locals_[name] = span
    return span


def _chain(
    code: codetext.Code, start: int, end: int, out: _Chain, locals_: _Locals, depth: int = 0,
) -> None:
    """Разобрать выражение валидатора на позициях [start, end) маски."""
    mask = code.mask
    while start < end and mask[start] in " \t\r\n":
        start += 1
    head = _HEAD.match(mask, start, end)
    if head is None:
        return
    if head.group() == "z":
        out.known = True
    elif depth < _MAX_DEPTH:
        span = _local(mask, head.group(), locals_)
        if span is not None:
            _chain(code, span[0], span[1], out, locals_, depth + 1)
    for m in _MEMBER.finditer(mask, head.end(), end):
        member = m.group(1)
        if member in ("optional", "nullish"):
            out.optional = True
        elif member == "int":
            out.integer = True
        elif member == "default":
            args = _args(mask, m.end(), end)
            if args:
                out.has_default = True
                a, b = args[0]
                if _LITERAL.fullmatch(mask, a, b):
                    value = code.literal(a, b)[0] if mask[a] in "'\"`" else mask[a:b]
                    out.default = value
        elif out.kind is None and member == "number":
            out.kind = "number"
        elif out.kind is None and member in _ZOD_TYPES:
            out.kind = member
            if member == "enum":
                args = _args(mask, m.end(), end)
                if args and mask[args[0][0]] == "[":
                    a, b = args[0]
                    inner = gocode.split_spans(mask, a + 1)
                    values = [
                        code.literal(x, y)[0] for x, y in (inner[0] if inner else [])
                        if re.fullmatch(STR, mask[x:y])
                    ]
                    if inner and len(values) == len(inner[0]):
                        out.choices = values


def _args(mask: str, pos: int, end: int) -> list[tuple[int, int]] | None:
    """Аргументы вызова, если за позицией pos (после имени члена) идёт «(»."""
    i = pos
    while i < end and mask[i] in " \t\r\n":
        i += 1
    if i >= end or mask[i] != "(":
        return None
    parts = gocode.split_spans(mask, i + 1)
    return parts[0] if parts is not None else None


def _statement_end(mask: str, start: int) -> int:
    """Конец выражения объявления: «;» или перевод строки на верхнем уровне скобок."""
    depth = 0
    stop = min(len(mask), start + _MAX_STATEMENT)
    for i in range(start, stop):
        ch = mask[i]
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
            if depth < 0:
                return i
        elif depth == 0 and ch == ";":
            return i
        elif depth == 0 and ch == "\n" and i > start and mask[start:i].strip():
            nxt = mask[i + 1:i + 200].lstrip()
            if not nxt.startswith("."):
                return i
    return stop


def _type(chain: _Chain) -> str | None:
    if chain.kind == "number":
        if chain.integer or (chain.default is not None and chain.default.lstrip("-").isdigit()):
            return "int"
        return "float"
    return _ZOD_TYPES.get(chain.kind or "")


def _schema(
    code: codetext.Code, rel: str, at: re.Match[str], applied: Loc, found: Findings,
) -> None:
    """Ключи объекта z.object({…}) объявления at — параметры с местом применения схемы."""
    mask = code.mask
    i = at.end()
    while i < len(mask) and mask[i] in " \t\r\n":
        i += 1
    if i >= len(mask) or mask[i] != "{":
        return
    parts = gocode.split_spans(mask, i + 1, _MAX_OBJECT)
    if parts is None:
        return
    locals_: _Locals = {}
    for a, b in parts[0]:
        key = _KEY.match(mask, a, b)
        if key is None:
            continue
        line = code.line(a)
        if key.group(3):
            found.hints.append(Hint("dynamic_names", {
                "kind": "config", "name": code.text[a:b].split(":", 1)[0].strip()[:80],
                "reason": texts.REASON_DYNAMIC_PARAM, "source": str(Loc(rel, line)),
            }))
            continue
        if key.group(2):
            name, dynamic = code.literal(key.start(2), key.end(2))
            if dynamic:
                continue
        else:
            name = key.group(1)
        if not _VAR.fullmatch(name):
            continue
        chain = _Chain()
        if key.group(4):
            _chain(code, key.end(), b, chain, locals_)
        type_ = _type(chain)
        known = chain.known or chain.kind is not None
        found.code_params.append(CodeParam(
            name=name, loc=Loc(rel, line), parser=NAME, default=chain.default,
            has_default=chain.has_default,
            required=True if known and not chain.optional and not chain.has_default else None,
            type=type_ or secrets.value_type(chain.default), extra_locs=[applied],
            description=texts.config_choices(chain.choices) if chain.choices else None,
        ))


def _zod(
    files: Files, ctx: Context, code: codetext.Code, rel: str, found: Findings,
    index: dict[str, list[str]], done: set[tuple[str, str]],
) -> None:
    """Схемы zod, которые файл применяет к process.env."""
    for m in _APPLY.finditer(code.mask):
        name = code.receiver(m.start())
        if not name:
            continue
        applied = Loc(rel, code.line(m.start()))
        target, schema = rel, code
        at = _definition(code.mask, name)
        if at is None:
            spec = _imported(code, name)
            module = _module(spec, rel, index) if spec is not None else None
            text = files.read(module, keep=False) if module is not None else None
            loaded = codetext.load(files, module, text, codetext.JS) if module and text else None
            if loaded is None or module is None:
                continue
            target, schema = module, loaded
            at = _definition(schema.mask, name)
        if at is None or (target, name) in done:
            continue
        done.add((target, name))
        _schema(schema, target, at, applied, found)


def _code_index(files: Files, ctx: Context) -> dict[str, list[str]]:
    """Файлы кода Node по пути без расширения."""
    out: dict[str, list[str]] = {}
    for rel in codebase.code_files(files, ctx, codebase.NODE):
        stem, dot, _ext = rel.rpartition(".")
        out.setdefault(stem if dot else rel, []).append(rel)
    return out


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not codebase.stack_present(files, ctx, codebase.NODE):
        return found
    found.applied.add(NAME)
    index: dict[str, list[str]] | None = None
    done: set[tuple[str, str]] = set()
    for rel, text in codebase.sources(files, ctx, codebase.NODE, None, ("process.env",)):
        code = codetext.load(files, rel, text, codetext.JS)
        if code is None:
            continue
        _scan(code, rel, found)
        if _APPLY.search(code.mask) is not None:
            if index is None:
                index = _code_index(files, ctx)
            _zod(files, ctx, code, rel, found, index, done)
    return found
