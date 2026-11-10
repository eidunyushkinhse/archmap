"""Маршруты Rails (ТЗ §15 п. 15 К1): `config/routes.rb` и файлы `config/routes/*.rb` пакета
Ruby, в Gemfile которого есть rails или railties.

Файл читается построчно по маске Ruby (codetext.RUBY), без исполнения: строки собираются в
инструкцию, пока скобки не закрыты или строка кончается запятой, стек блоков ведут `do` …
`end` и ключевые слова `if`, `unless`, `case`, `begin`, `def`, `class`, `module` в начале
инструкции. Глаголы `get`, `post`, `put`, `patch`, `delete` и `match` с литеральным первым
аргументом (строка или символ `:действие` как путь `/действие`) дают маршрут; у `match` методы
из `via:` (`:all` — ANY, без `via:` — ANY), `root` — GET на префиксе. `resources :имя` даёт
семь стандартных операций (PUT не пишется: он дубль PATCH), `resource :имя` шесть без
индекса и без `:id`; `only:` и `except:` сужают набор, `path:` подменяет сегмент, `param:` —
`:id`. Внутри блока ресурса `member` и `on: :member` дают `/имя/:id/действие`, `collection` и
`on: :collection` — `/имя/действие`, прочие глаголы и вложенные ресурсы идут под
`/имя/:<имя в единственном числе>_id`, как у самой Rails. `namespace :x` и `scope 'x'` (или
`path:`) дают префикс, `scope module:`, `constraints`, `defaults`, `with_options` и прочие
блоки префикса не дают. `concern :имя do … end` записей не даёт, а его тело читается там,
где его подключают (`concerns :имя`, `concerns:` у ресурса). `draw(:имя)` читает файл
`config/routes/имя.rb` на месте вызова, а файлы `config/routes/`, которые никто не
подключил, читаются от корня. `mount` даёт подсказку: маршруты смонтированного движка не
читаются. Путь с подстановкой `#{…}` или из переменной уходит в подсказку о динамическом
пути. Внутри `def`, `class` и `module` записей нет.

Часть 5 (ТЗ §15 п. 16 П6). Необязательная группа в пути (`scope "(/locale/:locale)"`,
`get 'posts(/:page)'`) из записи убирается: основная форма без группы; маршрут из группы,
совпавший с уже записанным, второй раз не пишется. `devise_for :имя` читает вызовы `devise`
модели `app/models/<единственное число>.rb` и даёт наборы маршрутов модулей под `/имя` (или
`path:`) с префиксом объемлющих scope и namespace; `path_names`, `skip`, `only` и
`sign_out_via` учтены; модуль без известного набора и модель без devise дают подсказку.
`devise_scope` прозрачен. `shallow: true` у ресурса и блок `shallow do … end`: у вложенного
ресурса index, new и create под родителем, show, edit, update и destroy от префикса scope.

Пределы: 50 000 строк, 5000 записей на файл, 50 вложенных блоков; сверх этого набор
маршрутов не пишется, а файл считается непрочитанным.
"""

from __future__ import annotations

import re
from bisect import bisect_right
from collections.abc import Sequence
from dataclasses import dataclass, field, replace

from archmap_scan import codebase, codetext, paths, texts
from archmap_scan.context import Context
from archmap_scan.model import Findings, Hint, Loc, Route, route_hint
from archmap_scan.parsers.railsschema import singular
from archmap_scan.walk import Files

