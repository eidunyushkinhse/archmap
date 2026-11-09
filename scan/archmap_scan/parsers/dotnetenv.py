"""Параметры конфигурации в коде C# (ТЗ §15 п. 14 Е4): Configuration["X"] и
configuration["X"] (у builder.Configuration, _configuration и любого имени configuration;
ключ с двоеточием «A:B» — параметр с именем как написано) и
Environment.GetEnvironmentVariable("X"). Дефолт — литерал после «??»; «?? throw» — параметр
обязателен. Тип — по обёртке разбора (bool.TryParse(…) — bool, int.Parse(…) — int,
Convert.ToInt32(…) — int, TimeSpan.Parse(…) — duration), иначе по дефолту. Имя константой
раскрывается по правилам clike.py, иначе — подсказка о динамическом имени.

Configuration.GetSection("X") сам по себе — раздел, а не параметр. Запись
«Configuration["X"] = …» не чтение. Подстановки интерполированных строк
$"{configuration["X"]}/…" — код (маска codetext.CS). Стек — проект .NET (*.csproj);
каталоги тестов по имени (Cart.UnitTests/) не читаются.

Часть 5 (ТЗ §15 п. 16 Р1): GetValue<T>("A:B") и GetValue<T>("A:B", дефолт) — параметр с типом
по T и дефолтом-литералом; GetConnectionString("x") — параметр ConnectionStrings:x. Раздел
GetSection("A") или GetRequiredSection("A") с .Get<T>(), .Bind(obj) (T — тип obj по
объявлению в файле) или аргументом Configure<T>(…) и AddOptions<T>().Bind(…), а также
AddOptions<T>().BindConfiguration("A") дают параметры A:Свойство по публичным свойствам класса
T с set или init (тип по типу свойства, дефолт по литералу инициализатора, required по слову
required). Класс ищется в файлах того же проекта (каталог .csproj) один раз, вложенные классы
не раскрываются; класса нет — один параметр A с типом T как написан. Имя раздела литералом,
константой (clike) или nameof(Класс); переменная раздела (var s = configuration.GetSection("A"))
ставит раздел перед ключами GetValue, GetSection и привязок через неё.
"""

from __future__ import annotations

import re
from bisect import bisect_right
from dataclasses import dataclass

from archmap_scan import clike, codebase, codetext, paths, secrets, texts
from archmap_scan.codetext import SP
from archmap_scan.context import Context
from archmap_scan.model import CodeParam, Findings, Loc
from archmap_scan.walk import Files

NAME = "dotnet-env"
_NEEDLES = (
    "Configuration[", "configuration[", "GetEnvironmentVariable(", "GetValue",
    "GetConnectionString", "GetSection", "GetRequiredSection", "BindConfiguration",
)
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


