"""Каналы Redis pub/sub в коде (ТЗ §15 п. 18 В1; решение владельца 2026-11-10: канал pub/sub
равноправен очереди).

Публикация — publish(канал, сообщение), подписка — subscribe(канал, …) и psubscribe(шаблон):
Python (redis, redis-py, aioredis; по ast), Node.js (ioredis, redis), Ruby (redis,
redis-client) и Go (go-redis: Publish(ctx, канал, …), Subscribe(ctx, канал), PSubscribe).
Вызов читается, только если получатель — клиент Redis: имя со словом redis (redis,
redisSubscribeClient, storage.redis, Redis.current) или rdb; client, pubsub, publisher и
subscriber — в файле, который подключает Redis (пакет клиента, у Python и Node.js ещё модуль
репозитория с именем redis: from posthog.redis import get_client); у Python ещё значение,
полученное от такого подключения или от метода клиента (r = redis.Redis(), get_client(),
p = r.pubsub(), pipe = r.pipeline(), with r.pipeline() as pipe, RedisHook(…).get_conn()). Так
publish других библиотек (SNS, Pub/Sub, свои классы) каналами не становится. Клиент и то, что
вернул конвейер или транзакция клиента (ТЗ §15 п. 19 В3): у Ruby параметр блока pipelined,
multi и with на клиенте (redis.pipelined do |pipeline|) внутри блока и параметр метода того же
файла на той же позиции, если метод зовут из такого блока с этим параметром; у Node.js имя,
которому в файле присвоен результат .pipeline() или .multi() клиента.

Имя канала: литерал; константа файла (у Python и импортированного модуля, у Go пакета), у
Node.js ещё константа пакета или репозитория (nodeconst); условный оператор с двумя литералами (a ? 'x' : 'y',
x if c else y) — две записи с одним основанием. Подстановка, переменная и вызов — подсказка
«имя канала задано выражением» с текстом выражения, одна на место; шаблон psubscribe со
знаком *, ? или [ — подсказка «задано шаблоном». Владельца-контейнера и объект Redis выбирает
сборка (codefacts): объект Redis становится брокером только по записи, у которой контейнер
определён.
"""

from __future__ import annotations

import ast
import heapq
import re
from collections import Counter
from collections.abc import Callable, Iterator

from archmap_scan import (
    codebase,
    codetext,
    gocode,
    nodeconst,
    paths,
    pyast,
    pycode,
    texts,
)
from archmap_scan.codetext import STR
from archmap_scan.context import Context
from archmap_scan.model import ChannelUse, Findings, Hint, Loc
from archmap_scan.walk import Files

NAME = "redis-pubsub"
CLIENT = "Redis"
KIND = "channel"
PY_WANTED = frozenset({"redis", "redis-py", "aioredis"})
JS_WANTED = frozenset({"ioredis", "redis", "@redis/client"})
RB_WANTED = frozenset({"redis", "redis-client"})
GO_WANTED = frozenset({"github.com/redis/go-redis", "github.com/go-redis/redis"})
_DIRECTION = {
    "publish": "publish", "subscribe": "consume", "psubscribe": "consume",
    "Publish": "publish", "Subscribe": "consume", "PSubscribe": "consume",
}
_PATTERN_VERBS = frozenset({"psubscribe", "PSubscribe"})
_GLOB = frozenset("*?[")
# Имена получателя, которые клиентом Redis считаются только в файле с подключением Redis.
_CLIENT_NAMES = frozenset({"client", "pubsub", "publisher", "subscriber"})
_PY_MODULE_PARTS = frozenset({"redis", "aioredis"})
_NEEDLES = ("publish", "subscribe", "Publish", "Subscribe")
_PY_VERBS = frozenset({"publish", "subscribe", "psubscribe"})
# Дешёвый отбор файла до разбора: вызов метода pub/sub и слово redis или rdb где-нибудь в
# тексте (клиент Redis по имени, подключению или фабрике без этих слов не бывает).
_ANY_CALL = re.compile(r"\.[ \t]*(?:publish|p?subscribe|Publish|P?Subscribe)\b")
_ANY_REDIS = re.compile(r"redis|rdb", re.IGNORECASE)
# Пределы враждебного входа: вызовов на файл (дальше файл непрочитан) и длина аргументов.
_MAX_CALLS = 2000
_MAX_ARGS = 2000
_MAX_BACK = 200
# Звеньев await и вызовов методов в выражении клиента Python.
_MAX_CHAIN = 50