NAME = "rails-routes"
FRAMEWORK = "Rails"
WANTED = frozenset({"rails", "railties"})
_MAX_LINES = 50_000
_MAX_ROUTES = 5000
_MAX_DEPTH = 50
# Длиннее инструкция маршрутов не бывает: такую разбирать не нужно (враждебный вход).
_MAX_STATEMENT = 20_000
_VERBS = {"get": "GET", "post": "POST", "put": "PUT", "patch": "PATCH", "delete": "DELETE"}
# Инструкции, аргументы которых читаются; прочие (блоки with_options, constraints, перебор
# списков) префикса не дают.
_ROUTING = frozenset({
    *_VERBS, "match", "root", "resources", "resource", "namespace", "scope", "member",
    "collection", "concerns", "mount", "draw", "shallow", "devise_for",
})
# devise (П6): модуль модели → контроллер devise с набором маршрутов; модули без маршрутов.
_DEVISE_MODULES = {
    "database_authenticatable": "sessions", "two_factor_authenticatable": "sessions",
    "registerable": "registrations", "recoverable": "passwords", "confirmable": "confirmations",
    "lockable": "unlocks", "omniauthable": "omniauth_callbacks",
}
_DEVISE_SILENT = frozenset({
    "validatable", "rememberable", "trackable", "timeoutable", "two_factor_backupable",
})
_DEVISE_CALL = re.compile(r"^[ \t]*devise\b(?![?!:])", re.M)
_DEVISE_SYMBOL = re.compile(r"(?<![\w:]):([A-Za-z_][A-Za-z0-9_]{0,99})")
_PATH_NAME = re.compile(
    r"(?:([A-Za-z_][A-Za-z0-9_]{0,99}):(?!:)|:([A-Za-z_][A-Za-z0-9_]{0,99})[ \t]*=>)[ \t\n]*(['\"])"
)
# Сколько строк читать в одном вызове devise модели и сколько вызовов devise в модели.
_DEVISE_LINES = 50
_DEVISE_CALLS = 100
_DEVISE_MODULES_MAX = 200  # символов во всех вызовах devise модели
# Сколько инструкций разбирать в одном наборе маршрутов (concern и draw повторяют тела).
_MAX_STEPS = 50_000
_ACTIONS_MANY = (
    ("index", "GET", False, ""), ("create", "POST", False, ""), ("new", "GET", False, "new"),
    ("edit", "GET", True, "edit"), ("show", "GET", True, ""), ("update", "PATCH", True, ""),
    ("destroy", "DELETE", True, ""),
)
_ACTIONS_ONE = (
    ("create", "POST", ""), ("new", "GET", "new"), ("edit", "GET", "edit"), ("show", "GET", ""),
    ("update", "PATCH", ""), ("destroy", "DELETE", ""),
)
# Ключевые слова, которые в начале инструкции открывают блок до своего end.
_KEYWORD_BLOCKS = frozenset({"if", "unless", "while", "until", "case", "begin", "for"})
_CODE_BLOCKS = frozenset({"def", "class", "module"})
_HEAD = re.compile(r"[ \t]*([A-Za-z_][A-Za-z0-9_]*[?!]?)")
_DO = re.compile(r"(?:^|[\s)\]}])do(?:[ \t]*\|[^|\n]*\|)?[ \t]*$")
# Разделители аргументов и слова, на которых аргументы кончаются (блок, модификатор).
_ARG_MARKS = re.compile(r"[(\[{)\]},]|(?<![\w.:])(?:do|if|unless)(?![\w?!:])")
_LABEL = re.compile(r"[ \t\n]*([A-Za-z_][A-Za-z0-9_]*[?!]?):(?!:)")
_SYMBOL = re.compile(r":([A-Za-z_][A-Za-z0-9_]*[?!=]?)")
_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_ENGINE = re.compile(r"\bEngine[ \t]*\.[ \t]*routes[ \t]*\.[ \t]*draw\b")
_BRACKETS = re.compile(r"[(\[{)\]}]")
# Блок в фигурных скобках с параметрами: %w(…).each { |path| get path }.
_ITERATOR = re.compile(r"\{[ \t]*\|[^|\n]{0,200}\|")
_SPLIT = re.compile(r"[(\[{)\]};]")
_PAIR = {"[": "]", "(": ")", "{": "}", "<": ">", "|": "|"}
# Пустой список у only: и except: — ни одной операции (only: []).
_EMPTY = frozenset({"[]", "%i[]", "%w[]"})


@dataclass(frozen=True)
class _Ctx:
    """Где стоит инструкция: префикс путей и ресурс, в блоке которого она стоит."""

    prefix: str = ""
    kind: str = ""  # "" | "resources" | "resource"
    base: str = ""  # путь ресурса с префиксом: «/users»
    member: str = ""  # путь члена ресурса: «/users/:username» (у resource пусто)
    nested: str = ""  # префикс вложенного: «/users/:account_username» (у resource = base)
    mode: str = ""  # "" | "member" | "collection"
    ignore: bool = False  # тело def, class, module и определения concern
    unresolved: bool = False  # префикс не виден в коде (движок, scope из переменной)
    root: str = ""  # префикс scope и namespace без вложенности ресурсов (для shallow)
    shallow: bool = False  # вложенные ресурсы неглубокие (shallow: true, блок shallow)
    optional: bool = False  # в префиксе была необязательная группа «(…)»

    def inner(self) -> str:
        """Префикс для вложенного ресурса, namespace и scope."""
        if self.kind == "resources":
            return self.member if self.mode == "member" else (
                self.base if self.mode == "collection" else self.nested
            )
        return self.base if self.kind else self.prefix

    def plain(self, prefix: str) -> _Ctx:
        return _Ctx(prefix=prefix, ignore=self.ignore, unresolved=self.unresolved, root=prefix,
                    shallow=self.shallow, optional=self.optional)


