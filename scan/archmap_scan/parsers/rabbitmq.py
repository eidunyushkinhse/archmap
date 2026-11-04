"""Очереди и обменники RabbitMQ в коде (ТЗ §6.2).

Python (pika, aio-pika; файл импортирует одну из них): queue_declare(queue="q") и
declare_queue("q") — объявление очереди, exchange_declare(exchange="e") и
declare_exchange("e") — обменника, queue_bind — обоих; basic_publish(exchange="e",
routing_key="k") — публикация в обменник, а с пустым exchange — в очередь k;
default_exchange.publish(…, routing_key="q") — в очередь; basic_consume(queue="q") —
потребление. amqplib (файл подключает amqplib или amqp-connection-manager):
assertQueue('q'), assertExchange('e'), bindQueue, sendToQueue('q'), publish('e', 'k') и
consume('q'). Адрес брокера литералом в том же файле
(URLParameters, ConnectionParameters(host=), connect('amqp://…')) помогает найти
брокер-владелец. Имя не строкой — в hints.dynamic_names. Python: реестры очередей (класс или
словарь с частью queue в имени) дают очереди без направления, член реестра в вызове клиента
раскрывается в строку, декоратор вида @assign_queue("q") — потребитель (pyregistry.py).
"""

from __future__ import annotations

import ast
import re

from archmap_scan import codebase, codetext, pyast, pycode, pyregistry, texts
from archmap_scan.codetext import SP, STR
from archmap_scan.context import Context
from archmap_scan.links import hosts_in
from archmap_scan.model import ChannelUse, Findings, Hint, Loc
from archmap_scan.walk import Files

NAME = "rabbitmq"
CLIENT = "RabbitMQ"
PY_WANTED = frozenset({"pika", "aio-pika"})
JS_WANTED = frozenset({"amqplib", "amqp-connection-manager"})
_PY_MODULES = ("pika", "aio_pika")
PY_SPEC = pyregistry.Spec(NAME, CLIENT, "queue", frozenset({"queue", "queues"}), decorators=True)
_JS_ONE = re.compile(
    rf"\.[ \t]*(assertQueue|assertExchange|sendToQueue|consume|checkQueue)[ \t]*\({SP}"
)
_JS_TWO = re.compile(rf"\.[ \t]*(publish|bindQueue)[ \t]*\({SP}")
_JS_CONNECT = re.compile(rf"\.[ \t]*connect[ \t]*\({SP}({STR})")
_STR = re.compile(STR)
_JS_KIND = {
    "assertQueue": ("queue", None), "checkQueue": ("queue", None),
    "assertExchange": ("exchange", None), "sendToQueue": ("queue", "publish"),
    "consume": ("queue", "consume"),
}


class _Uses:
    def __init__(
        self, rel: str, found: Findings, imps: dict[str, pycode.Imported] | None = None,
        regs: pyregistry.Registries | None = None,
    ) -> None:
        self.rel = rel
        self.found = found
        self.imps = imps or {}
        self.regs = regs
        self.items: list[ChannelUse] = []
        self.host: str | None = None

    def add(self, name: str, kind: str, direction: str | None, line: int) -> None:
        if name:
            self.items.append(ChannelUse(
                name=name, kind=kind, client=CLIENT, direction=direction,
                loc=Loc(self.rel, line), parser=NAME,
            ))

    def dynamic(self, name: str, line: int) -> None:
        self.found.hints.append(Hint("dynamic_names", {
            "kind": "channel", "name": name, "reason": texts.REASON_DYNAMIC_CHANNEL,
            "source": str(Loc(self.rel, line)),
        }))

    def address(self, value: str | None, plain_host: bool = False) -> None:
        if not value or self.host is not None:
            return
        hosts = hosts_in("AMQP_HOST" if plain_host else "AMQP_URL", value)
        if hosts:
            self.host = hosts[0][0]

    def done(self) -> None:
        for use in self.items:
            use.broker_host = self.host
        self.found.channels.extend(self.items)


# Python

def _py_name(uses: _Uses, node: ast.AST | None, at: ast.AST) -> str | None:
    if node is None:
        return None
    value = pycode.string(node)
    if value is None and uses.regs is not None:
        value = uses.regs.value(uses.rel, uses.imps, node)
    if value is None:
        uses.dynamic(pycode.short(node), getattr(at, "lineno", 1))
    return value


def _py_publish(uses: _Uses, call: ast.Call, exchange: ast.AST | None) -> None:
    line = call.lineno
    key = pycode.kwarg(call, "routing_key")
    if exchange is not None:
        name = _py_name(uses, exchange, call)
        if name:
            uses.add(name, "exchange", "publish", line)
            return
        if name is None:
            return
    queue = _py_name(uses, key, call)
    if queue:
        uses.add(queue, "queue", "publish", line)


