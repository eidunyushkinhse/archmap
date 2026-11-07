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
hints.dynamic_names. Python: реестры топиков (class Topic(Enum), словарь KAFKA_TOPICS, модуль
констант topics.py) дают топики без направления, а Topic.X и голое имя константы в вызове
клиента раскрываются в строку (pyregistry.py). kafkajs: модуль констант с последним словом
имени файла topics (kafka-topics.ts) в пакете с kafkajs, export const ИМЯ = 'строка' или
`шаблон` (подстановки ${…} отбрасываются), даёт топики без направления, а «import { ИМЯ }
from '…/kafka-topics'» в файле с kafkajs раскрывает topic: ИМЯ и topics: [ИМЯ] (ТЗ §15 п. 13
В1).
"""

from __future__ import annotations

import ast
import re
from collections.abc import Callable

from archmap_scan import codebase, codetext, paths, pyast, pycode, pyregistry, texts
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
# Модуль констант топиков kafkajs: export const ИМЯ = литерал; импорт имён из модуля.
_JS_CONST = re.compile(
    rf"\bexport[ \t]+const[ \t]+([A-Z][A-Z0-9_]{{0,199}})[ \t]*(?::[^=\n]{{0,100}})?={SP}({STR})"
)
_JS_IMPORT = re.compile(rf"\bimport[ \t]+(?:type[ \t]+)?\{{([^{{}}]{{0,5000}})\}}{SP}from{SP}({STR})")
_JS_IDENT = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]{0,199}")
_JS_TEMPLATE = re.compile(r"\$\{[^}]{0,500}\}")
_JS_EXTS = (".ts", ".mts", ".cts", ".js", ".mjs", ".cjs")
# Модуль констант файла → ИМЯ → (топик, строка).
_JsConsts = dict[str, dict[str, tuple[str, int]]]


def _hint(
    found: Findings, name: str, rel: str, line: int, reason: str = texts.REASON_DYNAMIC_CHANNEL,
) -> None:
    found.hints.append(Hint("dynamic_names", {
        "kind": "channel", "name": name, "reason": reason, "source": str(Loc(rel, line)),
    }))


def _use(name: str, direction: str | None, rel: str, line: int) -> ChannelUse:
    return ChannelUse(name=name, kind="topic", client=CLIENT, direction=direction,
                      loc=Loc(rel, line), parser=NAME)


# Python

class _Py:
    """Файл Python с клиентом Kafka: импорты и реестры для раскрытия Topic.X. only_registry —
    файл клиента не подключает, а берёт имена из реестра топиков и зовёт обёртку проекта
    (posthog/api/metalytics.py: producer.produce(topic=KAFKA_APP_METRICS2)): тогда в счёт
    идут только аргументы-члены реестра, прочие вызовы send и produce не про Kafka."""

    def __init__(self, rel: str, tree: ast.Module, regs: pyregistry.Registries) -> None:
        self.rel = rel
        self.tree = tree
        self.imps = pycode.imports(tree)
        self.regs = regs
        self.only_registry = False


def _py_topics(node: ast.AST | None, at: ast.AST, py: _Py, found: Findings,
               direction: str | None, uses: list[ChannelUse]) -> None:
    if node is None:
        return
    rel = py.rel
    if py.only_registry:
        member = py.regs.value(rel, py.imps, node)
        if member:
            uses.append(_use(member, direction, rel, getattr(at, "lineno", 1)))
        return
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
        if not py.regs.imports_registry(py.rel, py.imps):
            return
        py.only_registry = True
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


def _ident_at(mask: str, pos: int) -> tuple[str, int] | None:
    """Голое имя в позиции pos и позиция после него; имя с продолжением (config.topic,
    topic(), topics[0]) голым не считается."""
    hit = _JS_IDENT.match(mask, pos)
    if hit is None:
        return None
    end = hit.end()
    nxt = end
    while nxt < len(mask) and mask[nxt] in " \t":
        nxt += 1
    if nxt < len(mask) and mask[nxt] in ".([":
        return None
    return hit.group(), end


def _strings_at(
    code: codetext.Code, pos: int, many: bool,
    resolve: Callable[[str], str | None] | None = None,
) -> tuple[list[str], str | None]:
    """Строки с позиции pos: одна или список через запятую. Второе — причина подсказки,
    если встретилось не строковое имя (или литерал в склейке), иначе None. resolve —
    раскрытие голого имени константы из модуля топиков (kafkajs)."""
    out: list[str] = []
    mask = code.mask
    while True:
        while pos < len(mask) and mask[pos] in " \t\r\n,":
            pos += 1
        hit = _STR.match(mask, pos)
        if hit is None:
            ident = _ident_at(mask, pos) if resolve is not None else None
            value = resolve(ident[0]) if ident is not None and resolve is not None else None
            if ident is not None and value is not None:
                out.append(value)
                pos = ident[1]
                if not many:
                    return out, None
                continue
            # Имя переменной вместо строки — динамическое; скобка — вложенная структура.
            dynamic = pos < len(mask) and (mask[pos].isalpha() or mask[pos] in "_$")
            return out, texts.REASON_DYNAMIC_CHANNEL if dynamic else None
        value, dynamic = code.literal(hit.start(), hit.end())
        if dynamic:
            return out, code.reason(hit.start(), hit.end(), texts.REASON_DYNAMIC_CHANNEL)
        out.append(value)
        pos = hit.end()
        if not many:
            return out, None


def _js_constants(files: Files, ctx: Context, found: Findings) -> _JsConsts:
    """Модули констант топиков в пакетах с kafkajs: файл с последним словом имени topics,
    export const ИМЯ = литерал. Константы — топики без направления; шаблон без литералов —
    подсказка о динамическом имени."""
    out: _JsConsts = {}
    for rel, text in codebase.sources(files, ctx, codebase.NODE, JS_WANTED, ("export",)):
        if not pyregistry.constants_module(rel, "topic"):
            continue
        code = codetext.load(files, rel, text, codetext.JS)
        if code is None:
            continue
        own: dict[str, tuple[str, int]] = {}
        for m in _JS_CONST.finditer(code.mask):
            value = code.text[m.start(2) + 1:m.end(2) - 1]
            if code.text[m.start(2)] == "`":
                value = _JS_TEMPLATE.sub("", value)
            line = code.line(m.start())
            if any(ch.isspace() for ch in value) or code.joined(m.start(2), m.end(2)):
                continue
            if not any(ch.isalnum() for ch in value):
                _hint(found, m.group(1), rel, line)
                continue
            own.setdefault(m.group(1), (value, line))
            found.channels.append(_use(value, None, rel, line))
        if own:
            out[rel] = own
    return out


def _js_module(spec: str, rel: str, consts: _JsConsts) -> str | None:
    """Модуль констант по спецификатору импорта: относительный путь от файла, иначе
    единственный модуль констант с тем же именем файла (псевдонимы путей вида ~/… и @/…)."""
    if spec.startswith("."):
        base = paths.join(paths.parent(rel), spec)
        if base is not None:
            for cand in (base, *(base + ext for ext in _JS_EXTS)):
                if cand in consts:
                    return cand
    stem = spec.rstrip("/").rsplit("/", 1)[-1]
    same = [m for m in consts if paths.name(m).rsplit(".", 1)[0] == stem.rsplit(".", 1)[0]]
    return same[0] if len(same) == 1 else None


def _js_resolver(rel: str, code: codetext.Code, consts: _JsConsts) -> Callable[[str], str | None]:
    """Голое имя → топик: «import { ИМЯ [as Другое] } from '…'» из модуля констант или
    константа самого файла, если он модуль констант."""
    local: dict[str, str] = {name: v for name, (v, _line) in consts.get(rel, {}).items()}
    for m in _JS_IMPORT.finditer(code.mask):
        spec = code.text[m.start(2) + 1:m.end(2) - 1]
        module = _js_module(spec, rel, consts)
        if module is None:
            continue
        for item in m.group(1).split(","):
            parts = item.split()
            if parts and parts[0] == "type":
                parts = parts[1:]
            if len(parts) == 1:
                name, alias = parts[0], parts[0]
            elif len(parts) == 3 and parts[1] == "as":
                name, alias = parts[0], parts[2]
            else:
                continue
            if name in consts[module]:
                local[alias] = consts[module][name][0]
    return local.get


def _js(rel: str, code: codetext.Code, found: Findings, consts: _JsConsts | None = None) -> None:
    mask = code.mask
    resolve = _js_resolver(rel, code, consts) if consts else None
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
            names, why = _strings_at(code, t.end(), bool(t.group(1)), resolve)
            line = code.line(t.start())
            uses.extend(_use(n, direction, rel, line) for n in names if n)
            if why:
                _hint(found, code.expression(t.end()), rel, line, why)
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
            names, why = _strings_at(code, m.end(), False)
            direction = _go_direction(mask, m.start())
        else:
            start = _go_list(code, m.end())
            if start is None:
                continue
            names, why = _strings_at(code, start, True)
            direction = "consume"
        uses.extend(_use(n, direction, rel, line) for n in names if n)
        if why:
            _hint(found, code.expression(m.end()), rel, line, why)
    for m in _GO_CALL.finditer(mask):
        line = code.line(m.start())
        if m.group(1) == "ConsumePartition":
            names, why = _strings_at(code, m.end(), False)
        else:
            # Consume(ctx, []string{…}) и SubscribeTopics([]string{…}, nil)
            window_end = min(len(mask), m.end() + 300)
            at = mask.find("[]", m.end(), window_end)
            start = _go_list(code, at) if at != -1 else None
            if start is None:
                continue
            names, why = _strings_at(code, start, True)
        uses.extend(_use(n, "consume", rel, line) for n in names if n)
        if why:
            _hint(found, code.expression(m.end()), rel, line, why)
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
        consts = _js_constants(files, ctx, found) if lang == codebase.NODE else {}
        for rel, text in codebase.sources(files, ctx, lang, wanted, needles):
            if not codetext.imports(text, wanted, kind):
                continue
            code = codetext.load(files, rel, text, kind)
            if code is None:
                continue
            if lang == codebase.NODE:
                _js(rel, code, found, consts)
            else:
                _go(rel, code, found)
    return found