@dataclass
class _Stmt:
    """Инструкция: маска и текст (переводы строк сохранены), номер первой строки."""

    mask: str
    text: str
    line: int


@dataclass
class _Arg:
    start: int
    end: int
    label: str | None = None  # ключ «only:» или None у позиционного аргумента
    rocket: int = -1  # позиция «=>» внутри аргумента


@dataclass
class _Frame:
    ctx: _Ctx
    concern: str | None = None
    start: int = 0  # номер строки (в списке строк прогона) начала тела concern


class _Overflow(Exception):
    """Набор маршрутов больше пределов: файл rel непрочитан."""

    def __init__(self, rel: str) -> None:
        super().__init__(rel)
        self.rel = rel


def _join(*parts: str) -> str:
    pieces = [p.strip("/") for p in parts if p.strip("/")]
    return "/" + "/".join(pieces)


def _strip_groups(value: str) -> tuple[str, bool]:
    """Путь без необязательных групп «(…)» (П6): основная форма, «//» схлопнуты; второе —
    была ли группа. Незакрытая скобка оставляет путь как есть."""
    if "(" not in value:
        return value, False
    out: list[str] = []
    depth = 0
    for ch in value:
        if ch == "(":
            depth += 1
        elif ch == ")":
            if depth == 0:
                return value, False
            depth -= 1
        elif depth == 0:
            out.append(ch)
    if depth:
        return value, False
    return re.sub(r"/{2,}", "/", "".join(out)), True


