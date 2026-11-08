"""Параметры конфигурации в коде Go (ТЗ §6.2): os.Getenv("X"), os.LookupEnv("X") (чтение
с проверкой наличия, поэтому required), теги структур env:"X" (caarlos0/env,
sethvargo/go-envconfig: «X,required», «X,default=v») и envconfig:"X", дефолт из
envDefault:"v" и default:"v", required:"true". Поиск по маске кода (codetext.py); теги
читаются из сырых строк в обратных кавычках не длиннее 1000 символов.

Обёртки чтения и имя через константу (ТЗ §15 п. 14 Е1: util/env Argo CD, mustMapEnv
frontend Online Boutique):

- функция репозитория (не метод), у которой строковый параметр целиком уходит в
  os.Getenv, os.LookupEnv или viper.BindEnv, — обёртка чтения. Её вызов с литералом на
  месте этого параметра даёт параметр; дефолт — следующий аргумент, если у обёртки там
  параметр со словом default или fallback в имени и аргумент литерал; тип по словам имени
  функции (ParseNum и ParseInt64 — int, ParseFloat — float, ParseBool — bool,
  ParseDuration — duration, StringFromEnv — string; Strings и …ToString… не тип), иначе по
  дефолту. Чтение по параметру внутри самой обёртки подсказкой о динамическом имени не
  считается: имена дают места её вызова;
- вызов сопоставляется с обёрткой по каталогу пакета: «имя(» — обёртка того же каталога,
  «пакет.имя(» — обёртка каталога, в который ведёт импорт файла (путь модуля из go.mod и
  путь каталога от него). Одинаковые имена в разных пакетах так не путаются; импорт не в
  модуль репозитория обёрткой не считается;
- имя идентификатором (EnvGnuPGHome в пакете common, common.EnvGnuPGHome по импорту)
  раскрывается, если константа или переменная объявлена строковым литералом на верхнем
  уровне пакета в репозитории (gocode.string_constants); место объявления идёт в основания
  вместе с местом чтения. Иначе — подсказка о динамическом имени, как раньше.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from dataclasses import dataclass, field

from archmap_scan import codebase, codetext, gocode, paths, secrets, texts
from archmap_scan.codetext import SP, STR
from archmap_scan.context import Context
from archmap_scan.model import CodeParam, Findings, Hint, Loc
from archmap_scan.pyregistry import name_words
from archmap_scan.walk import Files

NAME = "go-env"
_CALL = re.compile(rf"os[ \t]*\.[ \t]*(Getenv|LookupEnv)[ \t]*\({SP}({STR})?")
_RAW = re.compile(r"`[ \n]*`")
_VAR = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,199}")
_MAX_TAG = 1000
_NEEDLES = ("os.Getenv", "os.LookupEnv", 'env:"', 'envconfig:"', "viper.BindEnv")
# Чтение окружения по параметру в теле обёртки: os.Getenv(имя), os.LookupEnv(имя).
_READ_PARAM = re.compile(
    r"os[ \t]*\.[ \t]*(?:Getenv|LookupEnv)[ \t]*\([ \t]*([A-Za-z_][A-Za-z0-9_]{0,99})[ \t]*\)"
)
_BIND = re.compile(r"viper[ \t]*\.[ \t]*BindEnv[ \t]*\(")
_STR = re.compile(STR)
_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,99}")
_QUALIFIED = re.compile(r"([A-Za-z_][A-Za-z0-9_]{0,99})[ \t]*\.[ \t]*([A-Za-z_][A-Za-z0-9_]{0,99})")
# Имя идентификатором сразу за «(» чтения: «Имя» или «пакет.Имя» и конец аргумента.
_NAME_ARG = re.compile(
    r"([A-Za-z_][A-Za-z0-9_]{0,99}(?:[ \t]*\.[ \t]*[A-Za-z_][A-Za-z0-9_]{0,99})?)[ \t]*[,)]"
)
# Литерал дефолта Go: строка, число, true или false.
_SCALAR = re.compile(r"-?[0-9]{1,20}(?:\.[0-9]{1,20})?|true|false")
# Сколько первых вызовов одной обёртки в файле разбирается.
_MAX_CALLS = 5000
_DEFAULT_WORDS = frozenset({"default", "fallback"})
_STRING = "string"


@dataclass(frozen=True)
class _Wrapper:
    """Обёртка чтения: каталог пакета, позиция параметра-имени и параметра-дефолта, тип."""

    name: str
    folder: str
    index: int
    default: int | None
    type: str | None


@dataclass
class _Named:
    """Чтение с именем идентификатором: раскрывается константой после разбора всех файлов."""

    rel: str
    line: int
    ident: str
    imports: list[tuple[str | None, str]]
    required: bool | None = None
    default: str | None = None
    has_default: bool = False
    type: str | None = None


@dataclass
class _Repo:
    """Пакеты Go репозитория: модули go.mod, файлы кода по каталогам, константы пакетов и
    имена пакетов (читаются по первой нужде)."""

    files: Files
    modules: list[tuple[str, str]]
    by_dir: dict[str, list[str]]
    # Файлы кода Go в порядке обхода: отбор по пакетам делается один раз на оба прохода.
    rels: list[str] = field(default_factory=list)
    # Разобранные файлы с обёртками: их маска нужна и второму проходу (вызовы рядом с
    # определением), а таких файлов немного.
    codes: dict[str, codetext.Code] = field(default_factory=dict)
    # Константы и имя пакета уже разобранных файлов: файл не размечается второй раз ради
    # констант своего каталога.
    parsed: dict[str, tuple[dict[str, tuple[str, Loc]], str | None]] = field(
        default_factory=dict,
    )
    consts: dict[str, dict[str, tuple[str, Loc]]] = field(default_factory=dict)
    names: dict[str, str | None] = field(default_factory=dict)

    def code(self, rel: str, text: str | None = None) -> codetext.Code | None:
        """Маска файла: из разобранных с обёртками, иначе чтение и разбор."""
        if rel in self.codes:
            return self.codes[rel]
        if text is None:
            text = self.files.read(rel, keep=False)
        return codetext.load(self.files, rel, text, codetext.GO) if text is not None else None

    def note(self, rel: str, code: codetext.Code) -> None:
        """Запомнить константы и имя пакета разобранного файла."""
        if rel not in self.parsed:
            self.parsed[rel] = (
                {
                    key: (value, Loc(rel, code.line(at)))
                    for key, (value, at) in gocode.string_constants(code.text, code.mask).items()
                },
                gocode.package_name(code.mask),
            )

    def folder(self, path: str) -> str | None:
        """Каталог репозитория по пути импорта; None — пакет не из модулей репозитория."""
        for module, home in self.modules:
            if path == module:
                return home
            if path.startswith(module + "/"):
                return paths.join(home, path[len(module) + 1:])
        return None

    def _load(self, folder: str) -> None:
        consts: dict[str, tuple[str, Loc]] = {}
        name: str | None = None
        for rel in self.by_dir.get(folder, []):
            if rel not in self.parsed:
                code = self.code(rel)
                if code is None:
                    continue
                self.note(rel, code)
            own, package = self.parsed[rel]
            name = name or package
            for key, value in own.items():
                consts.setdefault(key, value)
        self.consts[folder] = consts
        self.names[folder] = name

    def constant(self, folder: str, name: str) -> tuple[str, Loc] | None:
        if folder not in self.consts:
            self._load(folder)
        return self.consts[folder].get(name)

    def package(self, folder: str) -> str | None:
        if folder not in self.names:
            self._load(folder)
        return self.names[folder]

    def target(self, imports: list[tuple[str | None, str]], recv: str) -> str | None:
        """Каталог пакета, который файл зовёт именем recv: псевдоним импорта, иначе
        последняя часть пути (без версии /vN) или имя пакета из его строки package."""
        for alias, path in imports:
            if alias == recv:
                return self.folder(path)
        for alias, path in imports:
            if alias is not None:
                continue
            folder = self.folder(path)
            if folder is None:
                continue
            if _last_segment(path) == recv or self.package(folder) == recv:
                return folder
        return None


def _last_segment(path: str) -> str:
    parts = path.split("/")
    if len(parts) > 1 and parts[-1][:1] == "v" and parts[-1][1:].isdigit():
        parts = parts[:-1]
    return parts[-1]


def _repo(files: Files, ctx: Context) -> _Repo:
    modules = sorted(
        ((p.name, p.dir) for p in codebase.packages(files, ctx) if p.kind == "go.mod" and p.name),
        key=lambda m: -len(m[0]),
    )
    rels = codebase.code_files(files, ctx, codebase.GO)
    by_dir: dict[str, list[str]] = {}
    for rel in rels:
        by_dir.setdefault(paths.parent(rel), []).append(rel)
    return _Repo(files, modules, by_dir, rels)


def _sources(repo: _Repo, needles: tuple[str, ...]) -> Iterator[tuple[str, str]]:
    """(файл, текст) кода Go с одной из подстрок needles, как codebase.sources, но по
    списку файлов, уже отобранному для каталогов пакетов."""
    for rel in repo.rels:
        text = repo.files.read(rel, keep=False)
        if text is not None and any(n in text for n in needles):
            yield rel, text


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


def wrapper_type(name: str) -> str | None:
    """Тип параметра по словам имени обёртки: ParseNumFromEnv → int, ParseBoolFromEnv →
    bool, StringFromEnv → string; список (Strings) и словарь (…ToString…) — не тип."""
    words = set(name_words(name))
    if "to" in words or "strings" in words:
        return None
    for word, kind in (("bool", "bool"), ("duration", "duration"), ("float", "float")):
        if word in words:
            return kind
    if words & {"int", "num", "number"}:
        return "int"
    return _STRING if _STRING in words else None


def _wrappers(code: codetext.Code, rel: str) -> tuple[dict[str, _Wrapper], list[tuple[int, int]]]:
    """Обёртки чтения файла и тела их функций (там чтение по параметру не подсказка)."""
    out: dict[str, _Wrapper] = {}
    bodies: list[tuple[int, int]] = []
    mask = code.mask
    for func in gocode.functions(mask):
        if func.method:
            continue
        strings = {
            p: i for i, (p, kind) in enumerate(zip(func.params, func.types, strict=False))
            if p and kind == _STRING
        }
        if not strings:
            continue
        used: int | None = None
        for m in _READ_PARAM.finditer(mask, func.start, func.end):
            if m.group(1) in strings:
                used = strings[m.group(1)]
                break
        if used is None:
            for m in _BIND.finditer(mask, func.start, func.end):
                parts = gocode.split_spans(mask, m.end())
                names = [mask[a:b] for a, b in parts[0]] if parts is not None else []
                hit = next((strings[n] for n in names if n in strings), None)
                if hit is not None:
                    used = hit
                    break
        if used is None:
            continue
        nxt = used + 1
        default = nxt if nxt < len(func.params) and _DEFAULT_WORDS & set(
            name_words(func.params[nxt])
        ) else None
        out.setdefault(func.name, _Wrapper(
            func.name, paths.parent(rel), used, default, wrapper_type(func.name),
        ))
        bodies.append((func.start, func.end))
    return out, bodies


def _hint(found: Findings, name: str, reason: str, rel: str, line: int) -> None:
    found.hints.append(Hint("dynamic_names", {
        "kind": "config", "name": name, "reason": reason, "source": str(Loc(rel, line)),
    }))


def _scan(
    code: codetext.Code, rel: str, found: Findings, wrappers: dict[tuple[str, str], _Wrapper],
    named: list[_Named], repo: _Repo,
) -> None:
    own, bodies = _wrappers(code, rel)
    for wrapper in own.values():
        wrappers.setdefault((wrapper.folder, wrapper.name), wrapper)
    if own:
        repo.codes[rel] = code
    repo.note(rel, code)
    imports: list[tuple[str | None, str]] | None = None
    for m in _CALL.finditer(code.mask):
        line = code.line(m.start())
        required = True if m.group(1) == "LookupEnv" else None
        if m.group(2) is None:
            arg = _NAME_ARG.match(code.mask, m.end())
            if arg is not None:
                text = arg.group(1)
                if "." not in text and any(a <= m.start() < b for a, b in bodies):
                    continue  # чтение по параметру внутри обёртки: имена дают её вызовы
                if imports is None:
                    imports = gocode.imports(code.text, code.mask)
                named.append(_Named(rel, line, text, imports, required=required))
                continue
            _hint(found, code.expression(m.end()), texts.REASON_DYNAMIC_PARAM, rel, line)
            continue
        name, _dyn = code.literal(m.start(2), m.end(2))
        if code.joined(m.start(2), m.end(2)):
            # os.Getenv("OTEL_" + name): литерал лишь часть имени (ТЗ §15 п. 10 А).
            _hint(found, code.expression(m.start(2)), texts.REASON_JOINED_NAME, rel, line)
            continue
        if _VAR.fullmatch(name):
            found.code_params.append(CodeParam(
                name=name, loc=Loc(rel, line), parser=NAME, required=required,
            ))
    if 'env:"' not in code.text and 'envconfig:"' not in code.text:
        return
    for m in _RAW.finditer(code.mask):
        if m.end() - m.start() > _MAX_TAG:
            continue
        param = _tag_param(rel, code.line(m.start()), code.text[m.start() + 1:m.end() - 1])
        if param is not None:
            found.code_params.append(param)


def _literal(code: codetext.Code, start: int, end: int) -> str | None:
    """Текст литерала Go на позициях [start, end) маски или None."""
    if _STR.fullmatch(code.mask, start, end):
        value, dynamic = code.literal(start, end)
        return None if dynamic else value
    text = code.mask[start:end]
    return text if _SCALAR.fullmatch(text) else None


def _calls(
    code: codetext.Code, rel: str, wrappers: dict[tuple[str, str], _Wrapper], repo: _Repo,
    found: Findings, named: list[_Named],
) -> None:
    """Вызовы обёрток в файле: литерал — параметр, идентификатор — к раскрытию константой."""
    mask = code.mask
    names = {w.name for w in wrappers.values()}
    skip = {at for _name, at in gocode.declared(mask)}
    imports: list[tuple[str | None, str]] | None = None
    folder = paths.parent(rel)
    for name, at, args in gocode.call_spans(mask, names, skip, _MAX_CALLS):
        dot = at - 1
        while dot >= 0 and mask[dot] in " \t":
            dot -= 1
        if dot >= 0 and mask[dot] == ".":
            recv = code.receiver(dot)
            if recv is None:
                continue
            if imports is None:
                imports = gocode.imports(code.text, mask)
            target = repo.target(imports, recv)
        else:
            target = folder
        wrapper = wrappers.get((target, name)) if target is not None else None
        if wrapper is None or wrapper.index >= len(args):
            continue
        line = code.line(at)
        start, end = args[wrapper.index]
        default: str | None = None
        has_default = False
        if wrapper.default is not None and wrapper.default < len(args):
            has_default = True
            default = _literal(code, *args[wrapper.default])
        type_ = wrapper.type or secrets.value_type(default)
        text = mask[start:end]
        if _STR.fullmatch(mask, start, end):
            value, dynamic = code.literal(start, end)
            if not dynamic and _VAR.fullmatch(value):
                found.code_params.append(CodeParam(
                    name=value, loc=Loc(rel, line), parser=NAME, default=default,
                    has_default=has_default, type=type_,
                ))
                continue
        elif _IDENT.fullmatch(text) or _QUALIFIED.fullmatch(text):
            if imports is None:
                imports = gocode.imports(code.text, mask)
            named.append(_Named(
                rel, line, text, imports, default=default, has_default=has_default, type=type_,
            ))
            continue
        reason = texts.REASON_JOINED_NAME if "+" in text else texts.REASON_DYNAMIC_PARAM
        _hint(found, code.text[start:end][:80], reason, rel, line)


def _resolve(item: _Named, repo: _Repo, found: Findings) -> None:
    """Имя константой пакета репозитория: параметр с местом чтения и местом объявления;
    иначе подсказка о динамическом имени."""
    qualified = _QUALIFIED.fullmatch(item.ident)
    if qualified is not None:
        folder = repo.target(item.imports, qualified.group(1))
        ident = qualified.group(2)
    else:
        folder, ident = paths.parent(item.rel), item.ident
    hit = repo.constant(folder, ident) if folder is not None else None
    if hit is None or not _VAR.fullmatch(hit[0]):
        _hint(found, item.ident, texts.REASON_DYNAMIC_PARAM, item.rel, item.line)
        return
    found.code_params.append(CodeParam(
        name=hit[0], loc=Loc(item.rel, item.line), parser=NAME, default=item.default,
        has_default=item.has_default, required=item.required if not item.has_default else None,
        type=item.type, extra_locs=[hit[1]],
    ))


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not codebase.stack_present(files, ctx, codebase.GO):
        return found
    found.applied.add(NAME)
    wrappers: dict[tuple[str, str], _Wrapper] = {}
    named: list[_Named] = []
    repo = _repo(files, ctx)
    for rel, text in _sources(repo, _NEEDLES):
        code = codetext.load(files, rel, text, codetext.GO)
        if code is not None:
            _scan(code, rel, found, wrappers, named, repo)
    if wrappers:
        needles = tuple(sorted({w.name + "(" for w in wrappers.values()}))
        for rel, text in _sources(repo, needles):
            code = repo.code(rel, text)
            if code is not None:
                repo.note(rel, code)
                _calls(code, rel, wrappers, repo, found, named)
    for item in named:
        _resolve(item, repo, found)
    return found
