"""Очереди BullMQ и Bull в коде (ТЗ §6.2, ч. 2 В2): файл JavaScript или TypeScript подключает
bullmq, @nestjs/bullmq, bull или @nestjs/bull. new Queue('x') и @InjectQueue('x') дают
публикацию в очередь x, new Worker('x', …) и @Processor('x') дают потребление,
BullModule.registerQueue({ name: 'x' }) объявляет очередь без направления. Брокер очередей
Redis (codefacts по клиенту BullMQ).

Аргумент членом enum (QueueName.X, QueueName['X']) раскрывается по реестру: enum (и const
enum) со строковыми значениями членов в любом файле пакета с этими зависимостями, у имени
которого последнее слово queue или queues или имя кончается на QueueName(s). Члены реестра
дают очереди без направления, как реестры Python (pyregistry). Enum QueueJobStatus и JobName
реестрами не считаются: их члены статусы и задачи, а не очереди. Переменная в аргументе
(immich: цикл по Object.values(QueueName)) уходит в hints.dynamic_names. new Worker в файле,
который подключает worker_threads, не потребитель очереди: это поток Node.js."""

from __future__ import annotations

import re

from archmap_scan import codebase, codetext, pyregistry, texts
from archmap_scan.codetext import SP, STR
from archmap_scan.context import Context
from archmap_scan.model import ChannelUse, Findings, Hint, Loc
from archmap_scan.walk import Files

NAME = "bullmq"
CLIENT = "BullMQ"
WANTED = frozenset({"bullmq", "@nestjs/bullmq", "bull", "@nestjs/bull"})
_THREADS = frozenset({"worker_threads", "node:worker_threads"})
_IDENT = r"[A-Za-z_$][A-Za-z0-9_$]{0,199}"
_NEW = re.compile(rf"\bnew[ \t]+(Queue|Worker)[ \t]*(?:<[^<>()\n]{{0,200}}>)?[ \t]*\({SP}")
_DECORATOR = re.compile(rf"@(InjectQueue|Processor)[ \t]*\({SP}")
_REGISTER = re.compile(rf"\bBullModule[ \t]*\.[ \t]*registerQueue(?:Async)?[ \t]*\({SP}")
_DIRECTION = {"Queue": "publish", "InjectQueue": "publish", "Worker": "consume",
              "Processor": "consume"}
_ENUM = re.compile(rf"\benum[ \t]+({_IDENT})[ \t\r\n]{{0,200}}\{{")
# Член enum: имя с начала слова (без перебора внутри длинного слова) или строка в кавычках.
_ENUM_MEMBER = re.compile(
    rf"(?<![A-Za-z0-9_$])({_IDENT}|'[ ]*'|\"[ ]*\")[ \t\r\n]{{0,200}}=[ \t\r\n]{{0,200}}"
    rf"('[ ]*'|\"[ ]*\"|`[ \n]*`)"
)
_MEMBER_REF = re.compile(
    rf"({_IDENT})[ \t]*(?:\.[ \t]*({_IDENT})|\[[ \t]*('[ ]*'|\"[ ]*\")[ \t]*\])"
)
_NAME_KEY = re.compile(rf"(?<![A-Za-z0-9_$])name[ \t]*:{SP}")
_STR = re.compile(STR)
# Слова, которыми кончается имя реестра очередей; «…QueueName(s)» тоже реестр.
_QUEUE_WORDS = frozenset({"queue", "queues"})
_QUEUE_SUFFIXES = ("QueueName", "QueueNames")
# Сколько знаков смотреть в теле enum и в объекте аргумента и сколько объектов читать у
# registerQueue (настоящий код далёк от пределов). Разбор не возвращается в уже прочитанное:
# время линейно по размеру файла и на враждебном входе.
_MAX_BODY = 100_000
_MAX_OBJECT = 2_000
_MAX_OBJECTS = 1_000

Enums = dict[str, dict[str, str]]


def _use(name: str, direction: str | None, rel: str, line: int) -> ChannelUse:
    return ChannelUse(name=name, kind="queue", client=CLIENT, direction=direction,
                      loc=Loc(rel, line), parser=NAME)


def _hint(
    found: Findings, name: str, rel: str, line: int, reason: str = texts.REASON_DYNAMIC_CHANNEL,
) -> None:
    found.hints.append(Hint("dynamic_names", {
        "kind": "channel", "name": name, "reason": reason, "source": str(Loc(rel, line)),
    }))


def queue_enum(name: str) -> bool:
    """Имя enum называет реестр очередей: последнее слово queue(s) или конец QueueName(s)."""
    words = pyregistry.name_words(name)
    return bool(words) and (words[-1] in _QUEUE_WORDS or name.endswith(_QUEUE_SUFFIXES))


def _block_end(mask: str, start: int, limit: int = _MAX_BODY) -> int:
    """Позиция парной закрывающей скобки к открывающей перед start (не дальше limit знаков)."""
    depth = 1
    stop = min(len(mask), start + limit)
    for i in range(start, stop):
        ch = mask[i]
        if ch in "{([":
            depth += 1
        elif ch in "})]":
            depth -= 1
            if depth == 0:
                return i
    return stop