@dataclass
class _Set:
    """Карта маршрутов одного каталога config/: главный файл и файлы config/routes/."""

    files: Files
    folder: str  # каталог config/routes
    rel: str = ""
    routes: list[Route] = field(default_factory=list)
    hints: list[Hint] = field(default_factory=list)
    # Тело concern: файл, строки маски и текста, номер первой строки.
    concerns: dict[str, tuple[str, list[str], list[str], int]] = field(default_factory=dict)
    drawn: set[str] = field(default_factory=set)
    counts: dict[str, int] = field(default_factory=dict)
    stack: list[str] = field(default_factory=list)  # файлы draw на пути к текущему
    active: set[str] = field(default_factory=set)  # concern, тело которых читается сейчас
    depth: int = 0
    steps: int = 0
    optional: set[int] = field(default_factory=set)  # номера маршрутов из необязательной группы

    # Прогон файла и строк

    def file(self, rel: str, ctx: _Ctx) -> None:
        if rel in self.stack or len(self.stack) > 10:
            return
        text = self.files.read(rel)
        if text is None:
            return
        if text.count("\n") > _MAX_LINES:
            raise _Overflow(rel)
        code = codetext.load(self.files, rel, text, codetext.RUBY)
        if code is None:
            return
        self.stack.append(rel)
        saved, self.rel = self.rel, rel
        try:
            self.run(code.mask.split("\n"), text.split("\n"), 1, ctx)
        finally:
            self.rel = saved
            self.stack.pop()

    def run(self, masks: list[str], raws: list[str], first: int, ctx: _Ctx) -> None:
        """Строки masks/raws (номер первой — first) в контексте ctx: инструкции по порядку,
        стек блоков do … end."""
        self.depth += 1
        if self.depth > _MAX_DEPTH:
            raise _Overflow(self.rel)
        frames: list[_Frame] = [_Frame(ctx)]
        i = 0
        try:
            while i < len(masks):
                start = i
                depth = 0
                while True:
                    line = masks[i]
                    depth += (line.count("(") + line.count("[") + line.count("{")
                              - line.count(")") - line.count("]") - line.count("}"))
                    tail = line.rstrip()
                    i += 1
                    if i >= len(masks) or not (depth > 0 or tail.endswith((",", "\\", "=>", "||", "&&"))):
                        break
                stmt = _Stmt("\n".join(masks[start:i]), "\n".join(raws[start:i]), first + start)
                if not stmt.mask.strip():
                    continue
                for part in _split(stmt):
                    self.statement(part, frames, start, i, masks, raws, first)
        finally:
            self.depth -= 1

    def statement(
        self, st: _Stmt, frames: list[_Frame], start: int, stop: int, masks: list[str],
        raws: list[str], first: int,
    ) -> None:
        self.steps += 1
        if self.steps > _MAX_STEPS:
            raise _Overflow(self.rel)
        ctx = frames[-1].ctx
        head = _HEAD.match(st.mask)
        word = head.group(1) if head is not None else ""
        if word == "end":
            frame = frames.pop() if len(frames) > 1 else frames[-1]
            if frame.concern is not None:
                self.concerns[frame.concern] = (
                    self.rel, masks[frame.start:start], raws[frame.start:start],
                    first + frame.start,
                )
            return
        opens = _DO.search(st.mask[-300:]) is not None
        if word in _KEYWORD_BLOCKS or word in _CODE_BLOCKS:
            child = replace(ctx, ignore=True) if word in _CODE_BLOCKS else ctx
            self.push(frames, _Frame(child))
            return
        if head is None or len(st.mask) > _MAX_STATEMENT:
            if opens:
                self.push(frames, _Frame(ctx))
            elif len(st.mask) <= _MAX_STATEMENT:
                self.iterator(st, ctx)
            return
        after = head.end()
        if word == "concern" and opens:
            name = _symbol_at(st, after)
            self.push(frames, _Frame(replace(ctx, ignore=True), name, stop))
            return
        child = ctx if ctx.ignore else self.apply(word, st, after, ctx)
        if opens:
            self.push(frames, _Frame(child))
        elif child is not ctx:
            self.braces(st, after, child)
        elif word not in _VERBS and word not in ("match", "mount", "root"):
            self.iterator(st, ctx)

    def push(self, frames: list[_Frame], frame: _Frame) -> None:
        frames.append(frame)
        if len(frames) > _MAX_DEPTH:
            raise _Overflow(self.rel)

    def braces(self, st: _Stmt, after: int, ctx: _Ctx) -> None:
        """Блок в фигурных скобках у метода маршрутов (member { get :player })."""
        mask = st.mask
        i = after
        while i < len(mask) and mask[i] in " \t":
            i += 1
        if mask[i:i + 1] != "{":
            return
        close = _closing(mask, i)
        if close < 0:
            return
        body_m = mask[i + 1:close].split("\n")
        body_t = st.text[i + 1:close].split("\n")
        self.run(body_m, body_t, st.line + mask.count("\n", 0, i), ctx)

    def iterator(self, st: _Stmt, ctx: _Ctx) -> None:
        """Тело блока { |x| … } у прочей инструкции (перебор списка путей): глагол с путём из
        переменной там даёт подсказку о динамическом пути."""
        hit = _ITERATOR.search(st.mask)
        if hit is None:
            return
        close = _closing(st.mask, hit.start())
        if close < 0:
            return
        self.run(st.mask[hit.end():close].split("\n"), st.text[hit.end():close].split("\n"),
                 st.line + st.mask.count("\n", 0, hit.end()), ctx)

    # Инструкции

    def apply(self, word: str, st: _Stmt, after: int, ctx: _Ctx) -> _Ctx:
        """Инструкция маршрутов: записи и контекст её блока (без блока — тот же ctx)."""
        if word not in _ROUTING:
            return replace(ctx, unresolved=True) if _ENGINE.search(st.mask) else ctx
        args = _args(st.mask, after)
        if word in _VERBS or word == "match":
            self.verb(word, st, args, ctx)
        elif word == "root":
            self.add("GET", _join(ctx.inner()), st, ctx)
        elif word in ("resources", "resource"):
            return self.resources(word, st, args, ctx)
        elif word in ("namespace", "scope"):
            return self.scope(word, st, args, ctx)
        elif word in ("member", "collection") and ctx.kind:
            return replace(ctx, mode=word)
        elif word == "shallow":
            return replace(ctx, shallow=True)
        elif word == "devise_for":
            self.devise(st, args, ctx)
        elif word == "concerns":
            for name in _names(st, [a for a in args if a.label is None]):
                self.concern(name, ctx)
        elif word == "mount":
            self.mount(st, args, ctx)
        elif word == "draw":
            for name in _names(st, args[:1]):
                rel = paths.join(self.folder, name + ".rb")
                if rel is not None:
                    self.drawn.add(rel)
                    self.file(rel, ctx)
        return ctx

    def add(self, method: str, path: str, st: _Stmt, ctx: _Ctx, optional: bool = False) -> None:
        count = self.counts.get(self.rel, 0) + 1
        self.counts[self.rel] = count
        if count > _MAX_ROUTES:
            raise _Overflow(self.rel)
        if optional or ctx.optional:
            self.optional.add(len(self.routes))
        self.routes.append(Route(
            method=method, path=path, loc=Loc(self.rel, st.line), framework=FRAMEWORK,
            parser=NAME, prefix_unresolved=ctx.unresolved,
        ))

    def dynamic(self, st: _Stmt, arg: _Arg, method: str | None = None) -> None:
        self.hints.append(route_hint(
            st.text[arg.start:arg.end].strip()[:200], texts.REASON_DYNAMIC_ROUTE,
            Loc(self.rel, st.line), method,
        ))

    def verb(self, word: str, st: _Stmt, args: list[_Arg], ctx: _Ctx) -> None:
        positional = [a for a in args if a.label is None]
        options = {a.label: a for a in args if a.label is not None}
        if not positional:
            return
        first = positional[0]
        segment = _path_arg(st, first)
        if segment is None:
            self.dynamic(st, first, None if word == "match" else _VERBS.get(word))
            return
        if word == "match":
            via = options.get("via")
            methods = [m.upper() for m in _names(st, [via])] if via is not None else ["ANY"]
            methods = ["ANY" if m == "ALL" else m for m in methods] or ["ANY"]
        else:
            methods = [_VERBS[word]]
        on = options.get("on")
        mode = (_names(st, [on]) or [""])[0] if on is not None else ctx.mode
        base = replace(ctx, mode=mode).inner() if ctx.kind else ctx.prefix
        segment, optional = _strip_groups(segment)
        path = _join(base, segment)
        for method in dict.fromkeys(methods):
            self.add(method, path, st, ctx, optional)

    def resources(self, word: str, st: _Stmt, args: list[_Arg], ctx: _Ctx) -> _Ctx:
        names = [a for a in args if a.label is None]
        options = {a.label: a for a in args if a.label is not None}
        found = _names(st, names)
        if not found:
            if names:
                self.dynamic(st, names[0])
            return replace(ctx, ignore=True)
        actions = {a for a, *_ in (_ACTIONS_MANY if word == "resources" else _ACTIONS_ONE)}
        for key in ("only", "except"):
            if key not in options:
                continue
            listed = _listed(st, options[key])
            if listed is None:
                # Набор операций выражением: какие маршруты есть, не известно.
                self.dynamic(st, options[key])
                return replace(ctx, ignore=True)
            actions = actions & listed if key == "only" else actions - listed
        path_opt = _path_arg(st, options["path"]) if "path" in options else None
        optional = False
        if path_opt is not None:
            path_opt, optional = _strip_groups(path_opt)
        param = (_names(st, [options["param"]]) or ["id"])[0] if "param" in options else "id"
        # shallow: true у ресурса — неглубокие его вложенные (П6); сам он как обычно.
        shallow = ctx.shallow or (
            "shallow" in options and st.mask[options["shallow"].start:options["shallow"].end].strip()
            == "true"
        )
        parent = ctx.inner()
        child = ctx
        for name in found:
            segment = path_opt if path_opt is not None else name
            base = _join(parent, segment)
            if word == "resources":
                # Вложенный в неглубокий: члены от префикса scope, без родителя (П6).
                own = _join(ctx.root, segment) if ctx.shallow and ctx.kind else base
                member = _join(own, ":" + param)
                for action, method, on_member, tail in _ACTIONS_MANY:
                    if action in actions:
                        self.add(
                            method, _join(member if on_member else base, tail), st, ctx, optional,
                        )
                nested = _join(own, f":{singular(name)}_{param}")
                child = _Ctx(prefix=parent, kind="resources", base=base, member=member,
                             nested=nested, unresolved=ctx.unresolved, root=ctx.root,
                             shallow=shallow, optional=ctx.optional or optional)
            else:
                for action, method, tail in _ACTIONS_ONE:
                    if action in actions:
                        self.add(method, _join(base, tail), st, ctx, optional)
                child = _Ctx(prefix=parent, kind="resource", base=base, nested=base,
                             unresolved=ctx.unresolved, root=ctx.root, shallow=shallow,
                             optional=ctx.optional or optional)
        if "concerns" in options:
            for name in _names(st, [options["concerns"]]):
                self.concern(name, child)
        return child

    def scope(self, word: str, st: _Stmt, args: list[_Arg], ctx: _Ctx) -> _Ctx:
        positional = [a for a in args if a.label is None]
        options = {a.label: a for a in args if a.label is not None}
        segment: str | None = ""
        arg = options.get("path") or (positional[0] if positional else None)
        if arg is not None:
            segment = _path_arg(st, arg)
        child = ctx.plain(ctx.inner())
        if segment is None:
            return replace(child, unresolved=True)
        segment, optional = _strip_groups(segment)
        prefix = _join(ctx.inner(), segment) if segment else ctx.inner()
        return replace(child, prefix=prefix, root=prefix, optional=child.optional or optional)

    def concern(self, name: str, ctx: _Ctx) -> None:
        body = self.concerns.get(name)
        if body is None or name in self.active:
            return
        rel, masks, raws, first = body
        saved, self.rel = self.rel, rel
        self.active.add(name)
        try:
            self.run(masks, raws, first, ctx)
        finally:
            self.rel = saved
            self.active.discard(name)

    def mount(self, st: _Stmt, args: list[_Arg], ctx: _Ctx) -> None:
        if not args:
            return
        first = args[0]
        engine = st.text[first.start:first.rocket if first.rocket >= 0 else first.end].strip()
        target: _Arg | None = None
        if first.rocket >= 0:
            target = _Arg(first.rocket + 2, first.end)
        else:
            target = next((a for a in args if a.label == "at"), None)
        segment = _path_arg(st, target) if target is not None else None
        name = engine[:200]
        if segment is not None:
            name += " " + _join(ctx.inner(), segment)
        self.hints.append(Hint("unassigned", {
            "kind": "route", "name": name, "reason": texts.REASON_RAILS_MOUNT,
            "source": str(Loc(self.rel, st.line)),
        }))

    # devise (П6)

    def devise(self, st: _Stmt, args: list[_Arg], ctx: _Ctx) -> None:
        """devise_for :имя: наборы маршрутов модулей модели под /имя (или path:) с префиксом
        объемлющих scope и namespace. Основание записей — строка devise_for."""
        options: dict[str, _Arg] = {}
        resources: list[_Arg] = []
        for arg in args:
            if arg.label is not None:
                options[arg.label] = arg
            elif arg.rocket >= 0:  # :path => 'auth'
                key = _names(st, [_Arg(arg.start, arg.rocket)])
                if key:
                    options[key[0]] = _Arg(arg.rocket + 2, arg.end)
            else:
                resources.append(arg)
        segment_opt = _path_arg(st, options["path"]) if "path" in options else None
        names = _path_names(st, options.get("path_names"))
        skip = set(_names(st, [options.get("skip")]))
        only = set(_names(st, [options.get("only")])) if "only" in options else None
        sign_out = [m.upper() for m in _names(st, [options.get("sign_out_via")])] or ["DELETE"]
        for name in _names(st, resources):
            modules = self.devise_modules(name)
            if modules is None:
                self.devise_hint(name, texts.REASON_DEVISE_MODEL, st)
                continue
            segment = _strip_groups(segment_opt)[0] if segment_opt is not None else name
            base = _join(ctx.inner(), segment)
            done: set[str] = set()
            for module in modules:
                controller = _DEVISE_MODULES.get(module)
                if controller is None:
                    if module not in _DEVISE_SILENT:
                        self.devise_hint(module, texts.REASON_DEVISE_MODULE, st)
                    continue
                if controller in done or "all" in skip or controller in skip:
                    continue
                if only is not None and controller not in only:
                    continue
                done.add(controller)
                for method, path in _devise_routes(controller, base, names, sign_out):
                    self.add(method, path, st, ctx)

    def devise_modules(self, name: str) -> list[str] | None:
        """Модули из всех вызовов devise модели app/models/<единственное число>.rb по порядку;
        None — модели нет или devise в ней не вызывается."""
        config = paths.parent(self.folder)
        rel = paths.join(paths.parent(config), f"app/models/{singular(name)}.rb")
        text = self.files.read(rel) if rel is not None else None
        if rel is None or text is None:
            return None
        code = codetext.load(self.files, rel, text, codetext.RUBY)
        if code is None:
            return None
        lines = code.mask.split("\n")
        starts = [0]
        for line in lines[:-1]:
            starts.append(starts[-1] + len(line) + 1)
        out: dict[str, None] = {}
        for calls, m in enumerate(_DEVISE_CALL.finditer(code.mask)):
            if calls >= _DEVISE_CALLS:
                break
            first = bisect_right(starts, m.start()) - 1
            last = first
            while (
                last + 1 < len(lines) and last - first < _DEVISE_LINES
                and lines[last].rstrip().endswith(",")
            ):
                last += 1
            body = "\n".join(lines[first:last + 1])[m.end() - m.start():]
            for sym in _DEVISE_SYMBOL.finditer(body):
                out.setdefault(sym.group(1))
                if len(out) >= _DEVISE_MODULES_MAX:
                    return list(out)
        return list(out) or None

    def devise_hint(self, name: str, reason: str, st: _Stmt) -> None:
        self.hints.append(Hint("unassigned", {
            "kind": "route", "name": name, "reason": reason, "source": str(Loc(self.rel, st.line)),
        }))

    def dedup(self) -> None:
        """Маршрут из необязательной группы, совпавший с другим (метод, путь, префикс), второй
        раз не пишется; два маршрута без группы остаются оба, как раньше (П6)."""
        kept: list[Route] = []
        flags: list[bool] = []
        seen: dict[tuple[str, str, bool], int] = {}
        for i, route in enumerate(self.routes):
            key = (route.method, route.path, route.prefix_unresolved)
            optional = i in self.optional
            j = seen.get(key)
            if j is None:
                seen[key] = len(kept)
                kept.append(route)
                flags.append(optional)
            elif optional:
                continue
            elif flags[j]:
                kept[j], flags[j] = route, False
            else:
                kept.append(route)
                flags.append(False)
        self.routes = kept


