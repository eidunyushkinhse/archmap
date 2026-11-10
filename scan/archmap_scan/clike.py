"""Общее для разборщиков параметров C# и Java (ТЗ §15 п. 14 Е4): имя чтения литералом или
константой, тип по обёртке разбора, каталоги тестов.

Поиск идёт по маске кода (codetext.CS, codetext.JAVA), значения литералов берутся из
исходного текста по тем же позициям. Каждое выражение начинается с литерала и ограничено
по длине, поэтому разбор линейный и на враждебном входе.

Имя константой раскрывается, только если константа объявлена строковым литералом в
репозитории (ТЗ §15 п. 14): поле с модификатором final, const или readonly
(«static final String X = "…";», «const string X = "…";») в том же файле, в файле класса
по «Класс.ИМЯ» (файл с именем класса в репозитории один или выбран импортом Java) или по
статическому импорту Java. Иначе — подсказка о динамическом имени.
"""

from __future__ import annotations

import re
from collections.abc import Iterator

from archmap_scan import codebase, codetext, paths, texts
from archmap_scan.codetext import SP
from archmap_scan.context import Context
from archmap_scan.model import CodeParam, Findings, Hint, Loc
from archmap_scan.walk import Files, package_start

_ID = r"[A-Za-z_][A-Za-z0-9_]{0,99}"
# Аргумент чтения сразу за «(» или «[»: строковый литерал (у C# и дословный @"…") или имя
# с точками, затем конец аргумента.
ARG = re.compile(
    rf"{SP}(?P<arg>@?\"[ ]*\"|{_ID}(?:[ \t]*\.[ \t]*{_ID}){{0,4}}){SP}(?P<end>[,)\]])"
)
LITERAL = re.compile(r'@?"[ ]*"')
_NAME = re.compile(rf"{_ID}(?:[ \t]*\.[ \t]*{_ID}){{0,4}}")
# Объявление строковой константы: «String ИМЯ = "…";» (модификатор проверяется по строке).
_DECL = re.compile(rf"\b(?:String|string)[ \t]+({_ID})[ \t]*=[ \t]*(\"[ ]*\")[ \t]*;")
_MODIFIER = re.compile(r"\b(?:final|const|readonly)\b")
# Импорт Java: «import a.b.Класс;» и «import static a.b.Класс.ИМЯ;» (или «.*»).
_IMPORT = re.compile(
    rf"^[ \t]*import[ \t]+(static[ \t]+)?({_ID}(?:\.{_ID}){{0,30}})(\.\*)?[ \t]*;", re.MULTILINE,
)
# Каталог тестов по имени (ТЗ §15 п. 14 Е4): Ordering.UnitTests/, Cart.Tests/, it-tests/.
# Каталоги test/ и tests/ исключает обход по соглашению (walk.CONVENTION_DIRS). С части 5б
# (ТЗ §15 п. 17 К2) ещё каталог, одна из частей имени которого через «-», «_» или «.» — test,
# tests, testsuite или testsuites (testsuite/ и test-framework/ Keycloak), и набор исходников
# Gradle с началом test и заглавной буквой (testFixtures/, testIntegration/). Слово внутри
# части имени не в счёт: latest/, contest/ и attestation/ — код.
_TEST_DIR = re.compile(r"(?:Tests?|[._-][Tt]ests?)$")
_TEST_PARTS = frozenset({"test", "tests", "testsuite", "testsuites"})
_TEST_CAMEL = re.compile(r"[Tt]est[A-Z]")
_PARTS = re.compile(r"[-_.]")
_MAX_STEPS = 8  # сколько звеньев «a.b.c» перед чтением просматривается
# Сколько чтений одного вида в файле разбирается. В настоящем коде их единицы и десятки;
# файл из одних «Configuration[» — враждебный вход, он считается непрочитанным.
MAX_READS = 2000
# Сколько импортов файла Java учитывается: в настоящем коде их десятки.
_MAX_IMPORTS = 500


def _test_segment(seg: str) -> bool:
    return (
        _TEST_DIR.search(seg) is not None or _TEST_CAMEL.match(seg) is not None
        or not _TEST_PARTS.isdisjoint(_PARTS.split(seg.lower()))
    )


def in_test_dir(rel: str) -> bool:
    """Файл в каталоге тестов по имени каталога: Cart.UnitTests/, Billing.Tests/,
    testsuite/, test-framework/. Сегменты пакета JVM под src/main/java/ и src/main/kotlin/ —
    имя пакета, а не каталог (walk.package_start)."""
    parts = rel.split("/")
    return any(_test_segment(seg) for seg in parts[:min(len(parts) - 1, package_start(parts))])


def matches(
    files: Files, rel: str, pattern: re.Pattern[str], mask: str,
) -> list[re.Match[str]] | None:
    """Совпадения pattern в маске файла; больше MAX_READS — файл отмечен непрочитанным (None)."""
    out: list[re.Match[str]] = []
    for m in pattern.finditer(mask):
        if len(out) == MAX_READS:
            files.refuse(rel)
            return None
        out.append(m)
    return out


