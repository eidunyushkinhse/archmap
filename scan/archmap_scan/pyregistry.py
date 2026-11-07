"""Реестры каналов и декоратор потребителя в коде Python (ТЗ §13.2): одно правило для
разборщиков kafka, rabbitmq, celery и nats.

Зрелые кодовые базы не пишут имя канала строкой в вызове клиента, а держат имена в одном
месте (находка замера фазы 2): Sentry — перечисление class Topic(Enum) с
INGEST_EVENTS = "ingest-events" и словарь KAFKA_TOPIC_TO_CLUSTER, Zulip — декоратор
@assign_queue("deferred_work") у каждого потребителя. Поэтому:

- реестр — класс (в том числе Enum) или словарь на уровне модуля, у имени которого
  ПОСЛЕДНЕЕ слово (name_words: части по «_», «.», «-» и по регистру, CeleryQueue — celery и
  queue) называет вид брокера: topic и topics для Kafka, queue и queues для RabbitMQ и
  Celery, subject и subjects для NATS (ТЗ §15 п. 10 А11: DEAD_LETTER_QUEUE_METRICS и
  TRUNK_MERGE_QUEUE_COLUMNS PostHog — ключи метрик и колонки, а не очереди). Исключение —
  словарь «…_TOPIC_TO_…» (KAFKA_TOPIC_TO_CLUSTER Sentry): его ключи и есть каналы. Имя
  «…_TO_TOPICS» сопоставляет каналам что-то другое и реестром не считается. Строки реестра
  (у класса — значения членов, у словаря — ключи) без пробелов дают каналы этого вида без
  направления. Члены класса — константы в верхнем регистре, у перечисления — любые имена без
  «_» в начале: так строка __tablename__ = "topics" каналом не становится. Части channel и
  channels вида брокера не называют (Zulip держит CHANNEL_SYNONYMS со словами интерфейса),
  поэтому такой реестр читается только в файле, который сам подключает клиент брокера.
  Очереди SQS (имя реестра со словом sqs, модуль с boto3, botocore или sqs в импортах) не
  очереди Celery и RabbitMQ;
- аргумент вызова публикации или подписки вида Name.MEMBER, Name.MEMBER.value или
  Name["MEMBER"], где Name — реестр того же файла или импортированного модуля репозитория,
  раскрывается в строку (Registries.value): направление и связь как у строки;
- декоратор с первым строковым аргументом и частью queue в имени (@assign_queue("q"))
  означает потребителя очереди (RabbitMQ, иначе Celery); именованный аргумент с частью test
  и значением True (is_test_queue=True) означает тестовую очередь, запись пропускается;
- модуль-реестр констант (ТЗ §15 п. 13 В1: posthog/kafka_client/topics.py, 56 топиков):
  модуль, у имени файла которого последнее слово называет вид брокера во множественном
  числе (topics, queues, subjects: kafka_topics.py, celery_queues.py). Присваивания уровня
  модуля ИМЯ = строка | f-строка | get_from_env("…", строка) | os.environ.get("…", …) |
  os.getenv("…", …) с ИМЕНЕМ в верхнем регистре дают каналы без направления по литеральной
  части значения: подстановки {…} f-строки отбрасываются, куски склеиваются; пустая
  литеральная часть уходит в hints.dynamic_names. Единственное число не в счёт: queue.py и
  dead_letter_queue.py у PostHog держат имена таблиц и ключей Redis, а не очереди.
  Голое ИМЯ в вызове клиента, определённое так в том же файле или импортированное
  «from <модуль> import ИМЯ» из такого модуля, раскрывается в строку (Registries.value).

Только литералы и ast: код не выполняется и не импортируется (инвариант 1).
"""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass, field

from archmap_scan import codebase, paths, pyast, pycode, texts
from archmap_scan.context import Context
from archmap_scan.model import ChannelUse, Findings, Hint, Loc
from archmap_scan.walk import Files, name_tokens

