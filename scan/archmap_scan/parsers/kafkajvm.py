"""Топики Kafka в коде Java и Kotlin (ТЗ §15 п. 17 В1).

Пакет Java или Kotlin с kafka-clients или spring-kafka. Потребление: subscribe(…) со списком
List.of, Arrays.asList, Collections.singletonList, Set.of, Kotlin listOf, setOf,
mutableListOf (с получателем «consumer.» и без, как в блоке apply Kotlin) и @KafkaListener(topics
= "t") (массив {"a", "b"}, Kotlin ["a"], arrayOf); публикация: new ProducerRecord<>("t", …),
Kotlin ProducerRecord("t", …) и <получатель>Template.send("t", …). Имя топика литералом,
строковой константой (clike.Repo, Java) или переменной файла, значение которой задано
System.getenv("X") ?: "t" (Kotlin) или Optional.ofNullable(System.getenv("X")).orElse("t")
(Java): дефолт как имя (по образцу get_from_env(…, default="t") части 2). Иначе подсказка о
динамическом имени. Брокер находит сборка по клиенту Kafka (codefacts._broker).
"""

from __future__ import annotations

import re

from archmap_scan import clike, codetext, jvm, texts
from archmap_scan.codetext import SP
from archmap_scan.context import Context
from archmap_scan.model import ChannelUse, Findings, Hint, Loc
from archmap_scan.walk import Files

NAME = "kafka-jvm"
CLIENT = "Kafka"
STACK = ("kafka-clients", "spring-kafka")
_NEEDLES = ("subscribe", "ProducerRecord", "KafkaListener", "emplate.send")
_ID = r"[A-Za-z_$][A-Za-z0-9_$]{0,99}"
_SUBSCRIBE = re.compile(rf"(?<![\w$])subscribe{SP}\(")
_LIST = re.compile(
    rf"{SP}(?:List{SP}\.{SP}of|Set{SP}\.{SP}of|Arrays{SP}\.{SP}asList|"
    rf"Collections{SP}\.{SP}singletonList|listOf|setOf|mutableListOf|mutableSetOf|arrayListOf)"
    rf"{SP}(?:<[^<>()]{{0,200}}>)?{SP}\("
)
_RECORD = re.compile(rf"(?<![\w$.])ProducerRecord{SP}(?:<[^()]{{0,200}}>)?{SP}\(")
_TEMPLATE_SEND = re.compile(rf"(?<![\w$])\w{{0,100}}[Tt]emplate{SP}\.{SP}send(?:Default)?{SP}\(")
_LISTENER = frozenset({"KafkaListener"})
_TOPIC_LABELS = frozenset({"topics"})
# Переменная файла с дефолтом окружения: Kotlin «val t: String = System.getenv("X") ?: "d"»,
# Java «String t = Optional.ofNullable(System.getenv("X")).orElse("d")».
_KT_VAR = re.compile(
    rf"(?<![\w$])(?:val|var)[ \t]+({_ID})(?:[ \t]*:[ \t]*String\??)?[ \t]*={SP}System{SP}\.{SP}"
    rf'getenv{SP}\({SP}"[ ]*"{SP}\){SP}\?:{SP}("[ ]*")'
)
_JAVA_VAR = re.compile(
    rf"(?<![\w$])String[ \t]+({_ID})[ \t]*={SP}(?:java{SP}\.{SP}util{SP}\.{SP})?Optional{SP}\.{SP}"
    rf'ofNullable{SP}\({SP}System{SP}\.{SP}getenv{SP}\({SP}"[ ]*"{SP}\){SP}\){SP}\.{SP}orElse{SP}'
    rf'\({SP}("[ ]*"){SP}\)'
)
_IDENT = re.compile(_ID)
# Начало значения в подсказке и в проверке обработчика subscribe.
_HINT_CHARS = 200


def _hint(found: Findings, name: str, rel: str, line: int) -> None:
    found.hints.append(Hint("dynamic_names", {
        "kind": "channel", "name": name[:80], "reason": texts.REASON_DYNAMIC_CHANNEL,
        "source": str(Loc(rel, line)),
    }))


