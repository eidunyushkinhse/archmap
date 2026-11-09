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

Пределы: 50 000 строк, 5000 записей на файл, 50 вложенных блоков; сверх этого набор
маршрутов не пишется, а файл считается непрочитанным.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, field, replace

from archmap_scan import codebase, codetext, paths, texts
from archmap_scan.context import Context
from archmap_scan.model import Findings, Hint, Loc, Route
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
    "collection", "concerns", "mount", "draw",
})
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

    def inner(self) -> str:
        """Префикс для вложенного ресурса, namespace и scope."""
        if self.kind == "resources":
            return self.member if self.mode == "member" else (
                self.base if self.mode == "collection" else self.nested
            )
        return self.base if self.kind else self.prefix

    def plain(self, prefix: str) -> _Ctx:
        return _Ctx(prefix=prefix, ignore=self.ignore, unresolved=self.unresolved)


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

    def add(self, method: str, path: str, st: _Stmt, ctx: _Ctx) -> None:
        count = self.counts.get(self.rel, 0) + 1
        self.counts[self.rel] = count
        if count > _MAX_ROUTES:
            raise _Overflow(self.rel)
        self.routes.append(Route(
            method=method, path=path, loc=Loc(self.rel, st.line), framework=FRAMEWORK,
            parser=NAME, prefix_unresolved=ctx.unresolved,
        ))

    def dynamic(self, st: _Stmt, arg: _Arg) -> None:
        self.hints.append(Hint("dynamic_names", {
            "kind": "route", "name": st.text[arg.start:arg.end].strip()[:200],
            "reason": texts.REASON_DYNAMIC_ROUTE, "source": str(Loc(self.rel, st.line)),
        }))

    def verb(self, word: str, st: _Stmt, args: list[_Arg], ctx: _Ctx) -> None:
        positional = [a for a in args if a.label is None]
        options = {a.label: a for a in args if a.label is not None}
        if not positional:
            return
        first = positional[0]
        segment = _path_arg(st, first)
        if segment is None:
            self.dynamic(st, first)
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
        path = _join(base, segment)
        for method in dict.fromkeys(methods):
            self.add(method, path, st, ctx)

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
        param = (_names(st, [options["param"]]) or ["id"])[0] if "param" in options else "id"
        parent = ctx.inner()
        child = ctx
        for name in found:
            segment = path_opt if path_opt is not None else name
            base = _join(parent, segment)
            if word == "resources":
                member = _join(base, ":" + param)
                for action, method, on_member, tail in _ACTIONS_MANY:
                    if action in actions:
                        self.add(method, _join(member if on_member else base, tail), st, ctx)
                nested = _join(base, f":{singular(name)}_{param}")
                child = _Ctx(prefix=parent, kind="resources", base=base, member=member,
                             nested=nested, unresolved=ctx.unresolved)
            else:
                for action, method, tail in _ACTIONS_ONE:
                    if action in actions:
                        self.add(method, _join(base, tail), st, ctx)
                child = _Ctx(prefix=parent, kind="resource", base=base, nested=base,
                             unresolved=ctx.unresolved)
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
        return replace(child, prefix=_join(ctx.inner(), segment) if segment else ctx.inner())

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
        found.routes.extend(routes.routes)
        found.hints.extend(routes.hints)
    return found
