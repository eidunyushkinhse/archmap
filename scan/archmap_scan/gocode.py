"""Помощники разборщиков кода Go на маске (codetext.py): тело по парным скобкам,
определения функций с параметрами и вызовы функций по имени (ТЗ §15 п. 3: префикс группы
через параметр функции регистрации). Выражения начинаются с литерала («func», «(» в
перевёрнутой маске) и не перебирают с возвратами; списки и тела ограничены по длине.
"""

from __future__ import annotations

import re
from collections import deque
from collections.abc import Collection
from dataclasses import dataclass

MAX_SPAN = 200_000  # самое длинное тело функции или замыкания, которое просматривается
MAX_LIST = 2000  # самый длинный список параметров или аргументов в скобках
_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,99}")
# Определение: func, необязательный получатель метода, имя, параметры типа, «(».
_DEF = re.compile(
    r"func[ \t]*(?:\([^()\n]{0,300}\)[ \t]*)?([A-Za-z_][A-Za-z0-9_]{0,99})[ \t]*"
    r"(?:\[[^\[\]\n]{0,500}\][ \t]*)?\("
)
# Вызов в перевёрнутой маске: «(», пробелы, имя задом наперёд.
_CALLEE = re.compile(r"\([ \t]{0,50}([A-Za-z0-9_]{1,100})")
# Скобки тела и знаки списка: разбор шагает от знака к знаку, а не по каждому символу.
_BRACE = re.compile(r"[{}]")
_LIST = re.compile(r"[()\[\]{},]")


@dataclass(frozen=True)
class Func:
    """Функция с телом: имя, имена параметров по позициям («» — без имени), позиция
    имени и тело (позиции «{» и парной «}»)."""

    name: str
    params: tuple[str, ...]
    at: int
    start: int
    end: int


def _ident_char(ch: str) -> bool:
    return ch.isalnum() or ch == "_"


def body(mask: str, start: int) -> tuple[int, int] | None:
    """Тело функции: позиции «{» и парной «}» от start."""
    open_at = mask.find("{", start, start + 500)
    if open_at == -1:
        return None
    depth = 0
    for m in _BRACE.finditer(mask, open_at, min(len(mask), open_at + MAX_SPAN)):
        if m.group() == "{":
            depth += 1
        else:
            depth -= 1
            if depth == 0:
                return open_at, m.start()
    return None


def split_list(mask: str, start: int) -> tuple[list[str], int] | None:
    """Части списка в скобках по запятым верхнего уровня (от позиции после «(») и позиция
    парной «)»; None — скобка не закрылась в пределах MAX_LIST."""
    out: list[str] = []
    depth = 0
    piece = start
    for m in _LIST.finditer(mask, start, min(len(mask), start + MAX_LIST)):
        ch, i = m.group(), m.start()
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            if depth == 0:
                last = mask[piece:i].strip()
                if last or out:
                    out.append(last)
                return out, i
            depth -= 1
        elif ch == "," and depth == 0:
            out.append(mask[piece:i].strip())
            piece = i + 1
    return None


def _param_name(piece: str) -> str:
    """Имя параметра: «r chi.Router» → r, «a» (a, b T) → a; без имени («chi.Router») — «»."""
    m = _IDENT.match(piece)
    if m is None or (m.end() < len(piece) and piece[m.end()] not in " \t\r\n"):
        return ""
    return m.group()


def _definitions(mask: str) -> list[re.Match[str]]:
    return [
        m for m in _DEF.finditer(mask)
        if not (m.start() and _ident_char(mask[m.start() - 1]))
    ]


def declared(mask: str) -> list[tuple[str, int]]:
    """Имена определённых в файле функций и методов с позициями имён (без разбора тел)."""
    return [(m.group(1), m.start(1)) for m in _definitions(mask)]


def functions(mask: str) -> list[Func]:
    """Функции и методы файла с телом, по порядку. Тело начинается на строке закрывающей
    скобки параметров (так пишет gofmt); функция без тела (объявление) пропускается.
    Именованные функции в Go не вкладываются, поэтому следующее определение ищется после
    тела предыдущего (или после окна, в котором не закрылись его скобки): каждый знак
    маски просматривается разборщиком скобок не больше одного раза на окно."""
    out: list[Func] = []
    resume = 0
    for m in _definitions(mask):
        if m.start() < resume:
            continue
        parts = split_list(mask, m.end())
        if parts is None:
            resume = m.end() + MAX_LIST
            continue
        pieces, close = parts
        open_at = mask.find("{", close + 1, close + 501)
        if open_at == -1 or "\n" in mask[close:open_at]:
            resume = close + 1
            continue
        span = body(mask, open_at)
        if span is None:
            resume = open_at + MAX_SPAN
            continue
        resume = span[1]
        out.append(Func(m.group(1), tuple(_param_name(p) for p in pieces), m.start(1), *span))
    return out


def calls(
    mask: str, names: Collection[str], skip: Collection[int], budget: int,
) -> list[tuple[str, int, list[str]]]:
    """Вызовы «имя(» и «x.имя(» для имён из names по порядку в файле: (имя, позиция
    имени, аргументы). skip — позиции имён в определениях; budget — сколько первых
    вызовов одного имени разбирается (разбор аргументов ограничен MAX_LIST, поэтому
    ограничено и число попыток)."""
    out: list[tuple[str, int, list[str]]] = []
    if not names:
        return out
    rev = mask[::-1]
    size = len(mask)
    # Перевёрнутая маска идёт с конца файла: у каждого имени держатся последние budget
    # найденных, то есть первые в файле (память не растёт на враждебном входе).
    found: dict[str, deque[tuple[int, int]]] = {n: deque(maxlen=budget) for n in names}
    for m in _CALLEE.finditer(rev):
        name = m.group(1)[::-1]
        if name not in found:
            continue
        after = m.end(1)  # в перевёрнутой маске — знак перед именем
        prev = rev[after] if after < size else ""
        if prev and _ident_char(prev):
            continue  # имя длиннее найденного куска
        if prev == "." and not (after + 1 < size and _ident_char(rev[after + 1])):
            continue
        at = size - after
        if at not in skip:
            found[name].append((at, size - m.start()))  # позиция имени и после «(»
    # Окна аргументов вложенных вызовов перекрываются: просмотр скобок за файл ограничен
    # несколькими длинами маски, дальше вызовы не разбираются (запись тогда как прежде).
    left = 4 * size + MAX_LIST
    for at, name, args in sorted((at, n, a) for n, q in found.items() for at, a in q):
        parts = split_list(mask, args)
        left -= parts[1] + 1 - args if parts is not None else min(MAX_LIST, size - args)
        if left < 0:
            break
        if parts is not None:
            out.append((name, at, parts[0]))
    return out
