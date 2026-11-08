"""Очереди и расписание Sidekiq (ТЗ §6.2, ч. 2 В3). Репозиторий на Ruby с sidekiq в Gemfile.

config/sidekiq*.yml: элементы :queues: (строка или список [имя, вес]) объявляют очереди без
направления, раздел :scheduler: :schedule: (или :schedule: верхнего уровня, sidekiq-scheduler)
даёт расписания: имя, every, cron, interval, at или in как написано (у списка первый
элемент), class задачей. Вставки ERB (<%= … %>) в значениях подменяются на время разбора
YAML и возвращаются в текст расписания как написано; имя очереди со вставкой уходит в
hints.dynamic_names. YAML, который и так не разбирается, читается построчно (только :queues:).

Файл Ruby с include Sidekiq::Worker или Sidekiq::Job в классе (или класс-наследник такого
класса того же репозитория) потребляет очередь из sidekiq_options queue: 'x' | :x | "x",
без неё очередь базового класса или default. Публикации (perform_async) не читаются: их
слишком много и они размазаны по коду. Владелец потребителя и расписания среди контейнеров
файла тот, чья команда запускает sidekiq (runner, codefacts). Брокер Redis по клиенту.
Класс из записи расписания с queue: X без своей очереди в sidekiq_options потребляет X
(часть 2б): у Mastodon классы Scheduler::* — очередь scheduler.
"""

from __future__ import annotations

import re
from bisect import bisect_right
from collections.abc import Iterator
from typing import Any

from archmap_scan import codebase, paths, texts, yamlload
from archmap_scan.context import Context
from archmap_scan.model import ChannelUse, CodeSchedule, Findings, Hint, Loc
from archmap_scan.walk import Files

NAME = "sidekiq"
CLIENT = "Sidekiq"
RUNNER = "sidekiq"
WANTED = frozenset({"sidekiq"})
DEFAULT_QUEUE = "default"
_CONFIG = re.compile(r"sidekiq[\w.-]{0,100}\.ya?ml")
_PLACEHOLDER = "__erb{}__"
_PLACEHOLDER_RE = re.compile(r"__erb(\d{1,7})__")
_SCHEDULE_KEYS = ("cron", "every", "interval", "at", "in")
_CONST = r"(?:::)?[A-Z]\w{0,199}(?:::[A-Z]\w{0,199}){0,20}"
_INCLUDE = re.compile(r"^[ \t]*include[ \t]+(?:::)?Sidekiq::(?:Worker|Job)\b", re.M)
_CLASS = re.compile(rf"^[ \t]*class[ \t]+({_CONST})(?:[ \t]*<[ \t]*({_CONST}))?", re.M)
_MODULE = re.compile(rf"^([ \t]*)module[ \t]+({_CONST})", re.M)
_OPTIONS = re.compile(r"^[ \t]*sidekiq_options\b([^\n]{0,1000})", re.M)
_QUEUE = re.compile(
    r"(?:(?<![\w:])queue:|:queue[ \t]*=>)[ \t]*"
    r"(?:'([^'\n]{0,200})'|\"([^\"\n]{0,200})\"|:([A-Za-z_]\w{0,199})|([^,\s)][^,\n)]{0,100}))"
)
_LIST_ITEM = re.compile(r"[ \t]*-[ \t]*\[?[ \t]*(['\"]?)([^'\",\]\s]{1,200})\1")
# Сколько раз искать наследников классов воркеров (BaseWorker < ApplicationWorker < …).
_MAX_ROUNDS = 5


def _hint(found: Findings, name: str, loc: Loc) -> None:
    found.hints.append(Hint("dynamic_names", {
        "kind": "channel", "name": name, "reason": texts.REASON_DYNAMIC_CHANNEL,
        "source": str(loc),
    }))


def _use(name: str, direction: str | None, loc: Loc, runner: str | None) -> ChannelUse:
    return ChannelUse(name=name, kind="queue", client=CLIENT, direction=direction, loc=loc,
                      parser=NAME, runner=runner)


