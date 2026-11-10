"""Параметры Spring в коде Java и Kotlin (ТЗ §15 п. 17 Е2): @Value и @ConfigurationProperties
у пакета со Spring Boot (артефакт spring-boot*).

@Value("${key}") и @Value("${key:default}") над полем, свойством Kotlin, параметром
конструктора или метода и над методом-сеттером: параметр key, дефолт как написан, обязательный
без дефолта. Тип по объявленному типу (long — int, boolean — bool, Duration — duration, String —
string, список и массив — array), если значение — одна подстановка целиком, иначе по дефолту.
Значение с выражением «#{…}» или без «${» параметра не даёт; значение не литералом (склейка,
выражение) — подсказка о динамическом имени, константа Java раскрывается (clike.Repo).

@ConfigurationProperties(prefix = "vets") (value =, первый аргумент) над классом или record:
параметры «vets.<свойство>» с именем в kebab-case, как пишет Spring (heapSize — heap-size).
Свойства: компоненты record и параметры первичного конструктора Kotlin; у класса Java — поля
(не static) с сеттером setИмя в том же классе или под @Data, @Setter Lombok; у класса Kotlin без
параметров конструктора — свойства var тела. Свойство с типом, объявленным в том же файле,
раскрывается на один уровень (vets.cache.ttl); глубже — параметр с именем свойства без типа.
Дефолт — литерал инициализатора (число, строка, true, false) или @DefaultValue("d"); инициализатор
не литералом — дефолт есть, но не пишется. @ConfigurationProperties над методом @Bean не
читается (класс свойств вне метода).
"""

from __future__ import annotations

import re
from bisect import bisect_right
from dataclasses import dataclass, field

from archmap_scan import clike, codebase, codetext, jvm, jvmconf, texts
from archmap_scan.context import Context
from archmap_scan.model import CodeParam, Findings, Loc
from archmap_scan.walk import Files

NAME = "spring-value"
STACK = ("spring-boot",)
_NEEDLES = ("@Value", ".Value", ":Value", "ConfigurationProperties")
_VALUE = "Value"
_PROPERTIES = "ConfigurationProperties"
_NAMES = frozenset({_VALUE, _PROPERTIES})
# Lombok над классом: @Data и @Setter дают сеттеры всем полям.
_LOMBOK = re.compile(r"(?<![\w$])@[ \t]*(?:lombok[ \t]*\.[ \t]*)?(?:Data|Setter)(?![\w$])")
_HEAD = 2000  # сколько знаков перед словом class смотрится на аннотации Lombok
_CTOR = re.compile(
    r"[ \t\r\n]*(?:(?:private|internal|protected|public)?[ \t]*constructor[ \t]*)?\("
)
_PREFIX_LABELS = frozenset({"prefix", "value"})
_MODIFIERS = frozenset({
    "final", "private", "protected", "public", "static", "transient", "volatile", "lateinit",
    "override", "open", "internal", "val", "var", "const", "vararg", "abstract",
})
_TYPES = {
    **dict.fromkeys(
        ("int", "Integer", "long", "Long", "short", "Short", "byte", "Byte", "Int", "BigInteger",
         "UInt", "ULong"), "int",
    ),
    **dict.fromkeys(("boolean", "Boolean"), "bool"),
    **dict.fromkeys(("double", "Double", "float", "Float", "BigDecimal"), "float"),
    "Duration": "duration",
    **dict.fromkeys(("String", "CharSequence"), "string"),
    **dict.fromkeys(
        ("List", "Set", "Collection", "Array", "MutableList", "MutableSet", "IntArray",
         "LongArray"), "array",
    ),
}
_ID = r"[A-Za-z_$][A-Za-z0-9_$]{0,99}"
_TOKEN = re.compile(rf"@|<|\[[ \t]*\]|\.\.\.|{_ID}|[:=?.,(]")
_NUMBER = re.compile(r"-?[0-9][0-9_]*(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?[LlFfDd]?")
_STRING = re.compile(r'"[ ]*"')
_SETTER = re.compile(r"(?<![\w$])set([A-Z][A-Za-z0-9_$]{0,99})[ \t\r\n]*\(")
_KT_VAR = re.compile(rf"(?<![\w$.])var[ \t]+({_ID})[ \t]*:")
_STATIC = re.compile(r"(?<![\w$])static(?![\w$])")
_STATEMENT = re.compile(r"[;{(\[=]")
_NAME_END = re.compile(rf"{_ID}\Z")
# Слов и аннотаций в одном объявлении: в настоящем коде их десятки (враждебный вход).
_MAX_TOKENS = 500