_JS_CALL = re.compile(r"\.[ \t]*(publish|subscribe|psubscribe)[ \t]*\(")
_JS_SPEC = re.compile(rf"(?:\bfrom|\brequire|\bimport)[ \t]*\(?[ \t]*({STR})")
_RB_CALL = re.compile(r"\.(publish|subscribe|psubscribe)(?![\w?!])[ \t]*(\(|(?=['\"]))")
_GO_CALL = re.compile(r"\.[ \t]*(Publish|Subscribe|PSubscribe)[ \t]*\(")
_IDENT = re.compile(r"[A-Za-z_$][\w$]{0,199}")
_RB_IDENT = re.compile(r"[@$]{0,2}[A-Za-z_]\w{0,199}")
_STR_TOKEN = re.compile(STR)
# Обработчик подписки: функция или стрелка (JS), дальше аргументов-каналов нет.
_CALLBACK = re.compile(r"(?:async|function)\b")


class _Out:
    """Записи и подсказки одного файла; больше _MAX_CALLS вызовов — файл непрочитан."""

    def __init__(self, files: Files, rel: str) -> None:
        self.files = files
        self.rel = rel
        self.uses: list[ChannelUse] = []
        self.hints: list[Hint] = []
        self.calls = 0

    def call(self) -> bool:
        self.calls += 1
        return self.calls <= _MAX_CALLS

    def use(self, name: str, verb: str, line: int) -> None:
        self.uses.append(ChannelUse(
            name=name, kind=KIND, client=CLIENT, direction=_DIRECTION[verb],
            loc=Loc(self.rel, line), parser=NAME,
        ))

    def hint(self, expr: str, line: int, reason: str = texts.REASON_DYNAMIC_CHANNEL) -> None:
        self.hints.append(Hint("dynamic_names", {
            "kind": "channel", "name": expr or "?", "reason": reason,
            "source": str(Loc(self.rel, line)),
        }))

    def names(self, names: list[str], verb: str, line: int) -> bool:
        """Литеральные имена вызова: у psubscribe шаблон со знаком * ? [ — подсказка."""
        for name in names:
            if verb in _PATTERN_VERBS and _GLOB & set(name):
                self.hint(name, line, texts.REASON_CHANNEL_PATTERN)
                return False
        for name in names:
            if name:
                self.use(name, verb, line)
        return True

    def done(self, found: Findings) -> None:
        if self.calls > _MAX_CALLS:
            self.files.refuse(self.rel)
            return
        found.channels.extend(self.uses)
        found.hints.extend(self.hints)


# Python