# Части имени, которые называют вид канала, и части, которые его не называют.
_CHANNEL_WORDS = frozenset({"channel", "channels"})
_TEST_WORD = "test"
_MEMBER = re.compile(r"[A-Z][A-Z0-9_]{0,199}")
# Слова имени: заглавные подряд (не перед строчной), слово с заглавной или строчной, числа.
_NAME_WORD = re.compile(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+")
_SQS_WORD = "sqs"
# Реестр констант модуля хранится в индексе файла под этим ключом: он не имя Python, поэтому
# не совпадёт с классом или словарём.
_CONSTANTS = "*"
# Вид брокера → последнее слово имени файла модуля-реестра констант (множественное число).
_PLURAL = {"topic": "topics", "queue": "queues", "subject": "subjects"}
# Чтение окружения с дефолтом: get_from_env PostHog и стандартные.
_ENV_CALLS = frozenset({"os.getenv", "os.environ.get"})
_ENV_HELPER = "get_from_env"
_SQS_MODULES = ("boto3", "botocore", "aioboto3", "aiobotocore")
# Отбор файлов до разбора (только начала строк, без оглядки назад): класс и словарь на
# уровне модуля, декоратор с вызовом.
_CLASS = re.compile(r"^class[ \t]+([A-Za-z_][A-Za-z0-9_]{0,99})", re.MULTILINE)
_DICT = re.compile(
    r"^([A-Za-z_][A-Za-z0-9_]{0,99})[ \t]*(?::[^=\n]{0,200})?=[ \t]*\{", re.MULTILINE,
)
_DECORATOR = re.compile(r"^[ \t]*@([A-Za-z0-9_.]{1,200})[ \t]*\(", re.MULTILINE)


@dataclass(frozen=True)
class Spec:
    """Вид брокера для правила реестров: разборщик, клиент, вид канала, части имени."""

    parser: str
    client: str
    kind: str
    words: frozenset[str]
    decorators: bool = False  # декоратор потребителя очереди


@dataclass
class _Registry:
    name: str
    # Член → (строка канала, строка файла). У словаря член — сам ключ.
    members: dict[str, tuple[str, int]] = field(default_factory=dict)


class Registries:
    """Реестры одного вида брокера по файлам и раскрытие Name.MEMBER в строку."""

    def __init__(self, files: Files, spec: Spec) -> None:
        self.files = files
        self.spec = spec
        self.by_file: dict[str, dict[str, _Registry]] = {}

    def _find(self, rel: str, imps: dict[str, pycode.Imported], ref: ast.AST) -> _Registry | None:
        name = pycode.dotted(ref)
        if name is None:
            return None
        own = self.by_file.get(rel, {})
        if "." not in name and name in own and name not in imps:
            return own[name]
        full = pycode.qualname(ref, imps)
        if full is None or (full == name and "." not in name):
            return None
        level = len(full) - len(full.lstrip("."))
        module, _, attr = full[level:].rpartition(".")
        if not attr:
            return None
        target = codebase.resolve_module(self.files, rel, module, level)
        return self.by_file.get(target, {}).get(attr) if target else None

    def _constant(self, rel: str, imps: dict[str, pycode.Imported], name: str) -> str | None:
        """Строка канала для голого ИМЕНИ: константа модуля-реестра этого файла или
        импортированная из модуля-реестра репозитория («from m import ИМЯ [as Другое]»)."""
        imp = imps.get(name)
        if imp is None:
            reg = self.by_file.get(rel, {}).get(_CONSTANTS)
            return reg.members[name][0] if reg is not None and name in reg.members else None
        if not imp.attr:
            return None
        target = codebase.resolve_module(self.files, rel, imp.module, imp.level)
        reg = self.by_file.get(target, {}).get(_CONSTANTS) if target else None
        return reg.members[imp.attr][0] if reg is not None and imp.attr in reg.members else None

    def imports_registry(self, rel: str, imps: dict[str, pycode.Imported]) -> bool:
        """Файл импортирует из модуля репозитория реестр или константу модуля-реестра
        («from posthog.kafka_client.topics import KAFKA_APP_METRICS2»)."""
        for imp in imps.values():
            if not imp.attr:
                continue
            target = codebase.resolve_module(self.files, rel, imp.module, imp.level)
            own = self.by_file.get(target, {}) if target else {}
            consts = own.get(_CONSTANTS)
            if imp.attr in own or (consts is not None and imp.attr in consts.members):
                return True
        return False

    def value(
        self, rel: str, imps: dict[str, pycode.Imported], node: ast.AST | None,
    ) -> str | None:
        """Строка канала для Name.MEMBER, Name.MEMBER.value, Name["MEMBER"] и голого
        ИМЕНИ константы модуля-реестра; None — это не член известного реестра."""
        if isinstance(node, ast.Name):
            return self._constant(rel, imps, node.id)
        if isinstance(node, ast.Attribute) and node.attr == "value" and isinstance(
            node.value, ast.Attribute
        ):
            node = node.value
        if isinstance(node, ast.Attribute):
            reg = self._find(rel, imps, node.value)
            member = node.attr
        elif isinstance(node, ast.Subscript):
            reg = self._find(rel, imps, node.value)
            member = pycode.string(node.slice) or ""
        else:
            return None
        if reg is None or member not in reg.members:
            return None
        return reg.members[member][0]

    def string(
        self, rel: str, imps: dict[str, pycode.Imported], node: ast.AST | None,
    ) -> str | None:
        """Строковый литерал или член реестра."""
        literal = pycode.string(node)
        return literal if literal is not None else self.value(rel, imps, node)

    def strings(
        self, rel: str, imps: dict[str, pycode.Imported], node: ast.AST | None,
    ) -> list[str] | None:
        """Строка, член реестра или список и кортеж из них; None — что-то не раскрылось."""
        one = self.string(rel, imps, node)
        if one is not None:
            return [one]
        if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            out = [self.string(rel, imps, e) for e in node.elts]
            if all(s is not None for s in out):
                return [s for s in out if s is not None]
        return None


def name_words(name: str) -> list[str]:
    """Слова имени в нижнем регистре: CeleryQueue → celery, queue; KAFKA_TOPIC_TO_CLUSTER →
    kafka, topic, to, cluster."""
    return [w.lower() for w in _NAME_WORD.findall(name)]


def _is_registry(name: str, words: frozenset[str], is_dict: bool) -> bool:
    """Имя реестра: последнее слово называет вид брокера; у словаря ещё «…_TOPIC_TO_…».
    Имя «…_TO_TOPICS» сопоставляет каналам что-то другое (типы объектов вебхуков у PostHog):
    его ключи и члены не каналы."""
    parts = name_words(name)
    if not parts or _SQS_WORD in parts:
        return False
    if parts[-1] in words:
        return len(parts) < 2 or parts[-2] != "to"
    return is_dict and any(
        a in words and b == "to" for a, b in zip(parts, parts[1:], strict=False)
    )


def _sqs_module(rel: str, imps: dict[str, pycode.Imported]) -> bool:
    """Модуль очередей SQS: подключает клиент AWS или лежит в каталоге со словом sqs."""
    if pycode.imports_any(imps, _SQS_MODULES):
        return True
    if any(_SQS_WORD in imp.module.lower().split(".") for imp in imps.values()):
        return True
    return any(_SQS_WORD in name_words(seg) for seg in rel.split("/")[:-1])


def _words(spec: Spec, with_channel: bool) -> frozenset[str]:
    return spec.words | _CHANNEL_WORDS if with_channel else spec.words


def _is_enum(cls: ast.ClassDef) -> bool:
    return any((pycode.dotted(b) or "").rsplit(".", 1)[-1].endswith("Enum") for b in cls.bases)


def _class_members(cls: ast.ClassDef) -> dict[str, tuple[str, int]]:
    enum = _is_enum(cls)
    out: dict[str, tuple[str, int]] = {}
    for stmt in cls.body:
        if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1:
            target, value = stmt.targets[0], stmt.value
        elif isinstance(stmt, ast.AnnAssign) and stmt.value is not None:
            target, value = stmt.target, stmt.value
        else:
            continue
        text = pycode.string(value)
        if not isinstance(target, ast.Name) or not text or target.id.startswith("_"):
            continue
        if any(ch.isspace() for ch in text):
            continue
        if enum or _MEMBER.fullmatch(target.id):
            out.setdefault(target.id, (text, stmt.lineno))
    return out


def _dict_members(value: ast.Dict) -> dict[str, tuple[str, int]]:
    out: dict[str, tuple[str, int]] = {}
    for key in value.keys:
        text = pycode.string(key)
        if text and key is not None and not any(ch.isspace() for ch in text):
            out.setdefault(text, (text, key.lineno))
    return out


def _module_registries(tree: ast.Module, words: frozenset[str]) -> dict[str, _Registry]:
    out: dict[str, _Registry] = {}
    for stmt in tree.body:
        name: str | None = None
        members: dict[str, tuple[str, int]] = {}
        if isinstance(stmt, ast.ClassDef):
            name = stmt.name
            if _is_registry(name, words, False):
                members = _class_members(stmt)
        else:
            target: ast.AST | None = None
            value: ast.AST | None = None
            if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1:
                target, value = stmt.targets[0], stmt.value
            elif isinstance(stmt, ast.AnnAssign):
                target, value = stmt.target, stmt.value
            if isinstance(target, ast.Name) and isinstance(value, ast.Dict):
                name = target.id
                if _is_registry(name, words, True):
                    members = _dict_members(value)
        if name and members:
            out[name] = _Registry(name=name, members=members)
    return out


def constants_module(rel: str, kind: str) -> bool:
    """Модуль-реестр констант вида kind: последнее слово имени файла во множественном
    числе (topics.py, kafka_topics.py, kafka-topics.ts, celery_queues.py)."""
    stem = paths.name(rel).rsplit(".", 1)[0]
    words = name_words(stem)
    return bool(words) and words[-1] == _PLURAL.get(kind)


def literal_part(node: ast.AST | None, imps: dict[str, pycode.Imported]) -> str | None:
    """Литеральная часть значения константы-канала: строка, f-строка без подстановок,
    дефолт чтения окружения (get_from_env, os.environ.get, os.getenv). None — значение не
    такого вида (число, имя, вызов другой функции); пустая строка — литералов нет."""
    if isinstance(node, ast.Constant):
        return node.value if isinstance(node.value, str) else None
    if isinstance(node, ast.JoinedStr):
        return "".join(
            v.value for v in node.values if isinstance(v, ast.Constant) and isinstance(v.value, str)
        )
    if isinstance(node, ast.Call):
        qual = pycode.qualname(node.func, imps) or ""
        if qual not in _ENV_CALLS and pyast.last_name(node) != _ENV_HELPER:
            return None
        default = pycode.arg(node, 1, "default")
        if default is None:
            return ""
        return literal_part(default, imps) if not isinstance(default, ast.Call) else None
    return None


def _module_constants(
    rel: str, tree: ast.Module, imps: dict[str, pycode.Imported], found: Findings | None,
) -> dict[str, tuple[str, int]]:
    """Константы модуля-реестра: ИМЯ в верхнем регистре → (канал, строка). Значение без
    литеральной части — подсказка о динамическом имени (found None — подсказок не писать)."""
    out: dict[str, tuple[str, int]] = {}
    for stmt in tree.body:
        if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1:
            target, value = stmt.targets[0], stmt.value
        elif isinstance(stmt, ast.AnnAssign) and stmt.value is not None:
            target, value = stmt.target, stmt.value
        else:
            continue
        if not isinstance(target, ast.Name) or not _MEMBER.fullmatch(target.id):
            continue
        text = literal_part(value, imps)
        if text is None or any(ch.isspace() for ch in text):
            continue
        if not any(ch.isalnum() for ch in text):
            if found is not None:
                found.hints.append(Hint("dynamic_names", {
                    "kind": "channel", "name": target.id,
                    "reason": texts.REASON_DYNAMIC_CHANNEL, "source": str(Loc(rel, stmt.lineno)),
                }))
            continue
        out.setdefault(target.id, (text, stmt.lineno))
    return out


def _candidate(text: str, words: frozenset[str], decorators: bool) -> bool:
    """Дешёвый отбор файла до разбора: класс или словарь модуля с нужной частью имени,
    декоратор с частью queue."""
    for pattern in (_CLASS, _DICT):
        for m in pattern.finditer(text):
            if set(name_words(m.group(1))) & words:
                return True
    if decorators:
        for m in _DECORATOR.finditer(text):
            if "queue" in name_tokens(m.group(1).rsplit(".", 1)[-1]):
                return True
    return False


def _test_only(call: ast.Call) -> bool:
    """Именованный аргумент с частью test и значением True: тестовая очередь."""
    return any(
        kw.arg and _TEST_WORD in name_tokens(kw.arg)
        and isinstance(kw.value, ast.Constant) and kw.value.value is True
        for kw in call.keywords
    )


def _consumers(rel: str, tree: ast.Module, spec: Spec, found: Findings) -> list[ChannelUse]:
    out: list[ChannelUse] = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        for dec in node.decorator_list:
            if not isinstance(dec, ast.Call) or not dec.args:
                continue
            if "queue" not in name_tokens(pyast.last_name(dec) or ""):
                continue
            if _test_only(dec):
                continue
            first = dec.args[0]
            name = pycode.string(first)
            if name is None:
                found.hints.append(Hint("dynamic_names", {
                    "kind": "channel", "name": pycode.short(first),
                    "reason": texts.REASON_DYNAMIC_CHANNEL, "source": str(Loc(rel, dec.lineno)),
                }))
            elif name:
                out.append(ChannelUse(
                    name=name, kind="queue", client=spec.client, direction="consume",
                    loc=Loc(rel, dec.lineno), parser=spec.parser,
                ))
    return out


def scan(
    files: Files, ctx: Context, spec: Spec, wanted: frozenset[str], clients: tuple[str, ...],
    found: Findings, declare: bool = True,
) -> Registries:
    """Реестры вида spec в файлах Python пакетов с клиентом брокера (wanted) и потребители
    по декоратору. Строки реестров (каналы без направления) и потребители ложатся в
    found.channels; возвращается индекс для раскрытия Name.MEMBER в вызовах клиента.
    clients — модули клиента: в файле, который их подключает, реестром считается и имя с
    частью channel. declare=False — только индекс: очереди реестров и декораторов уже
    объявляет другой разборщик (Celery рядом с RabbitMQ)."""
    regs = Registries(files, spec)
    every = _words(spec, True)
    for rel, text in codebase.sources(files, ctx, codebase.PYTHON, wanted):
        module = constants_module(rel, spec.kind)
        if not module and not _candidate(text, every, spec.decorators):
            continue
        tree = pyast.parse(text)
        if tree is None:
            continue
        imps = pycode.imports(tree)
        words = _words(spec, pycode.imports_any(imps, clients))
        sqs = spec.kind == "queue" and _sqs_module(rel, imps)
        own = {} if sqs else _module_registries(tree, words)
        if module and not sqs:
            members = _module_constants(rel, tree, imps, found if declare else None)
            if members:
                own[_CONSTANTS] = _Registry(name=_CONSTANTS, members=members)
        if own:
            regs.by_file[rel] = own
        if not declare:
            continue
        if own:
            for reg in own.values():
                for value, line in reg.members.values():
                    found.channels.append(ChannelUse(
                        name=value, kind=spec.kind, client=spec.client, direction=None,
                        loc=Loc(rel, line), parser=spec.parser,
                    ))
        if spec.decorators:
            found.channels.extend(_consumers(rel, tree, spec, found))
    return regs
