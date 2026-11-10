"""Общее для разборщиков кода Java и Kotlin (ТЗ §15 п. 17): файлы пакетов по стеку, классы,
аннотации и их аргументы.

Стек пакета — ближайший вверх манифест сборки языка (pom.xml или build.gradle; Kotlin — Gradle
с плагином Kotlin, manifests._GRADLE_KOTLIN) и его зависимости по именам артефактов Maven:
зависимость совпадает с ключом, если равна ему или начинается с «ключ-» или «ключ_»
(spring-boot-starter-web у ключа spring-boot, jboss-jaxrs-api_2.1_spec у jboss-jaxrs-api).
Файлы .java читаются у пакетов Java, .kt — у пакетов Kotlin; каталоги тестов по имени
(clike.in_test_dir) не читаются, src/test/ исключён обходом.

Разбор идёт по маске кода (codetext.JAVA, codetext.KOTLIN) одним проходом: пары скобок
считаются стеком один раз на файл, классы и члены класса находятся прыжками по парам, поэтому
время линейно и на враждебном входе. Больше MAX_BRACKETS скобок или MAX_CLASSES объявлений в
файле — файл непрочитан (враждебный вход).
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field

from archmap_scan import clike, codebase, codetext
from archmap_scan.context import Context
from archmap_scan.model import Package
from archmap_scan.walk import Files

LANGUAGES = (codebase.JAVA, codebase.KOTLIN)
MASKS = {codebase.JAVA: codetext.JAVA, codebase.KOTLIN: codetext.KOTLIN}
# Пределы против враждебного входа: в настоящем коде скобок десятки тысяч на файл, классов —
# единицы и десятки.
MAX_BRACKETS = 400_000
MAX_CLASSES = clike.MAX_READS
_HEADER = 3000  # сколько знаков после имени класса ищется тело «{»
_MEMBER = 3000  # сколько знаков после аннотации ищется объявление члена класса

_ID = r"[A-Za-z_][A-Za-z0-9_]{0,99}"
ID = re.compile(_ID)
_BRACKETS = re.compile(r"[(){}\[\]]")
_OPEN = {")": "(", "}": "{", "]": "["}
# Объявление типа: class, interface, enum, record (Java), object (Kotlin) и имя за ним. Перед
# словом не «.» и не «::» (X.class, X::class — литерал класса, а не объявление).
_DECL = re.compile(
    rf"(?<![\w.:@])(class|interface|enum|record|object)[ \t\r\n]+"
    rf"(?!(?:class|interface|object)(?![A-Za-z0-9_]))({_ID})"
)
# Знаки, на которых заголовок типа кончается или продолжается скобками; у Kotlin ещё перевод
# строки (тело может начаться на следующей строке только после «:», «{», «,» или where).
_HEADER_STOP = re.compile(r"[(\[{;})\]=]")
_KT_HEADER_STOP = re.compile(r"[(\[{;})\]=\n]")
_KEYWORDS = frozenset({"class", "interface", "enum", "record", "object"})
_SPACE = " \t\r\n"


def jvm_match(dep: str, key: str) -> bool:
    """Артефакт Maven или Gradle dep совпадает с ключом key: равен ему или начинается с «key-»
    или «key_» (без учёта регистра)."""
    low = dep.lower()
    return low == key or low.startswith((key + "-", key + "_"))


def reads(deps: Iterable[str], keys: Iterable[str]) -> bool:
    """Среди зависимостей пакета есть артефакт одного из ключей."""
    wanted = tuple(keys)
    return any(jvm_match(d, k) for d in deps for k in wanted)


def packages(files: Files, ctx: Context, keys: Iterable[str] | None = None) -> list[Package]:
    """Пакеты Java и Kotlin (с зависимостью одного из keys, если задано)."""
    wanted = tuple(keys) if keys is not None else None
    return [
        p for p in codebase.packages(files, ctx)
        if p.language in LANGUAGES and (wanted is None or reads(p.deps, wanted))
    ]


def stack_present(files: Files, ctx: Context, keys: Iterable[str] | None = None) -> bool:
    return bool(packages(files, ctx, keys))


def deps_of(files: Files, ctx: Context, rel: str, language: str) -> frozenset[str]:
    return codebase.deps_of(files, ctx, rel, language)


def sources(
    files: Files, ctx: Context, keys: Iterable[str] | None, needles: tuple[str, ...],
) -> Iterator[tuple[str, codetext.Code, str]]:
    """(файл, код, язык) Java и Kotlin пакетов на стеке keys (None — любой пакет языка) с одной
    из подстрок needles, кроме каталогов тестов по имени."""
    wanted = tuple(keys) if keys is not None else None
    for language in LANGUAGES:
        for rel, text in codebase.sources(files, ctx, language, None, needles):
            if clike.in_test_dir(rel):
                continue
            if wanted is not None and not reads(deps_of(files, ctx, rel, language), wanted):
                continue
            code = codetext.load(files, rel, text, MASKS[language])
            if code is not None:
                yield rel, code, language


class TooMany(Exception):
    """В файле больше скобок, объявлений или записей, чем разбирается: файл непрочитан."""


def literal(code: codetext.Code, start: int, end: int) -> tuple[str, bool]:
    """Значение строкового литерала маски [start, end) и признак шаблона Kotlin («$x»,
    «${…}»: значение известно только при запуске). Экранированный «\\$» Kotlin — знак «$»."""
    value = code.text[start + 1:end - 1]
    if code.lang != codetext.KOTLIN or "$" not in value:
        return value, False
    dynamic = re.search(r"(?<!\\)\$(?:\{|[A-Za-z_])", value) is not None
    return value.replace("\\$", "$"), dynamic


@dataclass
class Decl:
    """Объявление типа: вид (class, interface, enum, record, object), имя, позиция слова вида
    и границы тела «{ … }» (body = -1, если тела нет)."""

    kind: str
    name: str
    at: int
    name_end: int
    body: int = -1
    end: int = -1


@dataclass
class Outline:
    """Пары скобок и объявления типов файла кода Java или Kotlin."""

    code: codetext.Code
    pairs: dict[int, int] = field(default_factory=dict)
    decls: list[Decl] = field(default_factory=list)
    by_body: dict[int, Decl] = field(default_factory=dict)
    # События скобок по порядку: позиция и открывающая ли (у закрывающих — только парные).
    _events: list[tuple[int, bool]] = field(default_factory=list)

    @classmethod
    def of(cls, code: codetext.Code) -> Outline:
        out = cls(code)
        out._pair_up()
        out._declarations()
        return out

    def _pair_up(self) -> None:
        stack: list[tuple[str, int]] = []
        mask = self.code.mask
        if sum(mask.count(ch) for ch in "(){}[]") > MAX_BRACKETS:
            raise TooMany
        events = self._events
        for m in _BRACKETS.finditer(mask):
            ch = m.group()
            if ch in "({[":
                stack.append((ch, m.start()))
                events.append((m.start(), True))
            elif stack and stack[-1][0] == _OPEN[ch]:
                self.pairs[stack.pop()[1]] = m.start()
                events.append((m.start(), False))

    def close_of(self, pos: int) -> int:
        """Позиция парной закрывающей скобки к открывающей на pos; нет пары — конец текста."""
        return self.pairs.get(pos, len(self.code.mask))

    def enclosing(self, positions: Iterable[int]) -> dict[int, int]:
        """Для каждой позиции — открывающая скобка, внутри которой она лежит ближе всего (-1 —
        вне скобок). Один проход по событиям скобок и отсортированным позициям."""
        out: dict[int, int] = {}
        stack: list[int] = []
        events = self._events
        i = 0
        for pos in sorted(set(positions)):
            while i < len(events) and events[i][0] < pos:
                at, opening = events[i]
                if opening:
                    stack.append(at)
                elif stack:
                    stack.pop()
                i += 1
            out[pos] = stack[-1] if stack else -1
        return out

    def _declarations(self) -> None:
        mask = self.code.mask
        kotlin = self.code.lang == codetext.KOTLIN
        found: list[re.Match[str]] = []
        for m in _DECL.finditer(mask):
            if len(found) >= MAX_CLASSES:
                raise TooMany
            found.append(m)
        for i, m in enumerate(found):
            decl = Decl(m.group(1), m.group(2), m.start(), m.end())
            # Заголовок типа кончается до следующего объявления: так заголовки не
            # перекрываются, и проход по ним линеен на враждебном входе.
            limit = found[i + 1].start() if i + 1 < len(found) else len(mask)
            body = self._body_after(m.end(), kotlin, limit)
            if body >= 0:
                decl.body, decl.end = body, self.close_of(body)
                self.by_body[body] = decl
            self.decls.append(decl)

    def _body_after(self, pos: int, kotlin: bool, limit: int) -> int:
        """Позиция «{» тела типа, имя которого кончается на pos; -1 — тела нет (Kotlin data
        class без тела, объявление вперёд). Скобки заголовка перепрыгиваются по парам."""
        mask = self.code.mask
        stop = min(limit, pos + _HEADER)
        stops = _KT_HEADER_STOP if kotlin else _HEADER_STOP
        i = pos
        while i < stop:
            m = stops.search(mask, i, stop)
            if m is None:
                return -1
            i = m.start()
            ch = mask[i]
            if ch in "([":
                i = self.close_of(i) + 1
                continue
            if ch == "{":
                return i
            if ch == "\n":
                j = i + 1
                while j < stop and mask[j] in _SPACE:
                    j += 1
                k = clike.skip_back(mask, i)
                after_mark = k > pos and mask[k - 1] in ":,"
                if (
                    not after_mark and j < stop and mask[j] not in ":{,"
                    and not mask.startswith("where", j)
                ):
                    return -1
                i = j
                continue
            return -1
        return -1

    def owners(self, positions: Iterable[int]) -> dict[int, Decl]:
        """Позиция → тип, в теле которого она лежит на уровне членов (между ней и телом нет
        другой открытой скобки: тела метода, списка параметров, аргументов аннотации)."""
        out: dict[int, Decl] = {}
        for pos, opener in self.enclosing(positions).items():
            decl = self.by_body.get(opener)
            if decl is not None:
                out[pos] = decl
        return out


@dataclass
class Annotation:
    """Аннотация: имя без пакета, позиция «@», границы скобок аргументов (args = -1 — без
    скобок) и позиция сразу после неё."""

    name: str
    at: int
    args: int
    end: int


@dataclass
class Arg:
    """Аргумент аннотации или вызова: имя «name =» (None — позиционный) и границы значения."""

    label: str | None
    start: int
    end: int


# Аннотация с пакетом или без; у Kotlin бывает цель применения «@field:Value», «@get:Path».
_ANNOT_NAME = re.compile(
    rf"@[ \t]*(?:(?:field|get|set|param|property|setparam|receiver|delegate|file)[ \t]*:[ \t]*)?"
    rf"((?:{_ID}[ \t]*\.[ \t]*){{0,8}})({_ID})"
)
_LABEL = re.compile(rf"[ \t\r\n]*({_ID})[ \t\r\n]*=(?!=)")


def annotation_hits(code: codetext.Code, names: frozenset[str]) -> list[tuple[str, int, int, int]]:
    """Аннотации с именами из names (без пакета, @org.x.Path тоже Path) в маске файла: имя,
    позиция «@», позиция «(» аргументов (-1 — без скобок) и конец имени. Скобки ещё не
    сопоставлены, поэтому файл без нужных аннотаций дальше не разбирается; больше
    clike.MAX_READS — TooMany."""
    mask = code.mask
    out: list[tuple[str, int, int, int]] = []
    for m in _ANNOT_NAME.finditer(mask):
        if m.group(2) not in names:
            continue
        if len(out) >= clike.MAX_READS:
            raise TooMany
        j = m.end()
        while j < len(mask) and mask[j] in " \t":
            j += 1
        out.append((m.group(2), m.start(), j if j < len(mask) and mask[j] == "(" else -1, m.end()))
    return out


def bind_annotations(outline: Outline, hits: list[tuple[str, int, int, int]]) -> list[Annotation]:
    """Аннотации по находкам annotation_hits с концом по парной скобке аргументов."""
    return [
        Annotation(name, at, paren, outline.close_of(paren) + 1 if paren >= 0 else name_end)
        for name, at, paren, name_end in hits
    ]


def annotation_end(outline: Outline, at: int, stop: int) -> int:
    """Позиция сразу после аннотации, «@» которой стоит на at (с аргументами в скобках по
    паре); -1 — на at не аннотация."""
    mask = outline.code.mask
    m = _ANNOT_NAME.match(mask, at, stop)
    if m is None:
        return -1
    j = m.end()
    while j < stop and mask[j] in " \t":
        j += 1
    return outline.close_of(j) + 1 if j < stop and mask[j] == "(" else m.end()


def find_annotations(outline: Outline, names: frozenset[str]) -> list[Annotation]:
    """Аннотации с именами из names в файле (annotation_hits и bind_annotations вместе)."""
    return bind_annotations(outline, annotation_hits(outline.code, names))


def args(outline: Outline, open_paren: int, limit: int | None = None) -> list[Arg]:
    """Аргументы в скобках, открытых на позиции open_paren: границы на уровне этих скобок
    (вложенные скобки перепрыгиваются по парам, проход шагами по скобкам и запятым). Больше
    limit аргументов — TooMany (враждебный вход: список параметров в сотни тысяч)."""
    mask = outline.code.mask
    close = outline.close_of(open_paren)
    out: list[Arg] = []
    start = open_paren + 1
    i = start
    while i < close:
        m = _ARG_MARK.search(mask, i, close)
        if m is None:
            break
        i = m.start()
        if mask[i] in "({[":
            i = outline.close_of(i) + 1
            continue
        if mask[i] == ",":
            _arg(mask, start, i, out)
            start = i + 1
            if limit is not None and len(out) > limit:
                raise TooMany
        i += 1
    _arg(mask, start, min(close, len(mask)), out)
    return out


_ARG_MARK = re.compile(r"[({\[,]")


def _arg(mask: str, lo: int, hi: int, out: list[Arg]) -> None:
    lo, hi = _trim(mask, lo, hi)
    if hi <= lo:
        return
    label = _LABEL.match(mask, lo, hi)
    if label is not None:
        lo, hi = _trim(mask, label.end(), hi)
        out.append(Arg(label.group(1), lo, hi))
    else:
        out.append(Arg(None, lo, hi))


def _trim(mask: str, lo: int, hi: int) -> tuple[int, int]:
    """Границы [lo, hi) без пробелов по краям (срезом: длинный пробел маски за один шаг)."""
    seg = mask[lo:hi]
    left = len(seg) - len(seg.lstrip(_SPACE))
    if left == len(seg):
        return lo, lo
    return lo + left, hi - (len(seg) - len(seg.rstrip(_SPACE)))


_ARRAY_CALL = re.compile(r"(?:arrayOf|listOf|setOf)[ \t]*\(")


def items(outline: Outline, arg: Arg) -> list[tuple[int, int]]:
    """Элементы значения аргумента: массив Java «{a, b}», Kotlin «[a, b]» или arrayOf(a, b) —
    по элементу, иначе само значение."""
    mask = outline.code.mask
    lo, hi = arg.start, arg.end
    if lo >= hi:
        return []
    opener = -1
    if mask[lo] in "{[" and outline.close_of(lo) == hi - 1:
        opener = lo
    else:
        call = _ARRAY_CALL.match(mask, lo, hi)
        if call is not None and outline.close_of(call.end() - 1) == hi - 1:
            opener = call.end() - 1
    if opener < 0:
        return [(lo, hi)]
    return [(a.start, a.end) for a in args(outline, opener) if a.label is None]


_STRING = re.compile(r'"[ ]*"')
_CONST_NAME = re.compile(rf"{_ID}(?:[ \t]*\.[ \t]*{_ID}){{0,4}}")


def string_value(
    code: codetext.Code, repo: clike.Repo | None, rel: str, start: int, end: int,
) -> str | None:
    """Строка значения [start, end): литерал без подстановок Kotlin или строковая константа
    репозитория (clike.Repo) по имени; иначе None (выражение, склейка, шаблон)."""
    mask = code.mask
    if _STRING.fullmatch(mask, start, end):
        if code.joined(start, end):
            return None
        value, dynamic = literal(code, start, end)
        return None if dynamic else value
    if repo is not None and _CONST_NAME.fullmatch(mask, start, end):
        hit = repo.resolve(rel, mask[start:end])
        return hit[0] if hit is not None else None
    return None


@dataclass(frozen=True)
class Member:
    """Член класса под аннотацией: вид и позиции. method — позиция имени и «(» параметров,
    type — позиция слова вида (class, interface…), field — позиция конца объявления поля
    Java («;», «=»), property — позиция имени свойства Kotlin после val или var."""

    kind: str
    at: int
    paren: int = -1


# Что важно на пути от аннотации к члену класса: другие аннотации, скобки, конец
# объявления, параметры типа и слова вида и свойства; прочие слова (модификаторы, типы)
# движок перепрыгивает сам, поэтому проход идёт шагами по важным знакам.
_MEMBER_TOKEN = re.compile(
    r"[@(<{;=}]|(?<![\w$.])(?:class|interface|enum|record|object|val|var)(?![\w$])"
)
_PROPERTY = frozenset({"val", "var"})


def members(outline: Outline, anns: list[Annotation]) -> dict[int, Member | None]:
    """Член класса каждой аннотации (по позиции «@»). Аннотации разбираются с конца файла:
    проход от аннотации кончается на следующей аннотации списка и берёт её ответ (они
    стоят над одним членом), поэтому участки не перекрываются и время линейно."""
    out: dict[int, Member | None] = {}
    starts = sorted({a.at for a in anns})
    ends = {a.at: a.end for a in anns}
    for i in range(len(starts) - 1, -1, -1):
        at = starts[i]
        nxt = starts[i + 1] if i + 1 < len(starts) else -1
        out[at] = _member(outline, ends[at], nxt, out)
    return out


def _member(
    outline: Outline, pos: int, nxt: int, memo: dict[int, Member | None],
) -> Member | None:
    """Член класса для аннотации, кончающейся на pos: другие аннотации, модификаторы, тип и
    параметры типа перепрыгиваются. nxt — позиция следующей разобранной аннотации."""
    mask = outline.code.mask
    stop = min(len(mask), pos + _MEMBER)
    kotlin = outline.code.lang == codetext.KOTLIN
    i = pos
    while i < stop:
        m = _MEMBER_TOKEN.search(mask, i, stop)
        if m is None:
            return None
        i = m.start()
        if i == nxt:
            return memo.get(nxt)
        tok = m.group()
        if tok == "@":
            a = _ANNOT_NAME.match(mask, i)
            if a is None:
                return None
            j = a.end()
            while j < stop and mask[j] in " \t":
                j += 1
            i = outline.close_of(j) + 1 if j < stop and mask[j] == "(" else a.end()
            continue
        if tok == "(":
            name_end = clike.skip_back(mask, i)
            name_start = clike.ident_before(mask, name_end)
            return Member("method", name_start, i) if name_start is not None else None
        if tok in "{;=}":
            return Member("field", i)
        if tok == "<":
            i = type_args_end(mask, i, stop)
            if i < 0:
                return None
            continue
        if tok in _KEYWORDS:
            return Member("type", i)
        if kotlin:
            name = ID.search(mask, m.end(), stop)
            return Member("property", name.start()) if name is not None else None
        i = m.end()
    return None


def type_args_end(mask: str, i: int, stop: int) -> int:
    """Позиция после «>», закрывающей параметры типа с «<» на i; -1 — не закрыты."""
    depth = 0
    for m in _ANGLE.finditer(mask, i, stop):
        ch = m.group()
        if ch == "<":
            depth += 1
        elif ch == ">":
            depth -= 1
            if depth == 0:
                return m.end()
        else:
            return -1
    return -1


_ANGLE = re.compile(r"[<>(){};]")


def return_type(outline: Outline, name_start: int, paren: int) -> str | None:
    """Простое имя возвращаемого типа метода: Java — имя перед именем метода (без пакета и
    параметров типа), Kotlin — тип после «):». None — не видно (Kotlin без типа: Unit)."""
    mask = outline.code.mask
    if outline.code.lang == codetext.KOTLIN:
        j = outline.close_of(paren) + 1
        while j < len(mask) and mask[j] in " \t":
            j += 1
        if j >= len(mask) or mask[j] != ":":
            return None
        j += 1
        while j < len(mask) and mask[j] in " \t":
            j += 1
        m = _CONST_NAME.match(mask, j)
        return re.sub(r"[ \t]", "", m.group()).rsplit(".", 1)[-1] if m is not None else None
    end = clike.skip_back(mask, name_start)
    if end > 0 and mask[end - 1] == ">":
        depth = 0
        i = end - 1
        while i > 0 and end - i < 500:
            if mask[i] == ">":
                depth += 1
            elif mask[i] == "<":
                depth -= 1
                if depth == 0:
                    break
            i -= 1
        end = clike.skip_back(mask, i)
    if end > 1 and mask[end - 2:end] == "[]":
        return None
    start = clike.ident_before(mask, end)
    return mask[start:end] if start is not None else None


def template(path: str) -> str:
    """Путь с переменными как у фреймворка: «{id:[0-9]+}» и «{version : v\\d+}» пишутся «{id}»
    и «{version}», «index.{html:html}» — «index.{html}»; прочее как написано. Конец переменной
    — парная «}» (у регулярного выражения бывают свои «{2}»); проход один."""
    if "{" not in path or ":" not in path:
        return path
    out: list[str] = []
    i = 0
    size = len(path)
    while i < size:
        ch = path[i]
        if ch != "{":
            out.append(ch)
            i += 1
            continue
        depth = 0
        j = i
        while j < size:
            if path[j] == "{":
                depth += 1
            elif path[j] == "}":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        if j >= size:
            out.append(path[i:])
            break
        name = path[i + 1:j].split(":", 1)[0].strip()
        out.append("{" + name + "}" if name else path[i:j + 1])
        i = j + 1
    return "".join(out)


_EXTENDS = re.compile(rf"(?<![\w$.])extends[ \t\r\n]+({_ID}(?:[ \t]*\.[ \t]*{_ID}){{0,8}})")
_KT_SUPER = re.compile(
    rf"({_ID}(?:[ \t]*\.[ \t]*{_ID}){{0,8}})[ \t\r\n]*(?:<[^<>(){{}};]{{0,200}}>)?[ \t\r\n]*\("
)


def superclass(outline: Outline, decl: Decl) -> str | None:
    """Простое имя базового класса: Java — после extends, Kotlin — тип с «(» после «:»
    заголовка (class A(x: Int) : B(x), C). None — базового класса нет или тела нет."""
    if decl.body < 0:
        return None
    mask = outline.code.mask
    start, end = decl.name_end, decl.body
    if outline.code.lang != codetext.KOTLIN:
        m = _EXTENDS.search(mask, start, end)
        return _simple(m.group(1)) if m is not None else None
    i = start
    while i < end:
        hit = _KT_HEADER_MARK.search(mask, i, end)
        if hit is None:
            return None
        i = hit.start()
        if mask[i] in "([":
            i = outline.close_of(i) + 1
            continue
        m = _KT_SUPER.search(mask, i + 1, end)
        return _simple(m.group(1)) if m is not None else None
    return None


_KT_HEADER_MARK = re.compile(r"[(\[:]")


def _simple(name: str) -> str:
    return re.sub(r"[ \t]", "", name).rsplit(".", 1)[-1]


_MODIFIER_END = re.compile(r"[;{}]")


def is_abstract(outline: Outline, decl: Decl) -> bool:
    """Перед словом вида (до конца прошлой инструкции, не дальше 300 знаков) стоит abstract."""
    mask = outline.code.mask
    lo = max(0, decl.at - 300)
    cut = max(mask.rfind(";", lo, decl.at), mask.rfind("{", lo, decl.at), mask.rfind("}", lo, decl.at))
    head = mask[(cut + 1 if cut >= 0 else lo):decl.at]
    return re.search(r"(?<![\w$])abstract(?![\w$])", head) is not None