class _Py:
    """Файл Python: какие имена — модуль Redis, конструкторы клиента и значения-клиенты."""

    def __init__(self, files: Files, rel: str, tree: ast.Module) -> None:
        self.files = files
        self.rel = rel
        self.tree = tree
        self.imps = pycode.imports(tree)
        self.modules: set[str] = set()
        self.factories: set[str] = set()
        for name, imp in self.imps.items():
            parts = imp.target.lstrip(".").split(".")
            if not _PY_MODULE_PARTS & set(parts):
                continue
            if imp.attr is None or parts[-1] in _PY_MODULE_PARTS or parts[-1] == "asyncio":
                self.modules.add(name)
            else:
                self.factories.add(name)
        self.imported = bool(self.modules or self.factories)
        self.values: set[str] = set()
        # Один обход дерева: присваивания и вызовы publish, subscribe, psubscribe.
        assigns: list[tuple[list[ast.expr], ast.expr]] = []
        self.calls: list[tuple[ast.Call, ast.Attribute]] = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                assigns.append((node.targets, node.value))
            elif isinstance(node, ast.AnnAssign) and node.value is not None:
                assigns.append(([node.target], node.value))
            elif isinstance(node, (ast.With, ast.AsyncWith)):
                # with r.pipeline() as pipe: значение контекста — то же присваивание (В3).
                assigns.extend(
                    ([item.optional_vars], item.context_expr)
                    for item in node.items if item.optional_vars is not None
                )
            elif (
                isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr in _PY_VERBS
            ):
                self.calls.append((node, node.func))
        # Два прохода по присваиваниям: p = r.pubsub() после r = redis.Redis().
        for _ in range(2):
            for targets, value in assigns:
                if self.client(value):
                    for target in targets:
                        dotted = pycode.dotted(target)
                        if dotted is not None:
                            self.values.add(dotted)

    def _named(self, name: str) -> bool:
        low = name.lower()
        return "redis" in low or low == "rdb" or (self.imported and low in _CLIENT_NAMES)

    def client(self, node: ast.AST) -> bool:
        """Выражение — клиент Redis. Цепочка await и вызовов методов проходится циклом
        (глубокое дерево враждебного входа рекурсию не роняет)."""
        for _ in range(_MAX_CHAIN):
            if isinstance(node, ast.Await):
                node = node.value
                continue
            if isinstance(node, ast.Name):
                if node.id in self.values:
                    return True
                # Импортированное имя — модуль или функция (from …sessions import pubsub), не
                # клиент; клиент из импорта даёт только вызов фабрики.
                return node.id not in self.imps and self._named(node.id)
            if isinstance(node, ast.Attribute):
                dotted = pycode.dotted(node)
                return (dotted is not None and dotted in self.values) or self._named(node.attr)
            if not isinstance(node, ast.Call):
                return False
            # Конструктор или фабрика клиента: redis.Redis(), Redis.from_url(), get_client()
            # из модуля Redis, get_redis_connection(), self.get_redis(); метод клиента даёт
            # клиента: r.pubsub(), r.pipeline(), RedisHook(…).get_conn() (Airflow).
            func = node.func
            if isinstance(func, ast.Name):
                return func.id in self.factories or "redis" in func.id.lower()
            if not isinstance(func, ast.Attribute):
                return False
            base = pycode.dotted(func.value)
            head = base.split(".", 1)[0] if base else None
            if head is not None and (head in self.modules or head in self.factories):
                return True
            if "redis" in func.attr.lower():
                return True
            node = func.value
        return False

    def constant(self, name: str) -> str | None:
        """Строковая константа модуля: своя или импортированная из модуля репозитория."""
        value = pycode.string(pyast.module_assign(self.tree, name))
        if value is not None:
            return value
        imp = self.imps.get(name)
        if imp is None or not imp.attr:
            return None
        target = codebase.resolve_module(self.files, self.rel, imp.module, imp.level)
        if target is None:
            return None
        text = self.files.read(target, keep=False)
        tree = pyast.parse(text) if text is not None else None
        return pycode.string(pyast.module_assign(tree, imp.attr)) if tree is not None else None

    def names(self, node: ast.AST) -> list[str] | None:
        one = pycode.string(node)
        if one is not None:
            return [one]
        if isinstance(node, ast.IfExp):
            body, orelse = pycode.string(node.body), pycode.string(node.orelse)
            if body is not None and orelse is not None:
                return [body, orelse]
            return None
        if isinstance(node, ast.Name):
            value = self.constant(node.id)
            return [value] if value is not None else None
        return None


def _py_args(call: ast.Call, verb: str) -> Iterator[ast.AST | str]:
    """Аргументы-каналы вызова: у publish первый (или channel=), у subscribe все
    позиционные, имена именованных и ключи словаря **{…} (обработчики redis-py)."""
    if verb == "publish":
        node = pycode.arg(call, 0, "channel")
        if node is not None:
            yield node
        return
    for arg in call.args:
        yield arg.value if isinstance(arg, ast.Starred) else arg
    for kw in call.keywords:
        if kw.arg is not None:
            yield kw.arg
        elif isinstance(kw.value, ast.Dict):
            yield from (k for k in kw.value.keys if k is not None)
        else:
            yield kw.value


def _python(py: _Py, out: _Out) -> None:
    for node, func in sorted(py.calls, key=lambda item: (item[0].lineno, item[0].col_offset)):
        verb = func.attr
        if not py.client(func.value):
            continue
        if not out.call():
            return
        line = node.lineno
        for arg in _py_args(node, verb):
            names = [arg] if isinstance(arg, str) else py.names(arg)
            if names is None:
                assert isinstance(arg, ast.AST)
                out.hint(pycode.short(arg), line,
                         pycode.dynamic_reason(arg, texts.REASON_DYNAMIC_CHANNEL))
                break
            if not out.names(names, verb, line):
                break


# Общее для кода по маске

def _back_ident(mask: str, dot: int, chars: str) -> tuple[str, int] | None:
    """Имя перед точкой вызова (пробелы и переводы строк между ними допустимы) и его начало."""
    i = dot - 1
    stop = max(-1, dot - _MAX_BACK)
    while i > stop and mask[i] in " \t\r\n":
        i -= 1
    if i > stop and mask[i] == "?":  # необязательная цепочка TypeScript: redis?.publish(
        i -= 1
    end = i + 1
    while i > stop and (mask[i].isalnum() or mask[i] in chars):
        i -= 1
    name = mask[i + 1:end]
    if not name or name[0].isdigit():
        return None
    return name, i + 1