def literal_value(code: codetext.Code, start: int, end: int) -> str:
    """Значение литерала по позициям маски: "…" или дословная строка C# @"…"."""
    if code.text[start] == "@":
        return code.text[start + 2:end - 1].replace('""', '"')
    return code.text[start + 1:end - 1]


def ident_before(mask: str, end: int) -> int | None:
    """Начало имени, которое кончается на позиции end (без пробелов), или None."""
    i = end
    while i > 0 and end - i < 100 and (mask[i - 1].isalnum() or mask[i - 1] == "_"):
        i -= 1
    if i == end or mask[i].isdigit():
        return None
    return i


def skip_back(mask: str, pos: int) -> int:
    """Позиция после последнего не пробельного знака перед pos (не дальше 200 знаков)."""
    i = pos
    while i > 0 and pos - i < 200 and mask[i - 1] in " \t\r\n":
        i -= 1
    return i


def chain_start(mask: str, pos: int) -> int:
    """Начало цепочки «a.b.Имя» перед позицией pos имени: builder.Configuration → builder."""
    start = pos
    for _ in range(_MAX_STEPS):
        dot = skip_back(mask, start)
        if dot == 0 or mask[dot - 1] != ".":
            break
        prev = ident_before(mask, skip_back(mask, dot - 1))
        if prev is None:
            break
        start = prev
    return start


def wrapped_type(mask: str, start: int, table: dict[str, str]) -> str | None:
    """Тип по вызову, аргумент которого начинается с позиции start: Integer.parseInt(…),
    bool.TryParse(…) — по таблице «Класс.метод» → тип."""
    paren = skip_back(mask, start)
    if paren == 0 or mask[paren - 1] != "(":
        return None
    end = skip_back(mask, paren - 1)
    method = ident_before(mask, end)
    if method is None:
        return None
    dot = skip_back(mask, method)
    if dot == 0 or mask[dot - 1] != ".":
        return None
    cls_end = skip_back(mask, dot - 1)
    cls = ident_before(mask, cls_end)
    if cls is None:
        return None
    return table.get(f"{mask[cls:cls_end]}.{mask[method:end]}")


class Repo:
    """Строковые константы файлов языка и файлы по имени класса (один на запуск)."""

    def __init__(self, files: Files, ctx: Context, language: str, lang: str) -> None:
        self.files = files
        self.lang = lang
        self.language = language
        self._by_stem: dict[str, list[str]] | None = None
        self._consts: dict[str, dict[str, tuple[str, Loc] | None]] = {}
        self._imports: dict[str, list[tuple[bool, str, bool]]] = {}
        self._resolved: dict[tuple[str, str], tuple[str, Loc] | None] = {}

    def note(self, rel: str, code: codetext.Code) -> None:
        """Константы и импорты уже разобранного файла (второй раз маска не считается)."""
        if rel not in self._consts:
            self._consts[rel] = _constants(rel, code)
            self._imports[rel] = _imports(code)

    def _load(self, rel: str) -> None:
        if rel in self._consts:
            return
        text = self.files.read(rel, keep=False)
        code = codetext.load(self.files, rel, text, self.lang) if text is not None else None
        self._consts[rel] = _constants(rel, code) if code is not None else {}
        self._imports[rel] = _imports(code) if code is not None else []

    def by_stem(self) -> dict[str, list[str]]:
        """Файлы кода языка по имени без расширения (считается при первом «Класс.ИМЯ»)."""
        if self._by_stem is None:
            self._by_stem = {}
            for rel in self.files.paths:
                if codebase.is_code_file(rel, self.language):
                    name = paths.name(rel)
                    self._by_stem.setdefault(name[:name.rfind(".")], []).append(rel)
        return self._by_stem

    def _class_file(self, rel: str, cls: str) -> str | None:
        """Файл класса cls для файла rel: единственный в репозитории, выбранный импортом
        Java или лежащий в том же каталоге (тот же пакет)."""
        cands = self.by_stem().get(cls, [])
        if len(cands) <= 1:
            return cands[0] if cands else None
        self._load(rel)
        for static, path, _ in self._imports.get(rel, []):
            if not static and path.rsplit(".", 1)[-1] == cls:
                tail = path.replace(".", "/") + "." + paths.name(cands[0]).rsplit(".", 1)[-1]
                hits = [c for c in cands if c == tail or c.endswith("/" + tail)]
                if len(hits) == 1:
                    return hits[0]
        same = [c for c in cands if paths.parent(c) == paths.parent(rel)]
        return same[0] if len(same) == 1 else None

    def _in(self, rel: str | None, name: str) -> tuple[str, Loc] | None:
        if rel is None:
            return None
        self._load(rel)
        return self._consts[rel].get(name)

    def resolve(self, rel: str, ident: str) -> tuple[str, Loc] | None:
        """Значение и место объявления константы ident («ИМЯ» или «…Класс.ИМЯ») для чтения
        в файле rel; None — константы-литерала не нашлось или она неоднозначна."""
        key = (rel, ident)
        if key not in self._resolved:
            self._resolved[key] = self._resolve(rel, ident)
        return self._resolved[key]

    def _resolve(self, rel: str, ident: str) -> tuple[str, Loc] | None:
        parts = [p.strip() for p in ident.split(".")]
        if len(parts) >= 2:
            return self._in(self._class_file(rel, parts[-2]), parts[-1])
        name = parts[0]
        hit = self._in(rel, name)
        if hit is not None:
            return hit
        for static, path, star in self._imports.get(rel, []):
            if not static:
                continue
            pieces = path.split(".")
            if star and len(pieces) >= 1:
                hit = self._in(self._class_file(rel, pieces[-1]), name)
            elif not star and pieces[-1] == name and len(pieces) >= 2:
                hit = self._in(self._class_file(rel, pieces[-2]), name)
            if hit is not None:
                return hit
        return None


