"""Параметры конфигурации в коде Rust (ТЗ §15 п. 14 И2).

- `#[envconfig(from = "X", default = "v")]` над полем структуры: параметр X с дефолтом v;
  без `from` — имя поля в верхнем регистре; `nested = true` — вложенная структура, не
  параметр. Тип — по типу поля (u16, usize, i64, NonZero… — int, bool, f64 — float,
  Duration — duration, иначе string), `Option<…>` не обязателен, поле без дефолта и не
  Option обязательно;
- clap: `#[arg(…, env = "X", default_value = "v")]` и `#[clap(…)]` с `default_value_t =
  литерал` — так же по полю;
- `std::env::var("X")`, `env::var("X")`, `std::env::var_os("X")`: дефолт из
  `.unwrap_or("v")` и `.unwrap_or_else(|_| "v".to_string())`, `.unwrap()` и `.expect(…)` —
  обязателен; имя выражением — `hints.dynamic_names`;
- `env!("X")` и `option_env!("X")` подставляет компилятор: это не параметр запуска, а
  переменная времени сборки — `hints.unassigned`; переменные самого Cargo (`CARGO_*`) не
  пишутся вовсе.

Стек — пакет Rust (Cargo.toml); ищется по маске кода (`codetext.RUST`): строка в
комментарии не читается, время жизни `'a` литералом не считается, модуль тестов
`#[cfg(test)] mod … { … }` не читается. Владелец — по каталогу кода крейта (buildfiles, И1)
или контейнера, как у других языков.
"""

from __future__ import annotations

import re
from bisect import bisect_right

from archmap_scan import clike, codebase, codetext, secrets, texts
from archmap_scan.codetext import SP, STR
from archmap_scan.context import Context
from archmap_scan.model import CodeParam, Findings, Hint, Loc
from archmap_scan.walk import Files

NAME = "rust-env"
_NEEDLES = ("envconfig", "env::var", "env!(", "#[arg(", "#[clap(")
_ATTR = re.compile(r"#[ \t]*\[[ \t]*(envconfig|arg|clap)[ \t]*\(")
_CALL = re.compile(r"\benv[ \t]*::[ \t]*(var|var_os)[ \t]*\(")
_MACRO = re.compile(r"\b(option_env|env)[ \t]*![ \t]*\(")
_ARG = re.compile(rf"{SP}(?P<arg>{STR})?{SP}(?P<end>[,)])")
_FIELD = re.compile(
    r"(?:pub(?:[ \t]*\([^()\n]{0,40}\))?[ \t]+)?([A-Za-z_][A-Za-z0-9_]{0,99})[ \t]*:(?!:)"
)
_TEST_MODULE = re.compile(r"#[ \t]*\[[ \t]*cfg[ \t]*\([ \t]*test[ \t]*\)[ \t]*\]")
_MODULE = re.compile(r"[ \t\r\n]{0,200}(?:pub(?:\([^()\n]{0,40}\))?[ \t]+)?mod[ \t]+\w{1,100}[ \t]*\{")
_KEY = re.compile(r"\b(from|default|env|default_value|default_value_t|nested)\b[ \t]*(=)?")
_STRING = re.compile(r'"((?:[^"\\\n]|\\.){0,500})"')
_VALUE = re.compile(r"[ \t]*(-?[0-9][0-9_.]{0,40}|true|false|[A-Za-z_][A-Za-z0-9_:]{0,100})")
_UNWRAP_OR = re.compile(
    rf"{SP}\.{SP}unwrap_or(?:_else)?{SP}\({SP}(?:\|[^|\n]{{0,40}}\|{SP})?(?P<lit>{STR})"
)
_METHOD = re.compile(rf"{SP}(?:\.{SP}([a-z_]{{1,40}})|(\?))")
_VAR = re.compile(r"[A-Za-z_][A-Za-z0-9_.\-]{0,199}")
_MAX_ATTR = 2000
_MAX_TYPE = 300
_MAX_GAP = 5000
_INT = frozenset({
    "u8", "u16", "u32", "u64", "u128", "usize", "i8", "i16", "i32", "i64", "i128", "isize",
})
_FLOAT = frozenset({"f32", "f64"})