def _args(mask: str, start: int) -> list[tuple[int, int]] | None:
    """Аргументы вызова от позиции после «(» по запятым верхнего уровня (gocode.split_spans:
    маска JavaScript и Ruby в скобках устроена так же); дальше _MAX_ARGS знаков или без
    парной «)» — None (код оборван)."""
    parts = gocode.split_spans(mask, start, _MAX_ARGS)
    return parts[0] if parts is not None else None


def _strip(mask: str, start: int, end: int) -> tuple[int, int]:
    while start < end and mask[start] in " \t\r\n":
        start += 1
    while end > start and mask[end - 1] in " \t\r\n":
        end -= 1
    return start, end


def _literal(code: codetext.Code, start: int, end: int) -> str | None:
    """Значение, если отрезок — один строковый литерал без подстановок, иначе None."""
    m = _STR_TOKEN.fullmatch(code.mask, start, end)
    if m is None:
        return None
    value = code.text[start + 1:end - 1]
    if "${" in value or "#{" in value or "\\" in value:
        return None
    return value


def _ternary(code: codetext.Code, start: int, end: int) -> list[str] | None:
    """«условие ? 'x' : 'y'»: два литерала ветвей, иначе None. Знак ? Ruby-метода
    (local?) условием не считается: перед ? условного оператора стоит пробел."""
    mask = code.mask
    tokens = list(_STR_TOKEN.finditer(mask, start, end))
    if len(tokens) < 2:
        return None
    first, second = tokens[-2], tokens[-1]
    if second.end() != end or mask[first.end():second.start()].strip() != ":":
        return None
    before = mask[start:first.start()].rstrip()
    if not before.endswith("?") or len(before) < 2 or before[-2] not in " \t":
        return None
    a = _literal(code, first.start(), first.end())
    b = _literal(code, second.start(), second.end())
    return [a, b] if a is not None and b is not None else None


def _expression(code: codetext.Code, start: int, end: int) -> str:
    return " ".join(code.text[start:min(end, start + 80)].split())


# Node.js

def _js_imports_redis(code: codetext.Code) -> bool:
    """Файл подключает Redis: пакет клиента или модуль, в последней части пути которого есть
    слово redis (./redis.js, ./redis-execution-response-channel)."""
    for m in _JS_SPEC.finditer(code.mask):
        spec = code.text[m.start(1) + 1:m.end(1) - 1].lower()
        if spec in JS_WANTED or any(spec.startswith(w + "/") for w in JS_WANTED):
            return True
        if "redis" in spec.rstrip("/").rsplit("/", 1)[-1]:
            return True
    return False


_JS_PIPE = re.compile(r"\.[ \t]*(?:pipeline|multi)[ \t]*\(")


def _js_assigned(mask: str, start: int) -> str | None:
    """Имя слева от «=» перед выражением, которое начинается в start (через пробелы и await):
    «const pipeline = this.redis.pipeline()» → pipeline. Цепочка получателя (this.redis)
    проходится назад; всё в пределах _MAX_BACK знаков."""
    i = start - 1
    stop = max(-1, start - _MAX_BACK)
    while i > stop and (mask[i].isalnum() or mask[i] in "_$."):
        i -= 1
    while i > stop and mask[i] in " \t":
        i -= 1
    if i - 4 > stop and mask.startswith("await", i - 4) and not (
        i - 5 > stop and (mask[i - 5].isalnum() or mask[i - 5] in "_$")
    ):
        i -= 5
        while i > stop and mask[i] in " \t":
            i -= 1
    if i <= stop or mask[i] != "=" or (i > 0 and mask[i - 1] in "=!<>+-*/%&|^?"):
        return None
    found = _back_ident(mask, i, "_$")
    return found[0] if found is not None else None


def _js_pipes(mask: str, client: Callable[[str], bool]) -> frozenset[str]:
    """Имена, которым в файле присвоен результат .pipeline() или .multi() клиента Redis
    (ТЗ §15 п. 19 В3): const pipeline = redis.pipeline()."""
    out: set[str] = set()
    for m in _JS_PIPE.finditer(mask):
        recv = _back_ident(mask, m.start(), "_$")
        if recv is None or not client(recv[0]):
            continue
        name = _js_assigned(mask, recv[1])
        if name is not None:
            out.add(name)
    return frozenset(out)