# config/sidekiq.yml

def _erb_out(text: str) -> tuple[str, list[str]]:
    """Текст без вставок ERB (на их месте метки __erbN__) и сами вставки по номерам. Поиск
    линейный: незакрытая вставка остаётся текстом."""
    out: list[str] = []
    erbs: list[str] = []
    pos = 0
    while (start := text.find("<%", pos)) != -1:
        end = text.find("%>", start + 2)
        if end == -1:
            break
        out.append(text[pos:start])
        out.append(_PLACEHOLDER.format(len(erbs)))
        erbs.append(text[start:end + 2])
        pos = end + 2
    out.append(text[pos:])
    return "".join(out), erbs


def _erb_in(value: str, erbs: list[str]) -> str:
    """Вернуть вставки ERB на место меток: текст как написано в файле."""
    def back(m: re.Match[str]) -> str:
        i = int(m.group(1))
        return erbs[i] if i < len(erbs) else m.group()
    return _PLACEHOLDER_RE.sub(back, value)


def _key(doc: Any, name: str) -> Any:
    """Значение ключа :name: или name: отображения; ключ и строка его начала."""
    if not isinstance(doc, dict):
        return None, 0
    for key in (":" + name, name):
        if key in doc:
            line = doc.line_of(key) if isinstance(doc, yamlload.LineDict) else 0
            return doc[key], line
    return None, 0


def _queue_items(doc: Any) -> Iterator[tuple[str, int]]:
    queues, line = _key(doc, "queues")
    if not isinstance(queues, list):
        return
    lines = queues.item_lines if isinstance(queues, yamlload.LineList) else []
    for i, item in enumerate(queues):
        if isinstance(item, list) and item:
            item = item[0]
        if isinstance(item, (str, int)) and str(item):
            yield str(item), lines[i] if i < len(lines) else line


def _queues_by_lines(text: str) -> Iterator[tuple[str, int]]:
    """:queues: построчно, когда YAML целиком не разбирается."""
    inside = False
    for number, raw in enumerate(text.splitlines(), 1):
        stripped = raw.strip()
        if not inside:
            inside = stripped in (":queues:", "queues:")
            continue
        if not stripped or stripped.startswith("#"):
            continue
        hit = _LIST_ITEM.match(raw)
        if hit is None:
            break
        yield hit.group(2), number


def _schedule_text(entry: dict[Any, Any], erbs: list[str]) -> str | None:
    for key in _SCHEDULE_KEYS:
        value = entry.get(key)
        if isinstance(value, list):
            value = value[0] if value else None
        if isinstance(value, (str, int)) and str(value).strip():
            return _erb_in(str(value), erbs)
    return None


def _schedules(
    rel: str, doc: Any, erbs: list[str], found: Findings, scheduled: dict[str, list[str]],
) -> None:
    """Расписания раздела :schedule:; очередь записи (queue: X) — в scheduled по имени
    класса (ТЗ §15 п. 13 В3, часть 2б): sidekiq-scheduler кладёт задачу в очередь записи."""
    scheduler, _line = _key(doc, "scheduler")
    table, _line = _key(scheduler, "schedule")
    if not isinstance(table, dict):
        table, _line = _key(doc, "schedule")
    if not isinstance(table, dict):
        return
    for name, entry in table.items():
        if not isinstance(entry, dict):
            continue
        schedule = _schedule_text(entry, erbs)
        if schedule is None:
            continue
        task = entry.get("class")
        line = table.line_of(name) if isinstance(table, yamlload.LineDict) else 1
        found.schedules.append(CodeSchedule(
            name=_erb_in(str(name), erbs), schedule=schedule,
            task=_erb_in(str(task), erbs) if isinstance(task, str) else None,
            loc=Loc(rel, line), parser=NAME, runner=RUNNER,
        ))
        queue = entry.get("queue")
        if not isinstance(task, str) or not isinstance(queue, (str, int)) or not str(queue):
            continue
        queue = str(queue).strip().removeprefix(":")
        if _PLACEHOLDER_RE.search(queue) or _PLACEHOLDER_RE.search(task):
            _hint(found, _erb_in(queue, erbs), Loc(rel, line))
            continue
        queues = scheduled.setdefault(task.strip().removeprefix("::"), [])
        if queue and queue not in queues:
            queues.append(queue)