def _path_names(st: _Stmt, arg: _Arg | None) -> dict[str, str]:
    """path_names: { sign_in: 'login' } (или :sign_in => 'login'): имя сегмента → путь."""
    out: dict[str, str] = {}
    if arg is None:
        return out
    for m in _PATH_NAME.finditer(st.mask, arg.start, arg.end):
        quote = m.group(3)
        close = st.mask.find(quote, m.end(), arg.end)
        if close < 0:
            break
        out[m.group(1) or m.group(2)] = st.text[m.end():close]
    return out


def _devise_routes(
    controller: str, base: str, names: dict[str, str], sign_out: list[str],
) -> list[tuple[str, str]]:
    """Маршруты контроллера devise под base: сегменты по path_names (по умолчанию имя)."""
    def seg(key: str, default: str | None = None) -> str:
        return names.get(key, key if default is None else default)

    if controller == "sessions":
        sign_in = _join(base, seg("sign_in"))
        return [("GET", sign_in), ("POST", sign_in),
                *((m, _join(base, seg("sign_out"))) for m in dict.fromkeys(sign_out))]
    if controller == "registrations":
        reg = _join(base, seg("registration", ""))
        return [("GET", _join(reg, seg("cancel"))), ("GET", _join(reg, seg("sign_up"))),
                ("POST", reg), ("GET", _join(reg, seg("edit"))), ("PATCH", reg), ("DELETE", reg)]
    if controller == "omniauth_callbacks":
        auth = _join(base, "auth/:provider")
        callback = _join(auth, "callback")
        return [("GET", auth), ("POST", auth), ("GET", callback), ("POST", callback)]
    key = {"passwords": "password", "confirmations": "confirmation", "unlocks": "unlock"}[controller]
    one = _join(base, seg(key))
    out = [("GET", _join(one, seg("new"))), ("POST", one)]
    if controller == "passwords":
        return [*out, ("GET", _join(one, seg("edit"))), ("PATCH", one)]
    return [*out, ("GET", one)]