def _js(files: Files, ctx: Context, rel: str, code: codetext.Code, out: _Out) -> None:
    mask = code.mask
    imported: bool | None = None
    pipes: frozenset[str] | None = None

    def client(name: str) -> bool:
        nonlocal imported
        low = name.lower()
        if "redis" in low or low == "rdb":
            return True
        if low not in _CLIENT_NAMES:
            return False
        if imported is None:
            imported = _js_imports_redis(code)
        return imported

    def constant(name: str) -> tuple[str | None, str]:
        found = nodeconst.index(files, ctx).lookup(rel, name, code)
        if found is nodeconst.AMBIGUOUS:
            return None, texts.REASON_CONST_AMBIGUOUS
        return (found.value if found is not None else None), texts.REASON_DYNAMIC_CHANNEL

    for m in _JS_CALL.finditer(mask):
        recv = _back_ident(mask, m.start(), "_$")
        if recv is None:
            continue
        if not client(recv[0]):
            if pipes is None:
                pipes = _js_pipes(mask, client) if _JS_PIPE.search(mask) else frozenset()
            if recv[0] not in pipes:
                continue
        if not out.call():
            return
        verb = m.group(1)
        spans = _args(mask, m.end())
        if spans is None:
            continue
        _mask_args(code, spans if verb != "publish" else spans[:1], verb, code.line(m.start()),
                   out, constant)


def _mask_args(
    code: codetext.Code, spans: list[tuple[int, int]], verb: str, line: int, out: _Out,
    constant: Callable[[str], tuple[str | None, str]] | None,
) -> None:
    """Аргументы-каналы по маске: литерал, условный оператор с литералами, имя константы.
    Функция-обработчик (подписка с обратным вызовом) заканчивает список; первое выражение —
    подсказка, одна на место."""
    mask = code.mask
    for raw_start, raw_end in spans:
        start, end = _strip(mask, raw_start, raw_end)
        if start >= end:
            continue
        if _CALLBACK.match(mask, start, end) or "=>" in mask[start:end]:
            return
        value = _literal(code, start, end)
        names = [value] if value is not None else _ternary(code, start, end)
        reason = code.reason(start, end, texts.REASON_DYNAMIC_CHANNEL)
        if names is None:
            ident = _IDENT.fullmatch(mask, start, end)
            if ident is not None and constant is not None:
                resolved, reason = constant(ident.group())
                names = [resolved] if resolved is not None else None
        if names is None:
            out.hint(_expression(code, start, end), line, reason)
            return
        if not out.names(names, verb, line):
            return


# Ruby

def _rb_receiver(mask: str, dot: int) -> str | None:
    """Цепочка получателя перед точкой: redis, @redis, $redis, Redis.current."""
    i = dot - 1
    stop = max(-1, dot - _MAX_BACK)
    while i > stop and (mask[i].isalnum() or mask[i] in "_@$.:"):
        i -= 1
    chain = mask[i + 1:dot]
    return chain or None


def _rb_args(mask: str, start: int, paren: bool) -> list[tuple[int, int]] | None:
    """Аргументы Ruby: в скобках — как у JS, без скобок — до конца строки или «do»/«{»."""
    if paren:
        return _args(mask, start)
    end = mask.find("\n", start, start + _MAX_ARGS)
    end = end if end != -1 else min(len(mask), start + _MAX_ARGS)
    out: list[tuple[int, int]] = []
    begin = start
    for i in range(start, end):
        if mask[i] == "," :
            out.append((begin, i))
            begin = i + 1
        elif mask[i] == "{" or mask.startswith(" do", i):
            end = i
            break
    out.append((begin, end))
    return out