def _close(mask: str, pos: int, open_: str, close: str, limit: int) -> int | None:
    """Позиция после скобки close, закрывающей уже открытую до pos; None — не закрыта."""
    depth = 1
    end = min(len(mask), pos + limit)
    while pos < end:
        ch = mask[pos]
        if ch == open_:
            depth += 1
        elif ch == close:
            depth -= 1
            if depth == 0:
                return pos + 1
        pos += 1
    return None


def _skip_space(mask: str, pos: int, limit: int = 200) -> int:
    end = min(len(mask), pos + limit)
    while pos < end and mask[pos] in " \t\r\n":
        pos += 1
    return pos


def _options(code: codetext.Code, start: int, end: int) -> dict[str, tuple[str, bool]]:
    """Ключи атрибута: значение и признак литерала (строка без кавычек, число, true или
    false); выражение — как написано, не литерал; ключ без значения (`env`, `nested`) —
    пустая строка."""
    text, mask = code.text, code.mask
    out: dict[str, tuple[str, bool]] = {}
    for m in _KEY.finditer(mask, start, end):
        key = m.group(1)
        if m.group(2) is None:
            out.setdefault(key, ("", False))
            continue
        lit = _STRING.match(text, _skip_space(mask, m.end()))
        if lit is not None:
            out[key] = (lit.group(1), True)
            continue
        value = _VALUE.match(mask, m.end())
        if value is not None:
            word = value.group(1)
            out[key] = (word, word in ("true", "false") or word[:1] in "-0123456789")
    return out


def _field(code: codetext.Code, pos: int) -> tuple[str, str, int] | None:
    """Поле после атрибута (другие атрибуты между ними пропускаются): имя, тип, строка."""
    mask = code.mask
    for _ in range(10):
        pos = _skip_space(mask, pos, _MAX_GAP)
        if not mask.startswith("#", pos):
            break
        bracket = mask.find("[", pos, pos + 5)
        end = _close(mask, bracket + 1, "[", "]", _MAX_ATTR) if bracket >= 0 else None
        if end is None:
            return None
        pos = end
    m = _FIELD.match(mask, pos)
    if m is None:
        return None
    type_end = m.end()
    depth = 0
    while type_end < len(mask) and type_end - m.end() < _MAX_TYPE:
        ch = mask[type_end]
        if ch in "<([":
            depth += 1
        elif ch in ">)]":
            depth -= 1
        elif ch in ",}\n" and depth <= 0:
            break
        type_end += 1
    return m.group(1), " ".join(mask[m.end():type_end].split()), code.line(m.start(1))


def _type(rust: str) -> tuple[str, bool]:
    """Тип параметра по типу поля и признак Option."""
    optional = rust.startswith("Option<") and rust.endswith(">")
    inner = rust[7:-1].strip() if optional else rust
    last = inner.rsplit("::", 1)[-1]
    if last in _INT or last.startswith("NonZero"):
        return "int", optional
    if last == "bool":
        return "bool", optional
    if last in _FLOAT:
        return "float", optional
    if last == "Duration":
        return "duration", optional
    return "string", optional


def _attr(code: codetext.Code, rel: str, m: re.Match[str], found: Findings) -> None:
    kind = m.group(1)
    end = _close(code.mask, m.end(), "(", ")", _MAX_ATTR)
    if end is None:
        return
    opts = _options(code, m.end(), end - 1)
    if kind != "envconfig" and "env" not in opts:
        return
    if "nested" in opts:
        return
    bracket = code.mask.find("]", end, end + 20)
    field = _field(code, bracket + 1) if bracket >= 0 else None
    if field is None:
        return
    name, rust, line = field
    explicit = opts.get("from" if kind == "envconfig" else "env", ("", False))[0]
    var = explicit or name.upper()
    if not _VAR.fullmatch(var):
        return
    keys = ("default",) if kind == "envconfig" else ("default_value", "default_value_t")
    given = next((opts[k] for k in keys if k in opts), None)
    default = given[0] if given is not None and given[1] else None
    type_, optional = _type(rust)
    here = code.line(m.start())
    found.code_params.append(CodeParam(
        name=var, loc=Loc(rel, here), parser=NAME, default=default,
        has_default=given is not None,
        # Флаг clap без значения — ложь по умолчанию, у envconfig же поле без дефолта обязательно.
        required=given is None and not optional and not (kind != "envconfig" and type_ == "bool"),
        type=type_, extra_locs=[Loc(rel, line)] if line != here else [],
    ))