class _File:
    def __init__(
        self, rel: str, code: codetext.Code, outline: jvm.Outline, repo: clike.Repo | None,
        found: Findings,
    ) -> None:
        self.rel = rel
        self.code = code
        self.outline = outline
        self.repo = repo
        self.found = found
        self.count = 0
        self.variables = _variables(code)

    def _counted(self) -> None:
        # Записи и подсказки файла вместе: больше clike.MAX_READS — файл непрочитан.
        self.count += 1
        if self.count > clike.MAX_READS:
            raise jvm.TooMany

    def hint(self, lo: int, hi: int, at: int) -> None:
        """Подсказка о динамическом имени по тексту значения [lo, hi) (начало значения:
        выражение в мегабайт в подсказку не копируется)."""
        self._counted()
        _hint(self.found, self.code.text[lo:min(hi, lo + _HINT_CHARS)].strip(), self.rel,
              self.code.line(at))

    def add(self, name: str, direction: str, at: int) -> None:
        self._counted()
        self.found.channels.append(ChannelUse(
            name=name, kind="topic", client=CLIENT, direction=direction,
            loc=Loc(self.rel, self.code.line(at)), parser=NAME,
        ))

    def topic(self, lo: int, hi: int, direction: str, at: int) -> None:
        """Топик значения [lo, hi): литерал, константа или переменная файла; иначе подсказка."""
        value = jvm.string_value(self.code, self.repo, self.rel, lo, hi)
        if value is None and _IDENT.fullmatch(self.code.mask, lo, hi):
            value = self.variables.get(self.code.mask[lo:hi])
        if not value:
            self.hint(lo, hi, at)
            return
        self.add(value, direction, at)


def _variables(code: codetext.Code) -> dict[str, str | None]:
    """Переменные файла с дефолтом окружения: имя → дефолт (None — имя объявлено с разными
    дефолтами, неоднозначно)."""
    out: dict[str, str | None] = {}
    pattern = _KT_VAR if code.lang == codetext.KOTLIN else _JAVA_VAR
    for m in pattern.finditer(code.mask):
        value, dynamic = jvm.literal(code, *m.span(2))
        got = None if dynamic else value
        name = m.group(1)
        out[name] = got if name not in out or out[name] == got else None
    return out


def _topics_expression(mask: str, lo: int, hi: int) -> bool:
    """Аргумент subscribe [lo, hi) может быть списком топиков или шаблоном (переменная,
    вызов), а не обработчиком реактивного потока Reactor или RxJava: лямбда «->», ссылка на
    метод «::» и блок Kotlin «{» подсказки о динамическом имени не дают. Смотрится начало
    аргумента: стрелка лямбды и ссылка на метод стоят в нём."""
    head = mask[lo:min(hi, lo + _HINT_CHARS)]
    return not head.startswith("{") and "->" not in head and "::" not in head


def _args(f: _File, paren: int) -> list[jvm.Arg] | None:
    """Аргументы вызова со скобкой на paren; скобка без пары (код оборван) — None: такой вызов
    не читается вовсе, ни записью, ни подсказкой."""
    if paren not in f.outline.pairs:
        return None
    return jvm.args(f.outline, paren, clike.MAX_READS)


def _subscriptions(f: _File) -> None:
    mask = f.code.mask
    for m in _SUBSCRIBE.finditer(mask):
        lst = _LIST.match(mask, m.end())
        if lst is None:
            args = _args(f, m.end() - 1)
            if not args:
                continue
            first = args[0]
            if len(args) == 1 and first.label is None and mask[first.start] == '"':
                f.topic(first.start, first.end, "consume", m.start())
            elif _topics_expression(mask, first.start, first.end):
                f.hint(first.start, first.end, m.start())
            continue
        for arg in _args(f, lst.end() - 1) or []:
            if arg.label is None:
                f.topic(arg.start, arg.end, "consume", m.start())


def _records(f: _File) -> None:
    mask = f.code.mask
    for pattern in (_RECORD, _TEMPLATE_SEND):
        for m in pattern.finditer(mask):
            args = _args(f, m.end() - 1)
            if args and args[0].label is None:
                f.topic(args[0].start, args[0].end, "publish", m.start())


def _listeners(f: _File) -> None:
    for ann in jvm.find_annotations(f.outline, _LISTENER):
        if ann.args < 0:
            continue
        for arg in jvm.args(f.outline, ann.args):
            if arg.label in _TOPIC_LABELS:
                for lo, hi in jvm.items(f.outline, arg):
                    f.topic(lo, hi, "consume", ann.at)


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not jvm.stack_present(files, ctx, STACK):
        return found
    found.applied.add(NAME)
    repos = jvm.Repos(files, ctx)
    for rel, code, language in jvm.sources(files, ctx, STACK, _NEEDLES):
        repo = repos.note(rel, code, language)
        part = Findings()
        try:
            outline = jvm.Outline.of(code)
            f = _File(rel, code, outline, repo, part)
            _subscriptions(f)
            _records(f)
            _listeners(f)
        except jvm.TooMany:
            files.refuse(rel)
            continue
        found.channels.extend(part.channels)
        found.hints.extend(part.hints)
    return found