# Глаголы получателя-клиента, чей блок отдаёт клиента параметром: redis.pipelined do |p|,
# redis.multi { |m| }, Redis.current.with do |conn|.
_RB_OWNER = re.compile(r"\.(?:pipelined|multi|with)(?![\w?!])")
_RB_BLOCK_HINT = (".pipelined", ".multi", ".with")
# Один проход по маске: ключевое слово блока в начале инструкции (и после присваивания
# «x = if»), do и end словом (не метод .end и не символ :end), фигурные скобки блоков и
# хешей. Знак перед словом проверяется после его первой буквы: так проверка не идёт на
# каждой позиции файла.
_RB_SCAN = re.compile(
    r"^[ \t]*(?:[@$]{0,2}[A-Za-z_][\w.]{0,199}[ \t]*(?:\|\||&&)?=(?![=~>])[ \t]*)?"
    r"(?P<kw>if|unless|while|until|case|begin|for|def|class|module)(?![\w?!:])"
    r"|(?P<end>e(?<![\w.:@$?!]e)nd)(?![\w?!:])|(?P<do>d(?<![\w.:@$?!]d)o)(?![\w?!:])"
    r"|(?P<lb>\{)|(?P<rb>\})",
    re.MULTILINE,
)
# Вызов метода без получателя «имя(» (внутри блоков-клиентов, второй проход).
_RB_FUNCALL = re.compile(r"[a-z_](?<![\w.:@$][a-z_])\w{0,199}[?!]?\(")
# Метод без end (Ruby 3): «def имя(…) = выражение», «def имя = выражение». Сеттер
# «def имя=(v)» (знак = сразу за именем) — обычный метод до end.
_RB_ENDLESS = re.compile(
    r"[ \t]*def[ \t]+[\w.]{1,200}[?!]?(?:\([^)\n]{0,500}\)[ \t]*|[ \t]+)=(?![=~>])"
)
_RB_DEF = re.compile(
    r"[ \t]*def[ \t]+(?:self\.)?([A-Za-z_]\w{0,199}[?!]?)[ \t]*(?:\(([^)\n]{0,500})\)|([^\n;]{0,500}))"
)
_RB_PARAMS = re.compile(r"[ \t]*\|([^|\n]{0,200})\|")
_RB_DO = re.compile(r"[ \t]*(?:do(?![\w?!:])|\{)")
# Пределы враждебного входа: блоков-клиентов, вызовов методов с клиентом и методов файла.
_MAX_BLOCKS = 2000
_MAX_METHODS = 10_000
_NO_NAMES: frozenset[str] = frozenset()


def _rb_names(text: str) -> frozenset[str]:
    """Имена параметров блока: |a, b| → {a, b}; именованные (k:) и вложенные не берутся."""
    out = []
    for part in text.split(","):
        name = part.strip().lstrip("*&").split("=", 1)[0].strip()
        if name and not name.endswith(":") and _RB_IDENT.fullmatch(name):
            out.append(name)
    return frozenset(out)


def _rb_positional(text: str) -> list[str]:
    """Позиционные параметры метода по порядку (именованные k: и блок &b пропускаются)."""
    out = []
    for part in text.split(","):
        raw = part.strip()
        if not raw or raw.startswith("&") or ":" in raw.split("=", 1)[0]:
            continue
        out.append(raw.lstrip("*").split("=", 1)[0].strip())
    return out


def _rb_client_chain(chain: str, names: Counter[str]) -> bool:
    """Цепочка получателя — клиент Redis: слово redis или rdb, либо имя-клиент блока."""
    low = chain.lower()
    return "redis" in low or "rdb" in low.replace("@", "").split(".") or names[chain] > 0


def _rb_owners(mask: str) -> dict[int, str]:
    """Начало блока (do или «{») → цепочка получателя для вызовов pipelined, multi и with:
    «redis.pipelined do», «Redis.current.with(pool) {». Не больше _MAX_BLOCKS вызовов."""
    out: dict[int, str] = {}
    for count, m in enumerate(_RB_OWNER.finditer(mask)):
        if count >= _MAX_BLOCKS:
            break
        chain = _rb_receiver(mask, m.start())
        if chain is None:
            continue
        at = m.end()
        if mask.startswith("(", at):
            spans = gocode.split_spans(mask, at + 1, _MAX_ARGS)
            if spans is None:
                continue
            at = spans[1] + 1
        opener = _RB_DO.match(mask, at)
        if opener is not None:
            out[opener.end() - (1 if mask[opener.end() - 1] == "{" else 2)] = chain
    return out


def _rb_def_name(mask: str, at: int) -> bool:
    """«имя(» на позиции at — имя метода в строке def (def имя(, def self.имя(), а не вызов."""
    if mask.startswith("self.", at - 5):
        at -= 5
    while at > 0 and mask[at - 1] in " \t":
        at -= 1
    return mask.endswith("def", 0, at) and (at == 3 or not (mask[at - 4].isalnum() or mask[at - 4] == "_"))