def _enums(files: Files, ctx: Context, found: Findings) -> Enums:
    """Реестры очередей: enum с подходящим именем и строковыми членами; члены — очереди без
    направления. Одноимённые enum разных файлов сливаются (первое значение члена остаётся)."""
    out: Enums = {}
    for rel, text in codebase.sources(files, ctx, codebase.NODE, WANTED, ("enum",)):
        code = codetext.load(files, rel, text, codetext.JS)
        if code is None:
            continue
        mask = code.mask
        pos = 0
        while (m := _ENUM.search(mask, pos)) is not None:
            pos = m.end()
            if not queue_enum(m.group(1)):
                continue
            end = _block_end(mask, m.end())
            pos = max(pos, end)
            members = out.setdefault(m.group(1), {})
            for item in _ENUM_MEMBER.finditer(mask, m.end(), end):
                key = item.group(1)
                if key[0] in "'\"":
                    key = code.text[item.start(1) + 1:item.end(1) - 1]
                value, dynamic = code.literal(item.start(2), item.end(2))
                if dynamic or not value or any(ch.isspace() for ch in value):
                    continue
                if key not in members:
                    members[key] = value
                    found.channels.append(_use(value, None, rel, code.line(item.start())))
            if not members:
                del out[m.group(1)]
    return out


Why = tuple[str, str] | None


def _names_at(
    code: codetext.Code, pos: int, enums: Enums, objects: bool,
) -> tuple[list[str], Why, int]:
    """Имена очередей аргумента с позиции pos: строка, член реестра или объект с ключом
    name (objects; у registerQueue их несколько через запятую). Второе — текст выражения и
    причина для подсказки о динамическом имени, если аргумент не раскрылся, иначе None;
    третье — докуда дочитан аргумент."""
    names, why = _value_at(code, pos, enums)
    if names or why or not objects:
        return names, why, pos
    mask = code.mask
    out: list[str] = []
    for _ in range(_MAX_OBJECTS):
        if not mask.startswith("{", pos):
            break
        end = _block_end(mask, pos + 1, _MAX_OBJECT)
        key = _NAME_KEY.search(mask, pos + 1, end)
        if key is None:
            return out, None, end  # объект без name: у registerQueue это не очередь
        names, why = _value_at(code, key.end(), enums)
        if why:
            return out, why, end
        out.extend(names)
        pos = end + 1
        while pos < len(mask) and mask[pos] in " \t\r\n,":
            pos += 1
    return out, None, pos


def _value_at(code: codetext.Code, pos: int, enums: Enums) -> tuple[list[str], Why]:
    """Строка или член реестра в позиции pos; объект и пусто — ([], None)."""
    mask = code.mask
    hit = _STR.match(mask, pos)
    if hit is not None:
        value, dynamic = code.literal(hit.start(), hit.end())
        if dynamic:
            reason = code.reason(hit.start(), hit.end(), texts.REASON_DYNAMIC_CHANNEL)
            return [], (code.expression(pos), reason)
        return ([value] if value else []), None
    ref = _MEMBER_REF.match(mask, pos)
    if ref is not None and ref.group(1) in enums:
        member = ref.group(2) or code.text[ref.start(3) + 1:ref.end(3) - 1]
        known = enums[ref.group(1)].get(member)
        if known:
            return [known], None
        return [], (code.expression(pos), texts.REASON_DYNAMIC_CHANNEL)
    if pos < len(mask) and (mask[pos].isalpha() or mask[pos] in "_$."):
        return [], (code.expression(pos), texts.REASON_DYNAMIC_CHANNEL)
    return [], None


def _code(rel: str, code: codetext.Code, found: Findings, enums: Enums, threads: bool) -> None:
    calls: list[tuple[int, int, str | None, bool]] = []
    for m in _NEW.finditer(code.mask):
        if m.group(1) == "Worker" and threads:
            continue  # поток worker_threads, не потребитель очереди
        calls.append((m.start(), m.end(), _DIRECTION[m.group(1)], False))
    for m in _DECORATOR.finditer(code.mask):
        calls.append((m.start(), m.end(), _DIRECTION[m.group(1)], m.group(1) == "Processor"))
    for m in _REGISTER.finditer(code.mask):
        calls.append((m.start(), m.end(), None, True))
    done = -1
    for start, end, direction, objects in sorted(calls):
        if start < done:
            continue  # вызов внутри уже прочитанного аргумента
        line = code.line(start)
        names, why, done = _names_at(code, end, enums, objects)
        found.channels.extend(_use(n, direction, rel, line) for n in names)
        if why:
            _hint(found, why[0], rel, line, why[1])
            done = max(done, end + len(why[0]))  # текст выражения уже прочитан


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not codebase.stack_present(files, ctx, codebase.NODE, WANTED):
        return found
    found.applied.add(NAME)
    enums = _enums(files, ctx, found)
    for rel, text in codebase.sources(
        files, ctx, codebase.NODE, WANTED, ("Queue", "Worker", "Processor"),
    ):
        if not codetext.imports(text, WANTED, codetext.JS):
            continue
        code = codetext.load(files, rel, text, codetext.JS)
        if code is not None:
            _code(rel, code, found, enums, codetext.imports(text, _THREADS, codetext.JS))
    return found