def _constants(rel: str, code: codetext.Code) -> dict[str, tuple[str, Loc] | None]:
    """Строковые константы файла: имя → (значение, место); одно имя дважды — None."""
    out: dict[str, tuple[str, Loc] | None] = {}
    mask = code.mask
    for m in _DECL.finditer(mask):
        line_start = mask.rfind("\n", 0, m.start()) + 1
        if not _MODIFIER.search(mask, max(line_start, m.start() - 200), m.start()):
            continue
        name = m.group(1)
        value = (code.text[m.start(2) + 1:m.end(2) - 1], Loc(rel, code.line(m.start())))
        out[name] = None if name in out else value
    return out


def _imports(code: codetext.Code) -> list[tuple[bool, str, bool]]:
    """Импорты Java: (статический, путь, «.*» в конце)."""
    out: list[tuple[bool, str, bool]] = []
    for m in _IMPORT.finditer(code.mask):
        if len(out) == _MAX_IMPORTS:
            break
        out.append((m.group(1) is not None, m.group(2), m.group(3) is not None))
    return out


def hint(found: Findings, name: str, reason: str, rel: str, line: int) -> None:
    found.hints.append(Hint("dynamic_names", {
        "kind": "config", "name": name, "reason": reason, "source": str(Loc(rel, line)),
    }))


def arg_value(
    code: codetext.Code, repo: Repo, rel: str, arg: re.Match[str],
) -> tuple[str, list[Loc]] | None:
    """Значение аргумента-имени arg (совпадение ARG) и места объявления константы: литерал
    как есть, имя — константа репозитория; None — константы-литерала нет."""
    start, end = arg.span("arg")
    if LITERAL.fullmatch(code.mask, start, end):
        return literal_value(code, start, end), []
    hit = repo.resolve(rel, code.mask[start:end])
    return None if hit is None else (hit[0], [hit[1]])


def read(
    found: Findings, repo: Repo, code: codetext.Code, rel: str, at: int,
    arg: re.Match[str] | None, parser: str, valid: re.Pattern[str], *,
    default: str | None = None, has_default: bool = False, required: bool | None = None,
    type_: str | None = None, prefix: str = "",
) -> None:
    """Чтение параметра с аргументом-именем arg (совпадение ARG) на позиции at: литерал —
    параметр, имя — константа репозитория или подсказка, прочее выражение — подсказка.
    prefix ставится перед именем: «ConnectionStrings:» у GetConnectionString, раздел у
    чтения из переменной раздела (ТЗ §15 п. 16 Р1)."""
    line = code.line(at)
    if arg is None:
        expr = code.expression(at)
        reason = texts.REASON_JOINED_NAME if "+" in expr else texts.REASON_DYNAMIC_PARAM
        hint(found, expr, reason, rel, line)
        return
    start, end = arg.span("arg")
    got = arg_value(code, repo, rel, arg)
    if got is None:
        hint(found, code.text[start:end][:80], texts.REASON_DYNAMIC_PARAM, rel, line)
        return
    value, extra = prefix + got[0], got[1]
    if not valid.fullmatch(value):
        hint(found, code.text[start:end][:80], texts.REASON_DYNAMIC_PARAM, rel, line)
        return
    found.code_params.append(CodeParam(
        name=value, loc=Loc(rel, line), parser=parser, default=default,
        has_default=has_default, required=required, type=type_, extra_locs=extra,
    ))


def sources(
    files: Files, ctx: Context, language: str, lang: str, needles: tuple[str, ...], repo: Repo,
) -> Iterator[tuple[str, codetext.Code]]:
    """Файлы кода языка с одной из needles, кроме каталогов тестов по имени."""
    for rel, text in codebase.sources(files, ctx, language, None, needles):
        if in_test_dir(rel):
            continue
        code = codetext.load(files, rel, text, lang)
        if code is not None:
            repo.note(rel, code)
            yield rel, code