def _rb_wanted(mask: str, blocks: list[tuple[int, int, frozenset[str]]]) -> dict[str, set[int]]:
    """Вызовы методов без получателя внутри блоков-клиентов: имя метода → позиции
    аргументов, где стоит имя-клиент открытого в этом месте блока. Отрезки блоков сливаются,
    каждый знак файла просматривается один раз; не больше _MAX_CALLS вызовов."""
    order = sorted(blocks, key=lambda b: (b[0], b[1]))
    wanted: dict[str, set[int]] = {}
    active: Counter[str] = Counter()
    ends: list[tuple[int, int]] = []
    nxt = 0
    calls = 0
    pos = 0
    while nxt < len(order) or ends:
        if not ends:
            pos = max(pos, order[nxt][0])
        # Граница отрезка: начало следующего блока или конец ближайшего открытого.
        stop = min(order[nxt][0] if nxt < len(order) else len(mask), ends[0][0] if ends else len(mask))
        if stop > pos and ends:
            for m in _RB_FUNCALL.finditer(mask, pos, stop):
                if calls >= _MAX_CALLS:
                    return wanted
                if _rb_def_name(mask, m.start()):
                    continue
                calls += 1
                name = mask[m.start():m.end() - 1]
                for index, (a, b) in enumerate(_args(mask, m.end()) or []):
                    if active[mask[a:b].strip()] > 0:
                        wanted.setdefault(name, set()).add(index)
        pos = max(pos, stop)
        while nxt < len(order) and order[nxt][0] <= pos:
            heapq.heappush(ends, (order[nxt][1], nxt))
            active.update(order[nxt][2])
            nxt += 1
        while ends and ends[0][0] <= pos:
            _end, index = heapq.heappop(ends)
            active.subtract(order[index][2])
    return wanted


def _rb_spans(code: codetext.Code) -> list[tuple[int, int, frozenset[str]]]:
    """Отрезки файла, где имя — клиент Redis (ТЗ §15 п. 19 В3): тело блока pipelined, multi
    или with у клиента (его параметры: redis.pipelined do |pipeline|) и тело метода того же
    файла, которому параметр такого блока передан аргументом, с параметром на той же позиции
    (Mastodon unpush_from_public_timelines(status, pipeline)). Один проход по маске со стеком
    блоков (ключевые слова в начале инструкции, do и end, фигурные скобки), вызовы методов
    внутри блоков-клиентов — проходом по их отрезкам (_rb_wanted)."""
    mask = code.mask
    owners = _rb_owners(mask)
    # Открытые блоки: (начало, фигурная скобка, имена-клиенты, метод). Метод — начало слова
    # def; имя и параметры разбираются в конце и только при вызовах с клиентом.
    frames: list[tuple[int, bool, frozenset[str], bool]] = []
    active: Counter[str] = Counter()  # имена-клиенты открытых блоков
    blocks: list[tuple[int, int, frozenset[str]]] = []
    methods: list[tuple[int, int]] = []
    skip_do = -1  # do цикла while, until, for на этой строке блока не открывает

    def close(frame: tuple[int, bool, frozenset[str], bool], at: int) -> None:
        start, _brace, names, method = frame
        if names:
            active.subtract(names)
            blocks.append((start, at, names))
        if method and len(methods) < _MAX_METHODS:
            methods.append((start, at))

    for m in _RB_SCAN.finditer(mask):
        kind = m.lastgroup
        if kind == "end" or kind == "rb":
            # end закрывает блок do и ключевого слова, «}» — фигурную скобку.
            if frames and frames[-1][1] == (kind == "rb"):
                frame = frames.pop()
                if frame[2] or frame[3]:
                    close(frame, m.start())
            continue
        if kind == "kw":
            word = m.group("kw")
            if word == "def":
                line_end = mask.find("\n", m.end())
                line_end = line_end if line_end != -1 else len(mask)
                if mask.find("=", m.end(), line_end) != -1 \
                        and _RB_ENDLESS.match(mask, m.start()) is not None:
                    continue
            elif word in ("while", "until", "for"):
                line_end = mask.find("\n", m.end())
                skip_do = line_end if line_end != -1 else len(mask)
            frames.append((m.start("kw"), False, _NO_NAMES, word == "def"))
            continue
        at = m.start()
        if kind == "do" and at < skip_do:
            skip_do = -1
            continue
        names = _NO_NAMES
        owner = owners.get(at)
        if owner is not None and _rb_client_chain(owner, active):
            bars = _RB_PARAMS.match(mask, m.end())
            if bars is not None:
                names = _rb_names(bars.group(1))
                active.update(names)
        frames.append((at, kind == "lb", names, False))
    while frames:
        close(frames.pop(), len(mask))
    wanted = _rb_wanted(mask, blocks) if blocks and methods else {}
    spans = list(blocks)
    for start, stop in methods if wanted else ():
        d = _RB_DEF.match(mask, start)
        positions = wanted.get(d.group(1)) if d is not None else None
        if d is None or not positions:
            continue
        positional = _rb_positional(d.group(2) or d.group(3) or "")
        for index in sorted(positions):
            if index < len(positional) and positional[index]:
                spans.append((start, stop, frozenset({positional[index]})))
    return sorted(spans, key=lambda s: (s[0], s[1]))