def _config(rel: str, text: str, found: Findings, scheduled: dict[str, list[str]]) -> None:
    clean, erbs = _erb_out(text)
    try:
        doc = yamlload.load(clean)
    except (yamlload.BadYaml, yamlload.YamlTooLarge):
        doc = None
    items = _queue_items(doc) if isinstance(doc, dict) else _queues_by_lines(text)
    for name, line in items:
        if _PLACEHOLDER_RE.search(name) or "<%" in name:
            _hint(found, _erb_in(name, erbs), Loc(rel, line))
        else:
            found.channels.append(_use(name, None, Loc(rel, line), None))
    if isinstance(doc, dict):
        _schedules(rel, doc, erbs, found, scheduled)


# Классы воркеров

def _short(name: str) -> str:
    return name.rsplit("::", 1)[-1]


def _queue_in(text: str, start: int, end: int) -> tuple[str | None, str | None]:
    """Очередь из sidekiq_options в границах класса: (имя, None), (None, выражение) для
    нелитерала или (None, None), если очередь не задана."""
    options = _OPTIONS.search(text, start, end)
    if options is None:
        return None, None
    hit = _QUEUE.search(options.group(1))
    if hit is None:
        return None, None
    single, double, symbol, other = hit.groups()
    if double is not None and "#{" in double:
        return None, double
    value = single if single is not None else double if double is not None else symbol
    if value is None:
        return None, (other or "").strip()
    return value, None


class _Workers:
    """Классы воркеров Sidekiq: полное имя (с модулями) → очередь (None — default).
    scheduled — очереди записей расписания по имени класса."""

    def __init__(self, found: Findings, scheduled: dict[str, list[str]] | None = None) -> None:
        self.found = found
        self.scheduled = scheduled or {}
        self.queues: dict[str, str | None] = {}
        self.by_short: dict[str, list[str]] = {}
        self.seen: set[tuple[str, int]] = set()  # (файл, позиция класса)

    def add(self, src: _Source, i: int, line: int, inherited: str | None) -> None:
        """Класс номер i файла src — воркер; line — строка основания (include или class)."""
        key = (src.rel, src.classes[i].start())
        if key in self.seen:
            return
        self.seen.add(key)
        start, end = src.bounds(i)
        queue, dynamic = _queue_in(src.text, start, end)
        loc = Loc(src.rel, line)
        if dynamic is not None:
            _hint(self.found, dynamic, loc)
            return
        name = queue or inherited
        full = src.names[i]
        if full not in self.queues:
            # Наследникам достаётся очередь класса, а не записи расписания: в записи стоит
            # только этот класс.
            self.queues[full] = name
            self.by_short.setdefault(_short(full), []).append(full)
        # Своя очередь класса сильнее записи расписания, запись сильнее очереди базового
        # класса и default (sidekiq-scheduler ставит задачу в очередь записи).
        targets = [queue] if queue else self.scheduled.get(full) or [name or DEFAULT_QUEUE]
        for target in targets:
            self.found.channels.append(_use(target, "consume", loc, RUNNER))

    def resolve(self, base: str, owner: str) -> str | None:
        """Базовый класс по имени, как его пишет наследник: полное имя, имя в модулях
        наследника (class ActivityPub::X < DeliveryWorker), иначе единственный класс с таким
        коротким именем. Одноимённые классы разных модулей (DistributionWorker и
        ActivityPub::DistributionWorker у Mastodon) различаются."""
        base = base.removeprefix("::")
        scope = owner.split("::")[:-1]
        for k in range(len(scope), -1, -1):
            cand = "::".join([*scope[:k], base])
            if cand in self.queues:
                return cand
        same = self.by_short.get(_short(base), [])
        return same[0] if len(same) == 1 and "::" not in base else None