@dataclass
class _Decl:
    """Объявление свойства или параметра: имя, позиция имени, простое имя типа, массив ли,
    и границы инициализатора (init = -1 — нет)."""

    name: str
    at: int
    type: str | None
    array: bool = False
    init: int = -1
    init_end: int = -1
    default: str | None = None  # из @DefaultValue
    has_default: bool = False


@dataclass
class _File:
    rel: str
    code: codetext.Code
    outline: jvm.Outline
    repo: clike.Repo | None
    found: Findings
    count: int = 0
    # Аргументы по скобке (список и их начала) и свойства по классу: память файла, чтобы
    # аннотации одного списка параметров и вложенный тип не разбирались заново.
    params: dict[int, tuple[list[jvm.Arg], list[int]]] = field(default_factory=dict)
    props: dict[int, list[_Decl]] = field(default_factory=dict)

    @property
    def kotlin(self) -> bool:
        return self.code.lang == codetext.KOTLIN


def dashed(name: str) -> str:
    """Имя свойства в kebab-case, как его пишет Spring (DataObjectPropertyName): перед
    заглавной буквой «-», «_» — «-», всё в нижнем регистре."""
    out: list[str] = []
    for ch in name:
        ch = "-" if ch == "_" else ch
        if ch.isupper() and out and out[-1] != "-":
            out.append("-")
        out.append(ch.lower())
    return "".join(out)


def _add(f: _File, param: CodeParam) -> None:
    f.count += 1
    if f.count > clike.MAX_READS:
        raise jvm.TooMany
    f.found.code_params.append(param)


def _declaration(f: _File, lo: int, hi: int) -> _Decl | None:
    """Объявление в [lo, hi): Java «[модификаторы] Тип имя [= x]», Kotlin «[val] имя: Тип
    [= x]»; аннотации и параметры типа перепрыгиваются, @DefaultValue даёт дефолт. Скобка
    вне аннотации (метод, вызов) или запятая (несколько имён) — None."""
    mask = f.code.mask
    words: list[tuple[str, int]] = []
    array = False
    colon = -1
    default: str | None = None
    has_default = False
    i = lo
    for _ in range(_MAX_TOKENS):
        m = _TOKEN.search(mask, i, hi)
        if m is None:
            break
        tok, i = m.group(), m.end()
        if tok == "@":
            end = jvm.annotation_end(f.outline, m.start(), hi)
            if end < 0:
                return None
            got = _default_value(f, m.start(), end)
            if got is not None:
                default, has_default = got, True
            i = end
        elif tok == "<":
            i = jvm.type_args_end(mask, m.start(), hi)
            if i < 0:
                return None
        elif tok == "=":
            return _finish(words, array, colon, f.kotlin, m.end(), hi, default, has_default)
        elif tok in ",(":
            return None  # несколько имён, вызов или метод: не объявление свойства
        elif tok == ":":
            colon = len(words)
        elif tok.startswith("[") or tok == "...":
            array = True
        elif tok == ".":
            if words:
                words.pop()  # имя с пакетом: остаётся последнее
        elif tok != "?" and tok not in _MODIFIERS:
            words.append((tok, m.start()))
    else:
        return None
    return _finish(words, array, colon, f.kotlin, -1, -1, default, has_default)


def _finish(
    words: list[tuple[str, int]], array: bool, colon: int, kotlin: bool, init: int,
    init_end: int, default: str | None, has_default: bool,
) -> _Decl | None:
    if kotlin:
        if colon < 1:
            return None
        name, at = words[colon - 1]
        type_ = words[colon][0] if colon < len(words) else None
    else:
        if len(words) < 2:
            return None
        (type_, _), (name, at) = words[-2], words[-1]
    return _Decl(name, at, type_, array, init, init_end, default, has_default)


def _default_value(f: _File, at: int, end: int) -> str | None:
    """Значение @DefaultValue("d") на [at, end); None — не она или не литерал."""
    mask = f.code.mask
    if not re.match(r"@[ \t]*(?:[\w$.]+\.)?DefaultValue[ \t]*\(", mask[at:min(end, at + 300)]):
        return None
    paren = mask.index("(", at)
    args = jvm.args(f.outline, paren)
    if len(args) != 1 or not _STRING.fullmatch(mask, args[0].start, args[0].end):
        return None
    value, dynamic = jvm.literal(f.code, args[0].start, args[0].end)
    return None if dynamic else value