def _ruby(code: codetext.Code, out: _Out) -> None:
    mask = code.mask
    # Блоки pipelined, multi и with ищутся, только если такие вызовы в файле есть.
    spans = _rb_spans(code) if any(h in code.text for h in _RB_BLOCK_HINT) else []
    names: Counter[str] = Counter()
    ends: list[tuple[int, int]] = []  # (конец отрезка, номер) открытых отрезков
    nxt = 0
    for m in _RB_CALL.finditer(mask):
        at = m.start()
        while nxt < len(spans) and spans[nxt][0] <= at:
            heapq.heappush(ends, (spans[nxt][1], nxt))
            names.update(spans[nxt][2])
            nxt += 1
        while ends and ends[0][0] <= at:
            _end, index = heapq.heappop(ends)
            names.subtract(spans[index][2])
        chain = _rb_receiver(mask, at)
        if chain is None or not _rb_client_chain(chain, names):
            continue
        if not out.call():
            return
        verb = m.group(1)
        spans_args = _rb_args(mask, m.end(), m.group(2) == "(")
        if not spans_args:
            continue
        _mask_args(code, spans_args if verb != "publish" else spans_args[:1], verb,
                   code.line(at), out, None)


# Go

class _GoConsts:
    """Строковые константы пакета Go (все файлы каталога), разбор по требованию."""

    def __init__(self, files: Files) -> None:
        self.files = files
        self.by_dir: dict[str, dict[str, str]] = {}

    def get(self, rel: str, code: codetext.Code, name: str) -> str | None:
        folder = paths.parent(rel)
        if folder not in self.by_dir:
            consts: dict[str, str] = {
                key: value for key, (value, _at) in gocode.string_constants(code.text, code.mask).items()
            }
            for other in self.files.paths:
                if other == rel or paths.parent(other) != folder or not other.endswith(".go"):
                    continue
                if other.endswith("_test.go"):
                    continue
                text = self.files.read(other, keep=False)
                other_code = codetext.load(self.files, other, text, codetext.GO) if text else None
                if other_code is not None:
                    for key, (value, _at) in gocode.string_constants(other_code.text, other_code.mask).items():
                        consts.setdefault(key, value)
            self.by_dir[folder] = consts
        return self.by_dir[folder].get(name)


def _go(rel: str, code: codetext.Code, out: _Out, consts: _GoConsts) -> None:
    mask = code.mask
    for m in _GO_CALL.finditer(mask):
        recv = _back_ident(mask, m.start(), "_")
        if recv is None:
            continue
        low = recv[0].lower()
        if "redis" not in low and low not in ("rdb", "client"):
            continue
        if not out.call():
            return
        verb = m.group(1)
        spans = _args(mask, m.end())
        if spans is None or len(spans) < 2:
            continue
        chosen = spans[1:2] if verb == "Publish" else spans[1:]
        _mask_args(code, chosen, verb, code.line(m.start()), out,
                   lambda name: (consts.get(rel, code, name), texts.REASON_DYNAMIC_CHANNEL))


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    stacks = [
        (lang, wanted) for lang, wanted in (
            (codebase.PYTHON, PY_WANTED), (codebase.NODE, JS_WANTED),
            (codebase.RUBY, RB_WANTED), (codebase.GO, GO_WANTED),
        )
        if codebase.stack_present(files, ctx, lang, wanted)
    ]
    if not stacks:
        return found
    found.applied.add(NAME)
    go_consts = _GoConsts(files)
    for lang, wanted in stacks:
        for rel, text in codebase.sources(files, ctx, lang, wanted, _NEEDLES):
            if _ANY_CALL.search(text) is None or _ANY_REDIS.search(text) is None:
                continue
            out = _Out(files, rel)
            if lang == codebase.PYTHON:
                tree = pyast.parse(text)
                if tree is not None:
                    _python(_Py(files, rel, tree), out)
            elif lang == codebase.GO:
                if not codetext.imports(text, wanted, codetext.GO):
                    continue
                code = codetext.load(files, rel, text, codetext.GO)
                if code is not None:
                    _go(rel, code, out, go_consts)
            else:
                kind = codetext.JS if lang == codebase.NODE else codetext.RUBY
                code = codetext.load(files, rel, text, kind)
                if code is None:
                    continue
                if lang == codebase.NODE:
                    _js(files, ctx, rel, code, out)
                else:
                    _ruby(code, out)
            out.done(found)
    return found