# Часть 5 (Р1): чтения через биндер конфигурации и разделы.
_ID = r"[A-Za-z_][A-Za-z0-9_]{0,99}"
_TYPE = rf"{_ID}(?:\.{_ID}){{0,6}}(?:<[A-Za-z0-9_.,?\[\] \t]{{0,200}}>)?(?:\[\])?\??"
_GET_VALUE = re.compile(rf"\bGetValue[ \t]*<[ \t]*(?P<t>{_TYPE})[ \t]*>[ \t]*\(")
_CONNECTION = re.compile(r"\bGetConnectionString[ \t]*\(")
_SECTION = re.compile(r"\bGet(?:Required)?Section[ \t]*\(")
_GET_T = re.compile(rf"\.{SP}Get[ \t]*<[ \t]*(?P<t>{_TYPE})[ \t]*>[ \t]*\({SP}\)")
_BIND = re.compile(rf"\.{SP}Bind[ \t]*\({SP}(?P<obj>{_ID}){SP}\)")
_CONFIGURE = re.compile(rf"\bConfigure[ \t]*<[ \t]*(?P<t>{_TYPE})[ \t]*>[ \t]*\({SP}")
_OPTIONS = re.compile(
    rf"\bAddOptions[ \t]*<[ \t]*(?P<t>{_TYPE})[ \t]*>[ \t]*\({SP}\){SP}\.{SP}"
    rf"(?P<how>BindConfiguration|Bind)[ \t]*\({SP}"
)
_NAMEOF = re.compile(
    rf"{SP}nameof{SP}\({SP}(?P<id>{_ID}(?:{SP}\.{SP}{_ID}){{0,6}}){SP}\){SP}(?P<end>[,)])"
)
# Переменная раздела: «var s =», «IConfigurationSection s =» перед цепочкой GetSection.
_ASSIGNED = re.compile(rf"(?P<v>{_ID})[ \t]*=$")
_KEYWORDS = frozenset({"return", "new", "var", "await", "yield", "throw", "else", "case", "in"})
# Сколько разных переменных .Bind(obj) ищется по объявлению в одном файле.
_MAX_DECLARED = 20
_GENERIC_TYPES = {
    "bool": "bool", "Boolean": "bool", "int": "int", "Int32": "int", "long": "int",
    "Int64": "int", "short": "int", "uint": "int", "ulong": "int", "byte": "int",
    "double": "float", "Double": "float", "float": "float", "Single": "float",
    "decimal": "float", "Decimal": "float", "string": "string", "String": "string",
    "TimeSpan": "duration",
}
_LIST_TYPES = ("List<", "IList<", "IEnumerable<", "ICollection<", "IReadOnlyList<", "HashSet<")
_NUMBER = re.compile(r"-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?(?P<suffix>[mMfFdDlLuU]{0,2})")
# Класс настроек: объявление и публичные свойства с set или init.
_CLASS = re.compile(rf"\b(?:class|record)[ \t]+(?P<name>{_ID})\b")
_PROP = re.compile(
    rf"\bpublic[ \t]+(?P<mods>(?:(?:required|virtual|override|new|static|readonly)[ \t]+){{0,4}})"
    rf"(?P<t>{_TYPE})[ \t]+(?P<name>{_ID})[ \t]*\{{(?P<acc>[^{{}}]{{0,200}})\}}"
    rf"(?:[ \t]*=[ \t]*(?P<init>[^;\n]{{0,200}});)?"
)
_SETTER = re.compile(r"\b(?:set|init)\b")
_CLASS_BODY = 2000  # сколько знаков после имени класса ищется «{»


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


def _type_of(written: str) -> str:
    """Тип параметра по типу C#: bool, int, float, string, duration, array; иначе как
    написан (Uri, вложенный класс настроек)."""
    base = written.strip().rstrip("?").strip()
    if base in _GENERIC_TYPES:
        return _GENERIC_TYPES[base]
    if base.endswith("[]") or base.startswith(_LIST_TYPES):
        return "array"
    return base


def _simple(written: str) -> str:
    """Имя класса без пространства имён, параметров типа и «?»."""
    return written.split("<", 1)[0].rstrip("?").strip().rsplit(".", 1)[-1].strip()


def _literal(code: codetext.Code, start: int, end: int) -> tuple[str | None, bool]:
    """Дефолт по выражению [start, end) маски: строка, число или true/false как написаны
    (число без суффикса типа); другое выражение — дефолт есть, но не литерал."""
    raw = code.mask[start:end].strip()
    if not raw:
        return None, False
    lead = start + len(code.mask[start:end]) - len(code.mask[start:end].lstrip())
    if clike.LITERAL.fullmatch(raw):
        return clike.literal_value(code, lead, lead + len(raw)), True
    if raw in ("true", "false"):
        return raw, True
    number = _NUMBER.fullmatch(raw)
    if number is not None:
        return raw[:len(raw) - len(number.group("suffix"))], True
    return None, True


@dataclass(frozen=True)
class _Prop:
    """Публичное свойство класса настроек с set или init."""

    name: str
    type: str
    default: str | None
    has_default: bool
    required: bool | None
    loc: Loc