def _closing(mask: str, at: int) -> int:
    """Позиция скобки, закрывающей открытую в at (по маске), или -1."""
    depth = 0
    for m in _BRACKETS.finditer(mask, at):
        if m.group() in "([{":
            depth += 1
        else:
            depth -= 1
            if depth == 0:
                return m.start()
    return -1


def _split(st: _Stmt) -> list[_Stmt]:
    """Инструкции строки через «;» на нулевой глубине скобок."""
    if ";" not in st.mask:
        return [st]
    out: list[_Stmt] = []
    depth = 0
    last = 0
    for m in _SPLIT.finditer(st.mask):
        ch = m.group()
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        elif depth == 0:
            piece = st.mask[last:m.start()]
            out.append(_Stmt(piece, st.text[last:m.start()], st.line + st.mask.count("\n", 0, last)))
            last = m.end()
    out.append(_Stmt(st.mask[last:], st.text[last:], st.line + st.mask.count("\n", 0, last)))
    return [s for s in out if s.mask.strip()]


def _args(mask: str, pos: int) -> list[_Arg]:
    """Аргументы вызова от позиции pos: через запятую на нулевой глубине скобок, до блока
    do, модификатора if или unless и конца инструкции. Скобки вызова снимаются."""
    end = len(mask)
    if mask[pos:pos + 1] == "(":
        close = _closing(mask, pos)
        pos, end = pos + 1, close if close >= 0 else end
    out: list[_Arg] = []
    depth = 0
    start = pos
    for m in _ARG_MARKS.finditer(mask, pos, end):
        ch = m.group()
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
            if depth < 0:
                end = m.start()
                break
        elif depth == 0 and ch == ",":
            out.append(_arg(mask, start, m.start()))
            start = m.end()
        elif depth == 0 and ch in ("do", "if", "unless"):
            end = m.start()
            break
    out.append(_arg(mask, start, end))
    return [a for a in out if mask[a.start:a.end].strip()]


