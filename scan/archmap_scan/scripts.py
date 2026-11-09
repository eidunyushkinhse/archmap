"""Команды скриптов оболочки репозитория, которые запускает единица (ТЗ §15 п. 16 П1).

Команда единицы (compose, k8s, Procfile, supervisor, systemd, CMD Dockerfile), чья программа —
относительный путь к скрипту репозитория (./bin/x, bin/x, scripts/x.sh), раскрывается
чтением этого файла как текста: первые 64 КБ, ничего не исполняется. Путь ищется от
контекста сборки единицы, от каталога файла манифеста и от корня репозитория: первый
существующий в обходе. Скрипт оболочки — файл без расширения или с .sh, .bash, у которого
первая строка #! (если есть) называет оболочку; Python и Node.js так не читаются.

Простые команды скрипта (части строк между ;, &&, ||, |, &, переводами строк и скобками,
после exec, внутри if … fi, case … esac, while и for … done) становятся дополнительными
командами единицы (Unit.script_commands). Не команды: комментарии, присваивания X=… без
программы, заголовки for, case, select и function, определения функций, тела heredoc,
встроенные команды оболочки и утилиты, которые процессом не бывают (echo, test, rm,
export и другие из _NOT_PROCESSES): так слова справки в echo не меняют роль единицы.
Строка в кавычках, `…` и $(…) разделителей не содержит. Скрипт, который зовёт другой скрипт
репозитория, раскрывается ещё на один шаг (глубина два), свой же файл второй раз не читается.

Команды скриптов не записи вывода: по ним codefacts выбирает владельца записей кода
(sidekiq, веб-сервер, celery beat), а assemble — роль единицы по словам. Разбор одним
проходом по символам, без регулярных выражений с возвратами.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

from archmap_scan import paths, vocab
from archmap_scan.model import Findings
from archmap_scan.walk import Files

MAX_SCRIPT_BYTES = 64 * 1024
MAX_DEPTH = 2
# Сколько простых команд берётся с одного скрипта и сколько всего у одной единицы: предел
# против враждебного входа (64 КБ «a;» дают 32 тысячи команд), настоящие скрипты меньше.
MAX_SCRIPT_COMMANDS = 2000
MAX_UNIT_COMMANDS = 5000

_SHELL_EXTS = (".sh", ".bash")
_SHELLS = frozenset({"sh", "bash", "dash", "zsh", "ash", "ksh"})
# Слова оболочки перед командой: снимаются, команда идёт дальше.
_LEAD = frozenset({
    "if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "fi", "done", "esac",
    "time", "in", "coproc",
})
# Заголовки, после которых в той же части команды нет.
_HEADERS = frozenset({"for", "case", "select", "function"})
# Встроенные команды оболочки и утилиты, которые процессом единицы не бывают.
_NOT_PROCESSES = frozenset({
    "echo", "printf", "cat", "test", "[", "[[", "]", "]]", "rm", "mkdir", "rmdir", "cp", "mv",
    "ln", "chmod", "chown", "touch", "export", "local", "declare", "typeset", "readonly", "set",
    "unset", "trap", "source", ".", "cd", "pushd", "popd", "sleep", "wait", "kill", "exit",
    "return", "shift", "read", "true", "false", ":", "umask", "ulimit", "sed", "grep", "awk",
    "tr", "cut", "head", "tail", "sort", "uniq", "wc", "xargs", "find", "date", "basename",
    "dirname", "mktemp", "tee", "curl", "wget", "which", "command", "type", "hash", "alias",
    "eval", "getopts", "let", "break", "continue", "printenv", "id", "whoami", "ls", "pwd",
    "stat", "realpath", "readlink", "envsubst", "jq", "nc", "pgrep", "pkill", "ps", "lsof",
    "fuser", "chgrp", "install", "tar", "gzip", "gunzip", "unzip", "base64", "sha256sum",
})
# Присваивания перед программой: значение словом, в кавычках или массивом (X=(…)).
_ASSIGNMENTS = re.compile(
    r"(?:[A-Za-z_][A-Za-z0-9_]{0,200}(?:\[[^\]\n]{0,200}\])?\+?="
    r"(?:'[^']*'|\"(?:\\.|[^\"\\])*\"|\([^)]*\)|[^\s'\"(])*\s*)+"
)
_HEREDOC = re.compile(r"<<-?[ \t]*(['\"]?)([A-Za-z_][A-Za-z0-9_]{0,63})\1")


def _function_def(text: str, i: int) -> int | None:
    """Позиция после «()» определения функции, если с позиции i стоят «(» и «)»."""
    j = i + 1
    while j < len(text) and text[j] in " \t":
        j += 1
    return j + 1 if j < len(text) and text[j] == ")" else None


def _skip_heredocs(text: str, pos: int, delims: list[str]) -> int:
    """Позиция после тел heredoc, которые начинаются со строки pos (по порядку)."""
    for delim in delims:
        while pos < len(text):
            end = text.find("\n", pos)
            line = text[pos:] if end == -1 else text[pos:end]
            pos = len(text) if end == -1 else end + 1
            if line.strip() == delim:
                break
    return pos


# Символы, на которых меняется состояние разбора; остальное копируется кусками.
_SPECIAL = re.compile(r"[\\'\"`#$()<\n;&|]")
_SPECIAL_NESTED = re.compile(r"[\\'\"`#()\n]")
_SPECIAL_QUOTED = {"\"": re.compile(r"[\\\"]"), "`": re.compile(r"[\\`]")}
# Подряд идущие разделители, экранированные символы, «$», «(» и «<» берутся одним шагом:
# иначе враждебный текст из одних «;» или «(» стоил бы шага цикла на символ.
_SEPARATORS = re.compile(r"[;|&()\n \t]+")
_SEPARATORS_LINE = re.compile(r"[;|&() \t]+")  # до перевода строки: за ним тело heredoc
_ESCAPES = re.compile(r"(?:\\[\s\S])+")
_RUNS = {"$": re.compile(r"\$+"), "(": re.compile(r"\(+"), "<": re.compile(r"<+")}


def _run(text: str, i: int) -> str:
    """Подряд идущие одинаковые символы с позиции i («$$$», «(((», «<<»)."""
    hit = _RUNS[text[i]].match(text, i)
    return hit.group() if hit is not None else text[i]


def _parts(text: str) -> Iterable[str]:
    """Непустые части текста между разделителями оболочки вне кавычек и $(…)."""
    buf: list[str] = []
    quote: str | None = None
    depth = 0
    heredocs: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        if quote == "'":
            end = text.find("'", i)
            end = n - 1 if end == -1 else end
            buf.append(text[i:end + 1])
            quote, i = None, end + 1
            continue
        pattern = _SPECIAL_QUOTED[quote] if quote else _SPECIAL_NESTED if depth else _SPECIAL
        hit = pattern.search(text, i)
        if hit is None:
            buf.append(text[i:])
            break
        if hit.start() > i:
            buf.append(text[i:hit.start()])
        i = hit.start()
        c = text[i]
        if c == "\\":
            # Экранированные символы, перевод строки после «\» — продолжение строки.
            escaped = _ESCAPES.match(text, i)
            chunk = escaped.group() if escaped is not None else c
            buf.append(chunk.replace("\\\n", " "))
            i += len(chunk)
            continue
        if quote is not None:
            buf.append(c)
            quote = None  # закрывающая кавычка: другого в шаблоне кавычек нет
            i += 1
            continue
        if c in "'\"`":
            quote = c
            buf.append(c)
            i += 1
            continue
        if c == "#" and (not buf or buf[-1][-1:] in (" ", "\t")):
            end = text.find("\n", i)
            i = n if end == -1 else end
            continue
        if depth:
            chunk = _run(text, i) if c == "(" else c
            depth += len(chunk) if c == "(" else -1 if c == ")" else 0
            buf.append(" " if c == "\n" else chunk)
            i += len(chunk)
            continue
        if c in "$<":
            chunk = _run(text, i)
            i += len(chunk)
            if c == "$" and text.startswith("(", i):
                depth = 1  # $(…): подстановка команды, разделителей внутри нет
                buf.append(chunk + "(")
                i += 1
                continue
            doc = _HEREDOC.match(text, i - 2) if c == "<" and len(chunk) == 2 else None
            if doc is not None:
                heredocs.append(doc.group(2))
                buf.append(doc.group())
                i = doc.end()
            else:
                buf.append(chunk)
            continue
        if c == "&" and ((buf and buf[-1][-1:] in ("<", ">")) or text.startswith("&>", i)):
            buf.append(c)  # перенаправление >&2, &>файл
            i += 1
            continue
        if c == "(" and buf and buf[-1][-1:] == "=":
            depth = 1  # массив X=(…) и X+=(…): часть присваивания
            buf.append(c)
            i += 1
            continue
        if c == "(" and "".join(buf).strip():
            after = _function_def(text, i)
            if after is not None:
                buf = []  # имя() { … }: определение функции, не команда
                i = after
                continue
        if buf:
            yield "".join(buf)
            buf = []
        if c == "\n" and heredocs:
            i = _skip_heredocs(text, i + 1, heredocs)
            heredocs = []
            continue
        # Разделитель и все разделители за ним (; & | ( ) и переводы строк): пустых частей
        # между ними нет. При открытом heredoc — только до перевода строки.
        seps = (_SEPARATORS_LINE if heredocs else _SEPARATORS).match(text, i)
        i = seps.end() if seps is not None and seps.end() > i else i + 1
    if buf:
        yield "".join(buf)


def _command(part: str) -> str | None:
    """Простая команда части или None: ключевые слова и присваивания перед программой
    (X=$Y celery …) сняты, не команды отброшены. Слова присваиваний в команду не идут:
    CELERY_WORKER_QUEUES=… у веб-сервера не делает его воркером."""
    tokens = part.split()
    while tokens and tokens[0] in _LEAD:
        tokens.pop(0)
    rest = " ".join(tokens)
    assigns = _ASSIGNMENTS.match(rest)
    tokens = rest[assigns.end():].split() if assigns is not None else tokens
    if not tokens or tokens[0] in _HEADERS or tokens[0][0] in "<>":
        return None
    text = " ".join(tokens)
    program = vocab.command_program(text)
    if program is None or not (program[0].isalnum() or program[0] in "._/"):
        return None
    return None if program in _NOT_PROCESSES else text


def simple_commands(text: str, limit: int = MAX_SCRIPT_COMMANDS) -> list[str]:
    """Простые команды текста оболочки по порядку, не больше limit."""
    out: list[str] = []
    for part in _parts(text):
        cmd = _command(part)
        if cmd is not None:
            out.append(cmd)
            if len(out) >= limit:
                break
    return out


def _is_shell(rel: str, text: str) -> bool:
    name = paths.name(rel)
    if "." in name.lstrip(".") and not name.endswith(_SHELL_EXTS):
        return False
    if not text.startswith("#!"):
        return True
    first = text[2:text.find("\n") if "\n" in text else len(text)].split()
    words = [paths.name(w) for w in first[:3]]
    return any(w in _SHELLS for w in words)


def _script(command: str, bases: tuple[str, ...], files: Files) -> str | None:
    """Скрипт репозитория, который запускает простая команда: путь от первой базы, где он
    есть в обходе, иначе None."""
    token = vocab.command_path(command)
    if token is None or token.startswith(("/", "~")) or "/" not in token or "://" in token:
        return None
    for base in bases:
        rel = paths.join(base, token)
        if rel and files.has_file(rel):
            return rel
    return None


def expand(
    command: str | None, bases: tuple[str, ...], files: Files, cache: dict[str, list[str]],
) -> list[str]:
    """Простые команды скриптов, которые запускает command, до глубины MAX_DEPTH. cache —
    команды уже прочитанных скриптов по пути (общий на запуск)."""
    if not command:
        return []
    out: list[str] = []
    seen: set[str] = set()
    frontier = simple_commands(command)
    for _depth in range(MAX_DEPTH):
        found: list[str] = []
        for part in frontier:
            rel = _script(part, bases, files)
            if rel is None or rel in seen:
                continue
            seen.add(rel)
            if rel not in cache:
                text = files.head(rel, MAX_SCRIPT_BYTES)
                cache[rel] = simple_commands(text) if text and _is_shell(rel, text) else []
            room = MAX_UNIT_COMMANDS - len(out)
            out.extend(cache[rel][:room])
            found.extend(cache[rel][:room])
            if len(out) >= MAX_UNIT_COMMANDS:
                return out
        frontier = found
    return out


def _bases(*dirs: str | None) -> tuple[str, ...]:
    return tuple(dict.fromkeys(d for d in (*dirs, "") if d is not None))


def attach(findings: Findings, files: Files) -> None:
    """Команды скриптов всем единицам и Dockerfile находок (после всех разборщиков)."""
    cache: dict[str, list[str]] = {}
    for unit in [*findings.units, *findings.build_units]:
        unit.script_commands = expand(
            unit.command, _bases(unit.build_dir, paths.parent(unit.loc.path)), files, cache,
        )
    for d in findings.dockerfiles:
        d.script_commands = expand(d.command, _bases(d.dir), files, cache)