def _call(code: codetext.Code, rel: str, m: re.Match[str], found: Findings) -> None:
    mask = code.mask
    arg = _ARG.match(mask, m.end())
    line = code.line(m.start())
    if arg is None or arg.group("arg") is None:
        expr = code.expression(m.end())
        clike.hint(found, expr, texts.REASON_DYNAMIC_PARAM, rel, line)
        return
    start, end = arg.span("arg")
    value = code.text[start + 1:end - 1]
    if not _VAR.fullmatch(value):
        clike.hint(found, code.text[start:end][:80], texts.REASON_DYNAMIC_PARAM, rel, line)
        return
    close = arg.end() if arg.group("end") == ")" else None
    default: str | None = None
    has_default = required = False
    if close is not None:
        fallback = _UNWRAP_OR.match(mask, close)
        method = _METHOD.match(mask, close)
        if fallback is not None:
            has_default = True
            lit = fallback.span("lit")
            default = code.text[lit[0] + 1:lit[1] - 1]
        elif method is not None:
            # .unwrap(), .expect(…) и «?» — без переменной процесс не идёт; unwrap_or с
            # выражением — дефолт есть, но не литерал; .ok(), .is_ok() — не обязателен.
            word = method.group(1) or ""
            required = word in ("unwrap", "expect") or method.group(2) is not None
            has_default = word.startswith("unwrap_or")
    found.code_params.append(CodeParam(
        name=value, loc=Loc(rel, line), parser=NAME, default=default, has_default=has_default,
        required=required, type=secrets.value_type(default),
    ))


def _macro(code: codetext.Code, rel: str, m: re.Match[str], found: Findings) -> None:
    arg = _ARG.match(code.mask, m.end())
    if arg is None or arg.group("arg") is None:
        return
    start, end = arg.span("arg")
    value = code.text[start + 1:end - 1]
    if value.startswith("CARGO_") or not _VAR.fullmatch(value):
        return
    found.hints.append(Hint("unassigned", {
        "kind": "config", "name": value, "reason": texts.REASON_BUILD_VARIABLE,
        "source": str(Loc(rel, code.line(m.start()))),
    }))


def test_modules(mask: str) -> list[tuple[int, int]]:
    """Участки `#[cfg(test)] mod имя { … }` по возрастанию, без пересечений."""
    out: list[tuple[int, int]] = []
    for m in _TEST_MODULE.finditer(mask):
        if out and m.start() < out[-1][1]:
            continue
        module = _MODULE.match(mask, m.end())
        if module is None:
            continue
        end = _close(mask, module.end(), "{", "}", len(mask))
        out.append((m.start(), len(mask) if end is None else end))
    return out


def _scan(files: Files, code: codetext.Code, rel: str, found: Findings) -> None:
    tests = test_modules(code.mask) if "cfg" in code.mask else []
    starts = [a for a, _ in tests]
    for pattern, handle in ((_ATTR, _attr), (_CALL, _call), (_MACRO, _macro)):
        for m in clike.matches(files, rel, pattern, code.mask) or []:
            k = bisect_right(starts, m.start()) - 1
            if k < 0 or m.start() >= tests[k][1]:
                handle(code, rel, m, found)


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not codebase.stack_present(files, ctx, codebase.RUST):
        return found
    found.applied.add(NAME)
    for rel, text in codebase.sources(files, ctx, codebase.RUST, None, _NEEDLES):
        if clike.in_test_dir(rel):
            continue
        code = codetext.load(files, rel, text, codetext.RUST)
        if code is not None:
            _scan(files, code, rel, found)
    return found
