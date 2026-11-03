"""Топики Kafka в коде (ТЗ §6.2).

Файл подключает клиент Kafka. Python (kafka-python, confluent-kafka, aiokafka):
KafkaConsumer("t", …) и AIOKafkaConsumer, consumer.subscribe(["t"]) — потребление;
producer.send("t", …), send_and_wait, produce("t") — публикация; NewTopic("t") —
объявление. kafkajs: producer.send({ topic: 't' }), sendBatch, consumer.subscribe({ topic
или topics }), admin.createTopics. Go (sarama, segmentio/kafka-go, confluent-kafka-go):
Topic: "t" в ProducerMessage, Writer, Message (публикация) и ReaderConfig (потребление),
GroupTopics и Topics, ConsumePartition("t"), Consume(ctx, []string{…}),
SubscribeTopics([]string{…}). Адрес брокера литералом в том же файле (bootstrap_servers,
brokers, Brokers) помогает найти брокер-владелец. Имя топика не строкой — в
hints.dynamic_names. Python: реестры топиков (class Topic(Enum), словарь KAFKA_TOPICS) дают
топики без направления, а Topic.X в вызове клиента раскрывается в строку (pyregistry.py).
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

NAME = "kafka"
CLIENT = "Kafka"
PY_WANTED = frozenset({"kafka-python", "confluent-kafka", "aiokafka"})
JS_WANTED = frozenset({"kafkajs"})
GO_WANTED = frozenset({
    "github.com/ibm/sarama", "github.com/shopify/sarama", "github.com/segmentio/kafka-go",
    "github.com/confluentinc/confluent-kafka-go",
})
_PY_MODULES = ("kafka", "confluent_kafka", "aiokafka")
_PY_CONSUMERS = frozenset({"KafkaConsumer", "AIOKafkaConsumer"})
_PY_PUBLISH = frozenset({"send", "send_and_wait", "produce"})
PY_SPEC = pyregistry.Spec(NAME, CLIENT, "topic", frozenset({"topic", "topics"}))

_JS_CALL = re.compile(rf"\.[ \t]*(send|sendBatch|subscribe|createTopics)[ \t]*\({SP}\{{")
_JS_TOPIC = re.compile(rf"topics?[ \t]*:{SP}(\[?)")
_JS_BROKERS = re.compile(rf"brokers[ \t]*:{SP}\[{SP}({STR})")
_STR = re.compile(STR)
_GO_TOPIC = re.compile(rf"(Topic|GroupTopics|Topics)[ \t]*:{SP}")
_GO_CALL = re.compile(rf"\.[ \t]*(ConsumePartition|Consume|SubscribeTopics)[ \t]*\({SP}")
_GO_BROKERS = re.compile(rf"Brokers[ \t]*:{SP}\[\][ \t]*string[ \t]*\{{{SP}({STR})")
_GO_LIST = re.compile(rf"\[\][ \t]*string[ \t]*\{{{SP}")
_GO_PUBLISH = ("ProducerMessage", "WriterConfig", "Writer", "Message")
_GO_CONSUME = ("ReaderConfig", "Reader")
_JS_DIRECTION = {"send": "publish", "sendBatch": "publish", "subscribe": "consume",
                 "createTopics": None}
_MAX_BLOCK = 2000


def _hint(found: Findings, name: str, rel: str, line: int) -> None:
    found.hints.append(Hint("dynamic_names", {
        "kind": "channel", "name": name, "reason": texts.REASON_DYNAMIC_CHANNEL,
        "source": str(Loc(rel, line)),
    }))


def _use(name: str, direction: str | None, rel: str, line: int) -> ChannelUse:
    return ChannelUse(name=name, kind="topic", client=CLIENT, direction=direction,
                      loc=Loc(rel, line), parser=NAME)


# Python

class _Py:
    """Файл Python с клиентом Kafka: импорты и реестры для раскрытия Topic.X."""

    def __init__(self, rel: str, tree: ast.Module, regs: pyregistry.Registries) -> None:
        self.rel = rel
        self.tree = tree
        self.imps = pycode.imports(tree)
        self.regs = regs


def _py_topics(node: ast.AST | None, at: ast.AST, py: _Py, found: Findings,
               direction: str | None, uses: list[ChannelUse]) -> None:
    if node is None:
        return
    rel = py.rel
    names = py.regs.strings(rel, py.imps, node)
    if names is None:
        _hint(found, pycode.short(node), rel, getattr(at, "lineno", 1))
        return
    uses.extend(_use(n, direction, rel, getattr(at, "lineno", 1)) for n in names if n)


def _py_host(call: ast.Call) -> str | None:
    value = pycode.string(pycode.kwarg(call, "bootstrap_servers"))
    if value is None:
        for arg in call.args:
            if isinstance(arg, ast.Dict):
                for key, item in zip(arg.keys, arg.values, strict=False):
                    if pycode.string(key) == "bootstrap.servers":
                        value = pycode.string(item)
    hosts = hosts_in("KAFKA_BOOTSTRAP_SERVERS", value) if value else []
    return hosts[0][0] if hosts else None


def _python(py: _Py, found: Findings) -> None:
    if not pycode.imports_any(py.imps, _PY_MODULES):
        return
    uses: list[ChannelUse] = []
    host: str | None = None
    for node in ast.walk(py.tree):
        if not isinstance(node, ast.Call):
            continue
        host = host or _py_host(node)
        last = pyast.last_name(node)
        if last in _PY_CONSUMERS:
            for arg in node.args:
                if not isinstance(arg, ast.Starred):
                    _py_topics(arg, node, py, found, "consume", uses)
        elif not isinstance(node.func, ast.Attribute):
            if last == "NewTopic":
                _py_topics(pycode.arg(node, 0, "name"), node, py, found, None, uses)
        elif last == "subscribe":
            _py_topics(pycode.arg(node, 0, "topics"), node, py, found, "consume", uses)
        elif last in _PY_PUBLISH:
            _py_topics(pycode.arg(node, 0, "topic"), node, py, found, "publish", uses)
    for use in uses:
        use.broker_host = host
    found.channels.extend(uses)


# JavaScript и Go

def _word_char(mask: str, pos: int) -> bool:
    return pos >= 0 and (mask[pos].isalnum() or mask[pos] in "_$")


def _block_end(mask: str, start: int) -> int:
    """Позиция парной «}» к «{» перед start (не дальше _MAX_BLOCK)."""
    depth = 1
    stop = min(len(mask), start + _MAX_BLOCK)
    for i in range(start, stop):
        if mask[i] == "{":
            depth += 1
        elif mask[i] == "}":
            depth -= 1
            if depth == 0:
                return i
    return stop


def _strings_at(code: codetext.Code, pos: int, many: bool) -> tuple[list[str], bool]:
    """Строки с позиции pos: одна или список через запятую. Второе — встретилось
    не строковое имя."""
    out: list[str] = []
    mask = code.mask
    while True:
        while pos < len(mask) and mask[pos] in " \t\r\n,":
            pos += 1
        hit = _STR.match(mask, pos)
        if hit is None:
            # Имя переменной вместо строки — динамическое; скобка — вложенная структура.
            return out, pos < len(mask) and (mask[pos].isalpha() or mask[pos] in "_$")
        value, dynamic = code.literal(hit.start(), hit.end())
        if dynamic:
            return out, True
        out.append(value)
        pos = hit.end()
        if not many:
            return out, False


def _js(rel: str, code: codetext.Code, found: Findings) -> None:
    mask = code.mask
    uses: list[ChannelUse] = []
    host = None
    hit = _JS_BROKERS.search(mask)
    if hit is not None:
        value, _dyn = code.literal(hit.start(1), hit.end(1))
        hosts = hosts_in("KAFKA_BROKERS", value)
        host = hosts[0][0] if hosts else None
    for m in _JS_CALL.finditer(mask):
        direction = _JS_DIRECTION[m.group(1)]
        end = _block_end(mask, m.end())
        for t in _JS_TOPIC.finditer(mask, m.end(), end):
            if _word_char(mask, t.start() - 1):
                continue  # subtopic: — не ключ topic
            names, dynamic = _strings_at(code, t.end(), bool(t.group(1)))
            line = code.line(t.start())
            uses.extend(_use(n, direction, rel, line) for n in names if n)
            if dynamic:
                _hint(found, code.expression(t.end()), rel, line)
    for use in uses:
        use.broker_host = host
    found.channels.extend(uses)


def _go_direction(mask: str, pos: int) -> str | None:
    window = mask[max(0, pos - 300):pos]
    best: tuple[int, str | None] = (-1, None)
    for words, direction in ((_GO_PUBLISH, "publish"), (_GO_CONSUME, "consume")):
        for word in words:
            at = window.rfind(word + "{")
            if at > best[0]:
                best = (at, direction)
    return best[1]


def _go_list(code: codetext.Code, pos: int) -> int | None:
    """Позиция после «[]string{», если список начинается в pos."""
    m = _GO_LIST.match(code.mask, pos)
    return m.end() if m else None


def _go(rel: str, code: codetext.Code, found: Findings) -> None:
    mask = code.mask
    uses: list[ChannelUse] = []
    host = None
    hit = _GO_BROKERS.search(mask)
    if hit is not None:
        value, _dyn = code.literal(hit.start(1), hit.end(1))
        hosts = hosts_in("KAFKA_BROKERS", value)
        host = hosts[0][0] if hosts else None
    for m in _GO_TOPIC.finditer(mask):
        if _word_char(mask, m.start() - 1):
            continue  # SomeTopic: — не ключ Topic
        line = code.line(m.start())
        if m.group(1) == "Topic":
            names, dynamic = _strings_at(code, m.end(), False)
            direction = _go_direction(mask, m.start())
        else:
            start = _go_list(code, m.end())
            if start is None:
                continue
            names, dynamic = _strings_at(code, start, True)
            direction = "consume"
        uses.extend(_use(n, direction, rel, line) for n in names if n)
        if dynamic:
            _hint(found, code.expression(m.end()), rel, line)
    for m in _GO_CALL.finditer(mask):
        line = code.line(m.start())
        if m.group(1) == "ConsumePartition":
            names, dynamic = _strings_at(code, m.end(), False)
        else:
            # Consume(ctx, []string{…}) и SubscribeTopics([]string{…}, nil)
            window_end = min(len(mask), m.end() + 300)
            at = mask.find("[]", m.end(), window_end)
            start = _go_list(code, at) if at != -1 else None
            if start is None:
                continue
            names, dynamic = _strings_at(code, start, True)
        uses.extend(_use(n, "consume", rel, line) for n in names if n)
        if dynamic:
            _hint(found, code.expression(m.end()), rel, line)
    for use in uses:
        use.broker_host = host
    found.channels.extend(uses)


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    stacks = [
        (lang, wanted) for lang, wanted in
        ((codebase.PYTHON, PY_WANTED), (codebase.NODE, JS_WANTED), (codebase.GO, GO_WANTED))
        if codebase.stack_present(files, ctx, lang, wanted)
    ]
    if not stacks:
        return found
    found.applied.add(NAME)
    for lang, wanted in stacks:
        if lang == codebase.PYTHON:
            regs = pyregistry.scan(files, ctx, PY_SPEC, wanted, _PY_MODULES, found)
            for rel, text in codebase.sources(files, ctx, lang, wanted, _PY_MODULES):
                tree = pyast.parse(text)
                if tree is not None:
                    _python(_Py(rel, tree, regs), found)
            continue
        needles = ("topic",) if lang == codebase.NODE else ("Topic", "Consume")
        kind = codetext.JS if lang == codebase.NODE else codetext.GO
        for rel, text in codebase.sources(files, ctx, lang, wanted, needles):
            if not codetext.imports(text, wanted, kind):
                continue
            code = codetext.load(files, rel, text, kind)
            if code is not None:
                (_js if lang == codebase.NODE else _go)(rel, code, found)
    return found