def _arg(mask: str, start: int, end: int) -> _Arg:
    label = _LABEL.match(mask, start, end)
    if label is not None:
        return _Arg(label.end(), end, label.group(1))
    rocket = mask.find("=>", start, end)
    return _Arg(start, end, None, rocket)


def _path_arg(st: _Stmt, arg: _Arg) -> str | None:
    """Путь из аргумента: строка как написана или символ :x как «x»; None — выражение или
    строка с подстановкой #{…}."""
    end = arg.rocket if arg.rocket >= 0 else arg.end
    raw = st.mask[arg.start:end]
    lead = len(raw) - len(raw.lstrip())
    i = arg.start + lead
    ch = st.mask[i:i + 1]
    if ch in ("'", '"'):
        close = st.mask.find(ch, i + 1, end)
        if close < 0 or st.mask[close + 1:end].strip():
            return None
        value = st.text[i + 1:close]
        if ch == '"' and "#{" in value:
            return None
        return value
    sym = _SYMBOL.match(st.mask, i, end)
    if sym is not None and not st.mask[sym.end():end].strip():
        return sym.group(1)
    return None


def _names(st: _Stmt, args: Sequence[_Arg | None]) -> list[str]:
    """Имена из аргументов: символы, строки, слова %i[…] и %w[…], элементы списка [:a, :b]."""
    out: list[str] = []
    for arg in args:
        if arg is None:
            continue
        mask, text = st.mask[arg.start:arg.end], st.text[arg.start:arg.end]
        pos = 0
        while pos < len(mask):
            ch = mask[pos]
            if ch == "%" and mask[pos + 1:pos + 2] in ("i", "w", "I", "W"):
                close = mask.find(_PAIR.get(mask[pos + 2:pos + 3], "]"), pos + 3)
                close = close if close >= 0 else len(mask)
                out.extend(text[pos + 3:close].split())
                pos = close + 1
            elif ch in ("'", '"'):
                close = mask.find(ch, pos + 1)
                close = close if close >= 0 else len(mask)
                out.append(text[pos + 1:close])
                pos = close + 1
            elif ch == ":":
                sym = _SYMBOL.match(mask, pos)
                if sym is not None:
                    out.append(sym.group(1))
                    pos = sym.end()
                else:
                    pos += 2 if mask[pos + 1:pos + 2] == ":" else 1
            elif ch.isalpha() or ch == "_":
                word = _IDENT.match(mask, pos)
                pos = word.end() if word is not None else pos + 1
            else:
                pos += 1
    return [n for n in out if n]