def _type_of(decl: _Decl | None) -> str | None:
    if decl is None:
        return None
    if decl.array:
        return "array"
    return _TYPES.get(decl.type or "")


def _initializer(f: _File, decl: _Decl) -> tuple[str | None, bool]:
    """Дефолт свойства: @DefaultValue, литерал инициализатора, иначе дефолт без значения."""
    if decl.has_default:
        return decl.default, True
    if decl.init < 0:
        return None, False
    mask = f.code.mask
    seg = mask[decl.init:decl.init_end]
    lo = decl.init + len(seg) - len(seg.lstrip())
    hi = decl.init + len(seg.rstrip())
    if hi <= lo:
        return None, False
    if _STRING.fullmatch(mask, lo, hi) and not f.code.joined(lo, hi):
        value, dynamic = jvm.literal(f.code, lo, hi)
        return (None if dynamic else value), True
    text = mask[lo:hi]
    if text in ("true", "false"):
        return text, True
    if _NUMBER.fullmatch(text):
        return text.rstrip("LlFfDd").replace("_", ""), True
    return None, True


# --- @Value -----------------------------------------------------------------------------


def _value_text(f: _File, ann: jvm.Annotation) -> str | None:
    """Строка аргумента @Value; None — аргумента нет или он не литерал (подсказка записана)."""
    if ann.args < 0:
        return None
    for arg in jvm.args(f.outline, ann.args):
        if arg.label is None or arg.label == "value":
            value = jvm.string_value(f.code, f.repo, f.rel, arg.start, arg.end)
            if value is None:
                clike.hint(
                    f.found, f.code.text[arg.start:arg.end][:80], texts.REASON_DYNAMIC_PARAM,
                    f.rel, f.code.line(ann.at),
                )
            return value
    return None


def _args(f: _File, opener: int) -> tuple[list[jvm.Arg], list[int]]:
    """Аргументы скобки opener по памяти файла; больше clike.MAX_READS — TooMany."""
    got = f.params.get(opener)
    if got is None:
        args = jvm.args(f.outline, opener, clike.MAX_READS)
        got = f.params[opener] = (args, [a.start for a in args])
    return got


def _param_of(f: _File, ann: jvm.Annotation, opener: int) -> _Decl | None:
    """Объявление параметра в скобках opener, в котором стоит аннотация."""
    args, starts = _args(f, opener)
    i = bisect_right(starts, ann.at) - 1
    if i < 0 or not args[i].start <= ann.at < args[i].end:
        return None
    return _declaration(f, ann.end, args[i].end)


def _member_decl(f: _File, ann: jvm.Annotation, member: jvm.Member | None) -> _Decl | None:
    if member is None:
        return None
    mask = f.code.mask
    if member.kind == "field":
        return _declaration(f, ann.end, member.at)
    if member.kind == "property":
        stop = mask.find("\n", member.at, member.at + 400)
        return _declaration(f, ann.end, stop if stop >= 0 else min(len(mask), member.at + 400))
    if member.kind == "method":
        args = _args(f, member.paren)[0]
        return _declaration(f, args[0].start, args[0].end) if len(args) == 1 else None
    return None


def _value(f: _File, ann: jvm.Annotation, member: jvm.Member | None, opener: int) -> None:
    text = _value_text(f, ann)
    if text is None or "#{" in text or "${" not in text:
        return
    found = jvmconf.placeholders(text)
    if not found:
        return
    whole = text.startswith("${") and _whole(text)
    decl = None
    if whole:
        is_param = opener >= 0 and f.code.mask[opener] == "("
        decl = _param_of(f, ann, opener) if is_param else _member_decl(f, ann, member)
    declared = _type_of(decl) if whole else None
    line = f.code.line(ann.at)
    for i, ph in enumerate(found):
        type_ = declared if i == 0 else None
        _add(f, CodeParam(
            name=ph.name, loc=Loc(f.rel, line), parser=NAME, default=ph.default,
            has_default=ph.has_default, required=not ph.has_default,
            type=type_ or jvmconf.value_type(ph.default),
        ))


def _whole(text: str) -> bool:
    """Значение — одна подстановка целиком: «${a:${b:c}}», а не «${a}/${b}»."""
    depth = 0
    for i, ch in enumerate(text):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i == len(text) - 1
    return False


# --- @ConfigurationProperties -----------------------------------------------------------


