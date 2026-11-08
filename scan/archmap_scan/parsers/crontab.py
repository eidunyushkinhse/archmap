"""Расписания crontab (ТЗ §6.2): файлы crontab и *.crontab, *.cron и файлы каталогов
cron.d. Строка — «расписание команда»: пять полей или @hourly, @daily и подобные; в
cron.d и /etc/crontab после расписания идёт пользователь. Комментарии, пустые строки и
присваивания (MAILTO=, SHELL=) пропускаются. Имени у строки crontab нет, поэтому имя
записи — имя файла без расширения, а при нескольких строках в файле к нему добавляется
номер строки по порядку («crontab-2»). Файлы в каталогах для разработки не читаются
по тому же перечню, что и код (walk.CODE_DEV_TOKENS), и считаются в покрытии; файл больше
чем с _MAX_ENTRIES записями считается непрочитанным. Разбор
построчный, без регулярных выражений."""

from __future__ import annotations

from archmap_scan import paths
from archmap_scan.context import Context
from archmap_scan.model import CodeSchedule, Findings, Loc
from archmap_scan.walk import CODE_SKIP_DIRS, Files

NAME = "crontab"
# Символы полей расписания: числа, *, шаги, диапазоны, списки и имена месяцев и дней.
_FIELD_CHARS = frozenset("0123456789*/,-?#abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
_SPECIALS = frozenset({
    "@reboot", "@yearly", "@annually", "@monthly", "@weekly", "@daily", "@midnight", "@hourly",
})
_MAX_LINE = 2000
_MAX_TASK = 300
# Записей в одном файле: больше бывает только у сгенерированных данных.
_MAX_ENTRIES = 2000


def _cron_d(rel: str) -> bool:
    return paths.name(paths.parent(rel)) == "cron.d"


def is_crontab(rel: str) -> bool:
    name = paths.name(rel)
    if not (name == "crontab" or name.endswith((".crontab", ".cron")) or _cron_d(rel)):
        return False
    return not any(seg in CODE_SKIP_DIRS for seg in paths.parent(rel).split("/"))


def _stem(rel: str) -> str:
    name = paths.name(rel)
    for ext in (".crontab", ".cron"):
        if name.endswith(ext) and len(name) > len(ext):
            return name[: -len(ext)]
    return name


def _field(text: str) -> bool:
    """Поле расписания: «*/5», «1-5», «0,30», «mon-fri»; имена не длиннее трёх букв, поле
    не начинается с «/» (так путь к программе полем не считается)."""
    if text[0] in "/,-":
        return False
    if not text.strip("0123456789*/,-"):
        return True  # частый случай без имён: проверка без разбора по буквам
    if not set(text) <= _FIELD_CHARS:
        return False
    words = "".join(ch if ch.isalpha() else " " for ch in text).split()
    return all(len(w) <= 3 for w in words)


def _entry(raw: str, system: bool) -> tuple[str, str] | None:
    """Расписание и команда строки или None, если строка не запись расписания."""
    line = raw.strip()
    if not line or line.startswith("#") or len(line) > _MAX_LINE:
        return None
    parts = line.split()
    head = parts[0]
    if head in _SPECIALS:
        schedule, rest = head, parts[1:]
    elif len(parts) >= 6 and all(_field(p) for p in parts[:5]):
        schedule, rest = " ".join(parts[:5]), parts[5:]
    else:
        return None  # MAILTO=, SHELL=, PATH= и прочий текст
    # Пользователь: всегда в cron.d и /etc/crontab, в остальных файлах — только root.
    if rest and (system or (rest[0] == "root" and len(rest) > 1)):
        rest = rest[1:]
    if not rest:
        return None
    return schedule, " ".join(rest)[:_MAX_TASK]


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    for rel in files.select(is_crontab):
        if files.skip_dev_code(rel):
            continue
        text = files.read(rel)
        if text is None:
            continue
        system = _cron_d(rel) or rel == "etc/crontab" or rel.endswith("/etc/crontab")
        entries: list[tuple[int, tuple[str, str]]] = []
        for number, raw in enumerate(text.splitlines(), start=1):
            item = _entry(raw, system)
            if item is not None:
                entries.append((number, item))
                if len(entries) > _MAX_ENTRIES:
                    break
        if len(entries) > _MAX_ENTRIES:
            files.refuse(rel)  # не crontab, а данные: файл считается непрочитанным
            continue
        stem = _stem(rel)
        for i, (number, (schedule, command)) in enumerate(entries, start=1):
            name = stem if len(entries) == 1 else f"{stem}-{i}"
            found.schedules.append(CodeSchedule(
                name=name, schedule=schedule, task=command, loc=Loc(rel, number), parser=NAME,
            ))
    return found