def _listed(st: _Stmt, arg: _Arg) -> set[str] | None:
    """Операции из only: или except:; None — набор задан выражением (константа, вызов)."""
    names = _names(st, [arg])
    if names or st.mask[arg.start:arg.end].replace(" ", "") in _EMPTY:
        return set(names)
    return None


def _symbol_at(st: _Stmt, pos: int) -> str | None:
    names = _names(st, [_Arg(pos, len(st.mask))])
    return names[0] if names else None


def _route_files(files: Files, ctx: Context) -> dict[str, list[str]]:
    """Каталог config/ → файлы карты маршрутов: config/routes.rb первым, затем
    config/routes/*.rb по порядку путей. Только у пакета Ruby с rails или railties."""
    out: dict[str, list[str]] = {}
    for rel in files.paths:
        name = paths.name(rel)
        folder = paths.parent(rel)
        if name == "routes.rb" and paths.name(folder) == "config":
            config = folder
        elif name.endswith(".rb") and paths.name(folder) == "routes" \
                and paths.name(paths.parent(folder)) == "config":
            config = paths.parent(folder)
        else:
            continue
        if not codebase.is_code_file(rel, codebase.RUBY) or files.skip_dev_code(rel):
            continue
        deps = codebase.deps_of(files, ctx, rel, codebase.RUBY)
        if not WANTED & {d.lower() for d in deps}:
            continue
        group = out.setdefault(config, [])
        if name == "routes.rb" and folder == config:
            group.insert(0, rel)
        else:
            group.append(rel)
    return out


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not codebase.stack_present(files, ctx, codebase.RUBY, WANTED):
        return found
    found.applied.add(NAME)
    for config, rels in sorted(_route_files(files, ctx).items()):
        routes = _Set(files, f"{config}/routes" if config else "routes")
        try:
            main = f"{config}/routes.rb" if config else "routes.rb"
            if rels and rels[0] == main:
                routes.file(main, _Ctx())
            for rel in rels:
                if rel != main and rel not in routes.drawn:
                    routes.file(rel, _Ctx())
        except _Overflow as over:
            files.refuse(over.rel)
            continue
        routes.dedup()
        found.routes.extend(routes.routes)
        found.hints.extend(routes.hints)
    return found