class _Classes:
    """Классы настроек проектов .NET: индекс «имя класса → файлы проекта» строится один раз
    на проект при первой привязке раздела, свойства класса — один раз на класс."""

    def __init__(self, files: Files, ctx: Context) -> None:
        self.files = files
        self.ctx = ctx
        self._index: dict[str, dict[str, list[str]]] = {}
        self._props: dict[tuple[str, str], list[_Prop] | None] = {}

    def project(self, rel: str) -> str:
        """Каталог проекта .NET файла: ближайший вверх каталог с .csproj."""
        pkgs = codebase.owner_packages(self.files, self.ctx, rel, codebase.DOTNET)
        own = [p for p in pkgs if p.kind == "csproj"] or pkgs
        return own[0].dir if own else ""

    def _project_index(self, project: str) -> dict[str, list[str]]:
        index = self._index.get(project)
        if index is None:
            index = {}
            for rel in self.files.paths:
                if (
                    not paths.under(rel, project) or not codebase.is_code_file(rel, codebase.DOTNET)
                    or clike.in_test_dir(rel) or self.project(rel) != project
                ):
                    continue
                text = self.files.read(rel, keep=False)
                if text is None:
                    continue
                for name in dict.fromkeys(m.group("name") for m in _CLASS.finditer(text)):
                    index.setdefault(name, []).append(rel)
            self._index[project] = index
        return index

    def properties(self, rel: str, cls: str) -> list[_Prop] | None:
        """Свойства класса cls проекта файла rel; None — класса нет или он в нескольких
        файлах проекта."""
        key = (self.project(rel), cls)
        if key not in self._props:
            self._props[key] = self._find(*key)
        return self._props[key]

    def _find(self, project: str, cls: str) -> list[_Prop] | None:
        cands = self._project_index(project).get(cls, [])
        if len(cands) != 1:
            return None
        rel = cands[0]
        text = self.files.read(rel, keep=False)
        code = codetext.load(self.files, rel, text, codetext.CS) if text is not None else None
        if code is None:
            return None
        for m in _CLASS.finditer(code.mask):
            if m.group("name") == cls:
                return _class_props(code, rel, m.end())
        return None


_BRACES = re.compile(r"[{}]")


def _class_props(code: codetext.Code, rel: str, after: int) -> list[_Prop] | None:
    """Свойства в теле класса, имя которого кончается на позиции after: только на первом
    уровне тела (свойства вложенных классов не в счёт). None — тела нет."""
    mask = code.mask
    open_ = mask.find("{", after, after + _CLASS_BODY)
    if open_ < 0 or ";" in mask[after:open_]:
        return None
    marks: list[int] = []
    depths: list[int] = []
    depth = 0
    close = -1
    for b in _BRACES.finditer(mask, open_):
        depth += 1 if b.group() == "{" else -1
        marks.append(b.start())
        depths.append(depth)
        if depth == 0:
            close = b.start()
            break
    if close < 0:
        return None
    out: list[_Prop] = []
    for m in _PROP.finditer(mask, open_ + 1, close):
        if depths[bisect_right(marks, m.start()) - 1] != 1:
            continue
        mods = m.group("mods").split()
        if "static" in mods or not _SETTER.search(m.group("acc")):
            continue
        default, has_default = (None, False)
        if m.group("init") is not None:
            default, has_default = _literal(code, *m.span("init"))
        if len(out) > clike.MAX_READS:
            break  # враждебный вход: привязка такого класса отвергнет файл (_Binder.run)
        out.append(_Prop(
            name=m.group("name"), type=_type_of(m.group("t")), default=default,
            has_default=has_default, required=True if "required" in mods else None,
            loc=Loc(rel, code.line(m.start())),
        ))
    return out


def _bind(
    out: list[CodeParam], classes: _Classes, code: codetext.Code, rel: str, at: int,
    section: str, extra: list[Loc], cls: str | None,
) -> None:
    """Раздел section, привязанный к классу cls: параметры «раздел:Свойство» по свойствам
    класса; класса нет (или cls неизвестен) — один параметр раздела с типом как написан."""
    loc = Loc(rel, code.line(at))
    props = classes.properties(rel, _simple(cls)) if cls else None
    if not props:
        out.append(CodeParam(
            name=section, loc=loc, parser=NAME, type=cls.strip() if cls else None,
            extra_locs=list(extra),
        ))
        return
    for prop in props:
        out.append(CodeParam(
            name=f"{section}:{prop.name}", loc=loc, parser=NAME, default=prop.default,
            has_default=prop.has_default, required=prop.required, type=prop.type,
            extra_locs=[*extra, prop.loc],
        ))


_Section = tuple[str, list[Loc]]
_END = re.compile(rf"{SP};")
_DEFAULT = re.compile(rf"{SP}(?P<v>[^,()]{{1,200}}?){SP}\)")