class _Source:
    """Файл Ruby: классы по порядку, их полные имена (с открытыми модулями), границы и
    номера строк по позиции."""

    def __init__(self, rel: str, text: str) -> None:
        self.rel = rel
        self.text = text
        self.classes = list(_CLASS.finditer(text))
        self._starts = [c.start() for c in self.classes]
        self._breaks = [m.start() for m in re.finditer("\n", text)]
        self.names = self._full_names()

    def _full_names(self) -> list[str]:
        """Полное имя класса: модули, открытые выше с меньшим отступом, и имя как написано.
        Отступ закрывает модуль: следующий module или class с тем же отступом его сменяет."""
        marks = sorted(
            [(m.start(), m.group(1), m.group(2), True) for m in _MODULE.finditer(self.text)]
            + [(c.start(), c.group(0), c.group(1), False) for c in self.classes]
        )
        stack: list[tuple[int, str]] = []
        out: list[str] = []
        for _pos, head, name, is_module in marks:
            indent = len(head) - len(head.lstrip(" \t")) if not is_module else len(head)
            while stack and stack[-1][0] >= indent:
                stack.pop()
            name = name.removeprefix("::")
            if is_module:
                stack.append((indent, name))
            else:
                out.append("::".join([*(n for _i, n in stack), name]))
        return out

    def line(self, pos: int) -> int:
        return bisect_right(self._breaks, pos - 1) + 1

    def owner(self, pos: int) -> int | None:
        """Номер класса, внутри которого позиция pos (последний класс перед ней)."""
        i = bisect_right(self._starts, pos) - 1
        return i if i >= 0 else None

    def bounds(self, i: int) -> tuple[int, int]:
        end = self._starts[i + 1] if i + 1 < len(self._starts) else len(self.text)
        return self._starts[i], end


def _direct(rel: str, text: str, workers: _Workers) -> None:
    src = _Source(rel, text)
    for inc in _INCLUDE.finditer(text):
        i = src.owner(inc.start())
        if i is not None:  # include в модуле, а не в классе, воркером не считается
            workers.add(src, i, src.line(inc.start()), None)


def _inherited(files: Files, ctx: Context, workers: _Workers) -> None:
    """Наследники классов воркеров того же репозитория (class X < ApplicationWorker). Каждый
    круг ищет наследников только новых классов прошлого круга: файлы не перечитываются зря."""
    frontier = set(workers.queues)
    for _ in range(_MAX_ROUNDS):
        if not frontier:
            return
        before = set(workers.queues)
        alts = "|".join(sorted({re.escape(_short(n)) for n in frontier}))
        pattern = re.compile(rf"<[ \t]*(?:\w{{1,200}}::){{0,20}}(?:{alts})\b")
        for rel, text in codebase.sources(files, ctx, codebase.RUBY, WANTED, pattern=pattern):
            src = _Source(rel, text)
            for i, cls in enumerate(src.classes):
                base = cls.group(2)
                if base is None or (rel, cls.start()) in workers.seen:
                    continue
                target = workers.resolve(base, src.names[i])
                if target in frontier:
                    workers.add(src, i, src.line(cls.start()), workers.queues[target])
        frontier = set(workers.queues) - before


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not codebase.stack_present(files, ctx, codebase.RUBY, WANTED):
        return found
    found.applied.add(NAME)
    scheduled: dict[str, list[str]] = {}
    for rel in files.paths:
        if paths.parent(rel).rsplit("/", 1)[-1] != "config":
            continue
        if not _CONFIG.fullmatch(paths.name(rel).lower()):
            continue
        text = files.read(rel)
        if text is not None:
            _config(rel, text, found, scheduled)
    workers = _Workers(found, scheduled)
    for rel, text in codebase.sources(files, ctx, codebase.RUBY, WANTED, ("Sidekiq::",)):
        _direct(rel, text, workers)
    _inherited(files, ctx, workers)
    return found