def _python(rel: str, tree: ast.Module, found: Findings, regs: pyregistry.Registries) -> None:
    imps = pycode.imports(tree)
    if not pycode.imports_any(imps, _PY_MODULES):
        return
    uses = _Uses(rel, found, imps, regs)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        last = pyast.last_name(node)
        line = node.lineno
        if last == "URLParameters" or last in ("connect", "connect_robust"):
            uses.address(pycode.string(pycode.arg(node, 0, "url")))
        elif last == "ConnectionParameters":
            uses.address(pycode.string(pycode.arg(node, 0, "host")), plain_host=True)
        elif last in ("queue_declare", "declare_queue"):
            key = "queue" if last == "queue_declare" else "name"
            name = _py_name(uses, pycode.arg(node, 0, key), node)
            if name:
                uses.add(name, "queue", None, line)
        elif last in ("exchange_declare", "declare_exchange"):
            key = "exchange" if last == "exchange_declare" else "name"
            name = _py_name(uses, pycode.arg(node, 0, key), node)
            if name:
                uses.add(name, "exchange", None, line)
        elif last == "queue_bind":
            for key, kind in (("queue", "queue"), ("exchange", "exchange")):
                name = _py_name(uses, pycode.kwarg(node, key), node)
                if name:
                    uses.add(name, kind, None, line)
        elif last == "basic_publish":
            _py_publish(uses, node, pycode.arg(node, 0, "exchange"))
        elif last == "publish" and "default_exchange" in (pycode.dotted(node.func) or ""):
            _py_publish(uses, node, None)
        elif last == "basic_consume":
            raw = pycode.kwarg(node, "queue")
            if raw is None and node.args and pycode.string(node.args[0]) is not None:
                raw = node.args[0]  # pika 1.x: basic_consume(queue, on_message_callback)
            name = _py_name(uses, raw, node)
            if name:
                uses.add(name, "queue", "consume", line)
    uses.done()


# JavaScript

def _js_arg(code: codetext.Code, uses: _Uses, pos: int) -> tuple[str | None, int]:
    """Строка в позиции pos и позиция после неё; не строка — подсказка, None."""
    hit = _STR.match(code.mask, pos)
    if hit is None:
        if pos < len(code.mask) and (code.mask[pos].isalpha() or code.mask[pos] in "_$"):
            uses.dynamic(code.expression(pos), code.line(pos))
        return None, pos
    value, dynamic = code.literal(hit.start(), hit.end())
    if dynamic:
        uses.dynamic(value, code.line(pos))
        return None, hit.end()
    return value, hit.end()


def _next_arg(mask: str, pos: int) -> int:
    while pos < len(mask) and mask[pos] in " \t\r\n":
        pos += 1
    if pos < len(mask) and mask[pos] == ",":
        pos += 1
    while pos < len(mask) and mask[pos] in " \t\r\n":
        pos += 1
    return pos


def _js(rel: str, code: codetext.Code, found: Findings) -> None:
    uses = _Uses(rel, found)
    mask = code.mask
    for m in _JS_CONNECT.finditer(mask):
        value, _dyn = code.literal(m.start(1), m.end(1))
        if value.startswith("amqp"):
            uses.address(value)
    for m in _JS_ONE.finditer(mask):
        kind, direction = _JS_KIND[m.group(1)]
        name, _end = _js_arg(code, uses, m.end())
        if name:
            uses.add(name, kind, direction, code.line(m.start()))
    for m in _JS_TWO.finditer(mask):
        first, end = _js_arg(code, uses, m.end())
        if first is None:
            continue
        second, _end = _js_arg(code, uses, _next_arg(mask, end))
        line = code.line(m.start())
        if m.group(1) == "bindQueue":
            uses.add(first, "queue", None, line)
            if second:
                uses.add(second, "exchange", None, line)
        elif first:
            uses.add(first, "exchange", "publish", line)
        elif second:
            uses.add(second, "queue", "publish", line)  # обменник по умолчанию
    uses.done()


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    py = codebase.stack_present(files, ctx, codebase.PYTHON, PY_WANTED)
    js = codebase.stack_present(files, ctx, codebase.NODE, JS_WANTED)
    if not py and not js:
        return found
    found.applied.add(NAME)
    if py:
        regs = pyregistry.scan(files, ctx, PY_SPEC, PY_WANTED, _PY_MODULES, found)
        for rel, text in codebase.sources(files, ctx, codebase.PYTHON, PY_WANTED, _PY_MODULES):
            tree = pyast.parse(text)
            if tree is not None:
                _python(rel, tree, found, regs)
    if js:
        needles = ("Queue(", "Exchange(", "consume(", "publish(", "sendToQueue(")
        for rel, text in codebase.sources(files, ctx, codebase.NODE, JS_WANTED, needles):
            if not codetext.imports(text, JS_WANTED, codetext.JS):
                continue  # consume и publish есть у многих библиотек
            code = codetext.load(files, rel, text, codetext.JS)
            if code is not None:
                _js(rel, code, found)
    return found