class _Binder:
    """Чтения через биндер конфигурации в одном файле (ТЗ §15 п. 16 Р1)."""

    def __init__(
        self, files: Files, code: codetext.Code, rel: str, repo: clike.Repo, found: Findings,
        classes: _Classes,
    ) -> None:
        self.files, self.code, self.rel, self.repo = files, code, rel, repo
        self.found, self.classes = found, classes
        self.bound: list[CodeParam] = []  # параметры привязок разделов к классам
        self.ends: dict[int, _Section] = {}  # конец вызова GetSection → раздел
        self.vars: dict[str, _Section | None] = {}  # переменная раздела → раздел (None — их два)
        self._declared: dict[str, str | None] = {}

    def section_arg(self, pos: int) -> tuple[_Section | None, int] | None:
        """Имя раздела в аргументе с позиции pos и конец вызова; None — аргумент не имя
        (подсказка уже записана)."""
        mask = self.code.mask
        named = _NAMEOF.match(mask, pos)
        if named is not None and named.group("end") == ")":
            ident = re.sub(r"[ \t\r\n]", "", named.group("id"))
            return (ident.rsplit(".", 1)[-1], []), named.end()
        arg = clike.ARG.match(mask, pos)
        if arg is None or arg.group("end") != ")":
            return None
        got = clike.arg_value(self.code, self.repo, self.rel, arg)
        if got is None:
            start, end = arg.span("arg")
            clike.hint(self.found, self.code.text[start:end][:80], texts.REASON_DYNAMIC_PARAM,
                       self.rel, self.code.line(pos))
            return (None, arg.end())
        return got, arg.end()

    def prefix(self, at: int) -> _Section | None:
        """Раздел получателя вызова на позиции at: переменная раздела или предыдущий
        GetSection в цепочке; None — получатель не раздел."""
        mask = self.code.mask
        dot = clike.skip_back(mask, at)
        if dot == 0 or mask[dot - 1] != ".":
            return None
        before = clike.skip_back(mask, dot - 1)
        if before in self.ends:
            return self.ends[before]
        recv = _receiver(mask, dot - 1)
        return self.vars.get(recv[1]) if recv is not None else None

    def declared(self, var: str) -> str | None:
        """Тип переменной var по объявлению в файле: «var = new T(» или «T var =»/«T var;».
        Разных переменных ищется не больше _MAX_DECLARED на файл: каждый поиск идёт по
        всему файлу, а .Bind(obj) у раздела в настоящем коде единицы."""
        if var not in self._declared:
            if len(self._declared) >= _MAX_DECLARED:
                return None
            name = re.escape(var)
            mask = self.code.mask
            made = re.search(rf"\b{name}{SP}={SP}new{SP}(?P<t>{_TYPE})[ \t]*[({{]", mask)
            typed = re.search(rf"\b(?P<t>{_TYPE})[ \t]+{name}[ \t]*(?:=|;)", mask)
            if made is not None:
                self._declared[var] = made.group("t")
            elif typed is not None and typed.group("t") not in _KEYWORDS:
                self._declared[var] = typed.group("t")
            else:
                self._declared[var] = None
        return self._declared[var]

    def run(self) -> None:
        mask = self.code.mask
        lists = [
            clike.matches(self.files, self.rel, pattern, mask)
            for pattern in (_SECTION, _CONFIGURE, _OPTIONS, _GET_T, _BIND, _GET_VALUE, _CONNECTION)
        ]
        if any(found is None for found in lists):
            return
        sections, configures, options, gets, binds, values, connections = (
            found or [] for found in lists
        )
        # Аргумент Configure<T>(…) и AddOptions<T>().Bind(…): начало → T.
        targets = {m.end(): (m.group("t"), m.start()) for m in configures}
        for m in options:
            if m.group("how") == "Bind":
                targets[m.end()] = (m.group("t"), m.start())
            else:
                got = self.section_arg(m.end())
                if got is not None and got[0] is not None:
                    self.bind(m.start(), got[0], m.group("t"))
        for m in sections:
            self.section(m, targets)
        for m in gets:
            if mask[clike.skip_back(mask, m.start()) - 1] == ")":
                continue  # GetSection(…).Get<T>() — уже в section
            sec = self.var_before(m.start())
            if sec is not None:
                self.bind(m.start(), sec, m.group("t"))
        for m in binds:
            sec = self.var_before(m.start())
            if sec is not None:
                self.bind(m.start(), sec, self.declared(m.group("obj")))
        for start, (cls, at) in targets.items():
            arg = clike.ARG.match(mask, start)
            if arg is not None and arg.group("end") in "),":
                sec = self.vars.get(mask[arg.start("arg"):arg.end("arg")].strip())
                if sec is not None:
                    self.bind(at, sec, cls)
        if len(self.bound) > clike.MAX_READS:
            # Привязок раздела к классу с тысячами свойств в настоящем коде нет: это
            # враждебный вход (число записей — произведение привязок и свойств).
            self.files.refuse(self.rel)
            return
        self.found.code_params.extend(self.bound)
        for m in values:
            self.value(m)
        for m in connections:
            arg = clike.ARG.match(mask, m.end())
            if arg is not None and arg.group("end") != ")":
                arg = None
            clike.read(self.found, self.repo, self.code, self.rel, m.end(), arg, NAME, _VAR,
                       type_="string", prefix="ConnectionStrings:")

    def var_before(self, dot: int) -> _Section | None:
        """Раздел переменной перед «.» на позиции dot (s.Get<T>(), s.Bind(o))."""
        recv = _receiver(self.code.mask, dot)
        return self.vars.get(recv[1]) if recv is not None else None

    def bind(self, at: int, section: _Section, cls: str | None) -> None:
        _bind(self.bound, self.classes, self.code, self.rel, at, section[0], section[1], cls)

    def section(self, m: re.Match[str], targets: dict[int, tuple[str, int]]) -> None:
        """GetSection(…): раздел с префиксом получателя; привязка за вызовом, аргумент
        Configure<T>(…) или присваивание переменной раздела."""
        mask = self.code.mask
        got = self.section_arg(m.end())
        if got is None or got[0] is None:
            return
        (name, extra), end = got[0], got[1]
        outer = self.prefix(m.start())
        if outer is not None:
            name, extra = f"{outer[0]}:{name}", [*outer[1], *extra]
        if not _VAR.fullmatch(name):
            return
        sec = (name, extra)
        self.ends[end] = sec
        start = clike.chain_start(mask, m.start())
        if start in targets:
            self.bind(m.start(), sec, targets[start][0])
        after = _GET_T.match(mask, end)
        if after is not None:
            self.bind(m.start(), sec, after.group("t"))
            return
        after = _BIND.match(mask, end)
        if after is not None:
            self.bind(m.start(), sec, self.declared(after.group("obj")))
            return
        if _END.match(mask, end) is None:
            return
        line_start = mask.rfind("\n", max(0, start - 200), start) + 1
        assigned = _ASSIGNED.search(mask[max(line_start, start - 200):start].rstrip())
        if assigned is not None and assigned.group("v") not in _KEYWORDS:
            var = assigned.group("v")
            self.vars[var] = sec if self.vars.get(var, sec) == sec else None

    def value(self, m: re.Match[str]) -> None:
        """GetValue<T>("A:B") и GetValue<T>("A:B", дефолт)."""
        mask = self.code.mask
        arg = clike.ARG.match(mask, m.end())
        default: str | None = None
        has_default = False
        if arg is not None and arg.group("end") == ",":
            tail = _DEFAULT.match(mask, arg.end())
            has_default = True
            if tail is not None:
                default, has_default = _literal(self.code, *tail.span("v"))
        elif arg is not None and arg.group("end") != ")":
            arg = None
        outer = self.prefix(m.start())
        clike.read(
            self.found, self.repo, self.code, self.rel, m.end(), arg, NAME, _VAR,
            default=default, has_default=has_default, type_=_type_of(m.group("t")),
            prefix=f"{outer[0]}:" if outer is not None else "",
        )


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not codebase.stack_present(files, ctx, codebase.DOTNET):
        return found
    found.applied.add(NAME)
    repo = clike.Repo(files, ctx, codebase.DOTNET, codetext.CS)
    classes = _Classes(files, ctx)
    for rel, code in clike.sources(files, ctx, codebase.DOTNET, codetext.CS, _NEEDLES, repo):
        _scan(files, code, rel, repo, found)
        _Binder(files, code, rel, repo, found, classes).run()
    return found
