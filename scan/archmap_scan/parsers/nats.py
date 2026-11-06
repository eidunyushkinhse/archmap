"""Темы NATS в коде (ТЗ §6.2): subscribe("s") и QueueSubscribe — потребление,
publish("s") и Request — публикация. Файл подключает клиент: Python (nats-py, import
nats), Node (nats), Go (nats.go). Адрес брокера литералом в том же файле (connect("nats://…"))
помогает найти брокер-владелец. Имя не строкой — в hints.dynamic_names. Python: реестры тем
(часть subject в имени) дают темы без направления, член реестра в вызове раскрывается
(pyregistry.py)."""

from __future__ import annotations

import ast
import re

from archmap_scan import codebase, codetext, pyast, pycode, pyregistry, texts
from archmap_scan.codetext import SP, STR
from archmap_scan.context import Context
from archmap_scan.links import hosts_in
from archmap_scan.model import ChannelUse, Findings, Hint, Loc
from archmap_scan.walk import Files

NAME = "nats"
CLIENT = "NATS"
PY_WANTED = frozenset({"nats-py", "nats"})
JS_WANTED = frozenset({"nats", "nats.ws"})
GO_WANTED = frozenset({"github.com/nats-io/nats.go"})
_PY_DIRECTION = {"subscribe": "consume", "publish": "publish", "request": "publish"}
_JS_CALL = re.compile(rf"\.[ \t]*(subscribe|publish|request)[ \t]*\({SP}")
_GO_CALL = re.compile(
    rf"\.[ \t]*(Subscribe|QueueSubscribe|SubscribeSync|ChanSubscribe|QueueSubscribeSync"
    rf"|Publish|Request|PublishMsg)[ \t]*\({SP}"
)
_CONNECT = re.compile(rf"\.[ \t]*(?:connect|Connect)[ \t]*\({SP}({STR})")
_STR = re.compile(STR)
PY_SPEC = pyregistry.Spec(NAME, CLIENT, "subject", frozenset({"subject", "subjects"}))


def _use(name: str, direction: str, rel: str, line: int) -> ChannelUse:
    return ChannelUse(name=name, kind="subject", client=CLIENT, direction=direction,
                      loc=Loc(rel, line), parser=NAME)


def _hint(
    found: Findings, name: str, rel: str, line: int, reason: str = texts.REASON_DYNAMIC_CHANNEL,
) -> None:
    found.hints.append(Hint("dynamic_names", {
        "kind": "channel", "name": name, "reason": reason, "source": str(Loc(rel, line)),
    }))


def _host(value: str | None) -> str | None:
    hosts = hosts_in("NATS_URL", value) if value else []
    return hosts[0][0] if hosts else None


def _python(rel: str, tree: ast.Module, found: Findings, regs: pyregistry.Registries) -> None:
    imps = pycode.imports(tree)
    if not pycode.imports_any(imps, ("nats",)):
        return
    uses: list[ChannelUse] = []
    host: str | None = None
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        last = node.func.attr
        if last == "connect":
            raw = pycode.arg(node, 0, "servers")
            host = host or _host(pycode.string(raw) or next(iter(pycode.strings(raw) or []), None))
        elif last in _PY_DIRECTION:
            raw = pycode.arg(node, 0, "subject")
            if raw is None:
                continue
            name = regs.string(rel, imps, raw)
            if name is None:
                _hint(found, pycode.short(raw), rel, node.lineno)
            elif name:
                uses.append(_use(name, _PY_DIRECTION[last], rel, node.lineno))
    for use in uses:
        use.broker_host = host
    found.channels.extend(uses)


def _code(rel: str, code: codetext.Code, found: Findings, go: bool) -> None:
    uses: list[ChannelUse] = []
    host = None
    for m in _CONNECT.finditer(code.mask):
        value, _dyn = code.literal(m.start(1), m.end(1))
        host = host or _host(value)
    for m in (_GO_CALL if go else _JS_CALL).finditer(code.mask):
        verb = m.group(1).lower()
        direction = "consume" if "subscribe" in verb else "publish"
        hit = _STR.match(code.mask, m.end())
        line = code.line(m.start())
        if hit is None:
            ch = code.mask[m.end():m.end() + 1]
            if ch and (ch.isalpha() or ch in "_$"):
                _hint(found, code.expression(m.end()), rel, line)
            continue
        name, dynamic = code.literal(hit.start(), hit.end())
        if dynamic and code.joined(hit.start(), hit.end()):
            _hint(found, code.expression(hit.start()), rel, line, texts.REASON_JOINED_NAME)
        elif dynamic:
            _hint(found, name, rel, line)
        elif name:
            uses.append(_use(name, direction, rel, line))
    for use in uses:
        use.broker_host = host
    found.channels.extend(uses)


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    py = codebase.stack_present(files, ctx, codebase.PYTHON, PY_WANTED)
    js = codebase.stack_present(files, ctx, codebase.NODE, JS_WANTED)
    go = codebase.stack_present(files, ctx, codebase.GO, GO_WANTED)
    if not (py or js or go):
        return found
    found.applied.add(NAME)
    if py:
        regs = pyregistry.scan(files, ctx, PY_SPEC, PY_WANTED, ("nats",), found)
        for rel, text in codebase.sources(files, ctx, codebase.PYTHON, PY_WANTED, ("nats",)):
            tree = pyast.parse(text)
            if tree is not None:
                _python(rel, tree, found, regs)
    for present, lang, wanted, kind, needles in (
        (js, codebase.NODE, JS_WANTED, codetext.JS, ("subscribe(", "publish(", "request(")),
        (go, codebase.GO, GO_WANTED, codetext.GO, ("Subscribe", "Publish", "Request(")),
    ):
        if not present:
            continue
        for rel, text in codebase.sources(files, ctx, lang, wanted, needles):
            if not codetext.imports(text, wanted, kind):
                continue  # publish и subscribe есть у многих библиотек, не только у NATS
            code = codetext.load(files, rel, text, kind)
            if code is not None:
                _code(rel, code, found, lang == codebase.GO)
    return found