def _prefix(f: _File, ann: jvm.Annotation) -> str | None:
    """Префикс @ConfigurationProperties: prefix =, value = или первый аргумент; без
    аргументов — пустой; не литерал — None (подсказка записана)."""
    if ann.args < 0:
        return ""
    for arg in jvm.args(f.outline, ann.args):
        if arg.label is None or arg.label in _PREFIX_LABELS:
            value = jvm.string_value(f.code, f.repo, f.rel, arg.start, arg.end)
            if value is None:
                clike.hint(
                    f.found, f.code.text[arg.start:arg.end][:80], texts.REASON_DYNAMIC_PARAM,
                    f.rel, f.code.line(ann.at),
                )
            return value
    return ""


def _header_paren(f: _File, decl: jvm.Decl) -> int:
    """Скобка параметров заголовка (компоненты record, первичный конструктор Kotlin); -1 —
    нет. Параметры типа «<T>» перепрыгиваются."""
    mask = f.code.mask
    i = decl.name_end
    while i < len(mask) and mask[i] in " \t\r\n":
        i += 1
    if i < len(mask) and mask[i] == "<":
        i = jvm.type_args_end(mask, i, min(len(mask), i + 500))
        if i < 0:
            return -1
    m = _CTOR.match(mask, i)
    if m is None:
        return -1
    paren = m.end() - 1
    return paren if decl.body < 0 or paren < decl.body else -1


def _java_fields(f: _File, decl: jvm.Decl) -> list[_Decl]:
    """Поля класса Java на уровне тела (не static) с сеттером setИмя в теле или под Lombok.
    Инструкция кончается «;» уровня тела; скобки перепрыгиваются по парам, «(» до «=» —
    метод или конструктор (вместе с телом), «{» до «=» — тело вложенного типа или блок."""
    mask = f.code.mask
    lo, hi = decl.body + 1, decl.end
    setters = {m.group(1) for m in _SETTER.finditer(mask, lo, hi)}
    lombok = _lombok(f, decl)
    out: list[_Decl] = []
    if not setters and not lombok:
        return out
    start = i = lo
    assigned = False
    while i < hi:
        m = _STATEMENT.search(mask, i, hi)
        if m is None:
            break
        i, ch = m.start(), m.group()
        if ch == ";":
            _java_field(f, start, i, setters, lombok, out)
            start, i, assigned = i + 1, i + 1, False
        elif ch == "=":
            assigned, i = True, i + 1
        elif assigned or ch == "[":
            i = f.outline.close_of(i) + 1
        elif ch == "{":
            i = f.outline.close_of(i) + 1
            start = i
        else:
            # «(» до «=»: аргументы аннотации поля или параметры метода; у метода дальше «{».
            i = f.outline.close_of(i) + 1
            nxt = _STATEMENT.search(mask, i, hi)
            if nxt is not None and nxt.group() == "{":
                i = start = f.outline.close_of(nxt.start()) + 1
    return out


def _lombok(f: _File, decl: jvm.Decl) -> bool:
    """Над классом @Data или @Setter Lombok (между концом прошлой инструкции и словом class)."""
    mask = f.code.mask
    lo = max(0, decl.at - _HEAD)
    cut = max(mask.rfind(";", lo, decl.at), mask.rfind("}", lo, decl.at))
    return _LOMBOK.search(mask, cut + 1 if cut >= 0 else lo, decl.at) is not None


def _java_field(
    f: _File, lo: int, hi: int, setters: set[str], lombok: bool, out: list[_Decl],
) -> None:
    mask = f.code.mask
    eq = mask.find("=", lo, hi)
    head = mask[lo:eq if eq >= 0 else hi]
    if _STATIC.search(head) is not None:
        return
    last = _last_name(head)
    if last is None or not lombok and last[:1].upper() + last[1:] not in setters:
        return
    decl = _declaration(f, lo, hi)
    if decl is not None:
        _collect(out, decl)


def _last_name(head: str) -> str | None:
    """Последнее имя объявления «Тип имя[]»: без регулярного выражения с «$» по всей строке
    (на пробелах в мегабайт такой поиск квадратичен), окно в сто знаков с конца."""
    t = head.rstrip()
    for _ in range(8):
        if not t.endswith("]"):
            break
        k = t.rfind("[")
        if k < 0:
            return None
        t = t[:k].rstrip()
    m = _NAME_END.search(t, max(0, len(t) - 100))
    return m.group() if m is not None else None


def _collect(out: list[_Decl], decl: _Decl) -> None:
    """Свойство в список; больше clike.MAX_READS — TooMany (запись всё равно не пройдёт)."""
    out.append(decl)
    if len(out) > clike.MAX_READS:
        raise jvm.TooMany


def _kotlin_vars(f: _File, decl: jvm.Decl) -> list[_Decl]:
    """Свойства var тела класса Kotlin на уровне тела."""
    mask = f.code.mask
    hits = list(_KT_VAR.finditer(mask, decl.body + 1, decl.end))
    level = f.outline.enclosing(m.start() for m in hits)
    out: list[_Decl] = []
    for m in hits:
        if level.get(m.start()) != decl.body:
            continue
        stop = mask.find("\n", m.end(), m.end() + 400)
        got = _declaration(f, m.start(), stop if stop >= 0 else min(len(mask), m.end() + 400))
        if got is not None:
            _collect(out, got)
    return out


def _props(f: _File, decl: jvm.Decl) -> list[_Decl]:
    """Свойства класса свойств (по памяти файла: вложенный тип читается один раз)."""
    key = decl.at
    if key in f.props:
        return f.props[key]
    f.props[key] = []
    paren = _header_paren(f, decl) if decl.kind in ("record", "class") else -1
    out: list[_Decl] = []
    if paren >= 0 and (decl.kind == "record" or f.kotlin):
        for arg in _args(f, paren)[0]:
            got = _declaration(f, arg.start, arg.end)
            if got is not None:
                _collect(out, got)
    elif decl.body >= 0 and decl.kind == "class":
        out = _kotlin_vars(f, decl) if f.kotlin else _java_fields(f, decl)
    f.props[key] = out
    return out


def _properties(f: _File, ann: jvm.Annotation, decl: jvm.Decl, by_name: dict[str, list[jvm.Decl]]) -> None:
    prefix = _prefix(f, ann)
    if prefix is None:
        return
    for prop in _props(f, decl):
        name = ".".join(p for p in (prefix, dashed(prop.name)) if p)
        nested = by_name.get(prop.type or "", [])
        if len(nested) == 1 and nested[0] is not decl and not prop.array:
            for inner in _props(f, nested[0]):
                _property(f, f"{name}.{dashed(inner.name)}", inner)
            continue
        _property(f, name, prop)


def _property(f: _File, name: str, prop: _Decl) -> None:
    default, has_default = _initializer(f, prop)
    _add(f, CodeParam(
        name=name, loc=Loc(f.rel, f.code.line(prop.at)), parser=NAME, default=default,
        has_default=has_default, type=_type_of(prop) or jvmconf.value_type(default),
    ))


# --- разбор -----------------------------------------------------------------------------


def _parse_file(f: _File, hits: list[tuple[str, int, int, int]]) -> None:
    anns = jvm.bind_annotations(f.outline, hits)
    members = jvm.members(f.outline, anns)
    by_at = {d.at: d for d in f.outline.decls}
    by_name: dict[str, list[jvm.Decl]] = {}
    for d in f.outline.decls:
        by_name.setdefault(d.name, []).append(d)
    values = [a for a in anns if a.name == _VALUE]
    openers = f.outline.enclosing(a.at for a in values)
    for ann in anns:
        if ann.name == _VALUE:
            _value(f, ann, members.get(ann.at), openers.get(ann.at, -1))
        elif ann.name == _PROPERTIES:
            member = members.get(ann.at)
            if member is None or member.kind != "type":
                continue
            decl = by_at.get(member.at)
            if decl is not None and decl.kind in ("class", "record"):
                _properties(f, ann, decl, by_name)


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not jvm.stack_present(files, ctx, STACK):
        return found
    found.applied.add(NAME)
    repo = clike.Repo(files, ctx, codebase.JAVA, codetext.JAVA)
    for rel, code, language in jvm.sources(files, ctx, STACK, _NEEDLES):
        if language == codebase.JAVA:
            repo.note(rel, code)
        part = Findings()
        try:
            hits = jvm.annotation_hits(code, _NAMES)
            if not hits:
                continue
            outline = jvm.Outline.of(code)
            f = _File(rel, code, outline, repo if language == codebase.JAVA else None, part)
            _parse_file(f, hits)
        except jvm.TooMany:
            files.refuse(rel)
            continue
        found.code_params.extend(part.code_params)
        found.hints.extend(part.hints)
    return found
