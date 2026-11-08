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
    имени и тело (позиции «{» и парной «}»). types — типы параметров по позициям
    (у «a, b int» тип второго и у первого), method — метод с получателем."""

    name: str
    params: tuple[str, ...]
    at: int
    start: int
    end: int
    types: tuple[str, ...] = ()
    method: bool = False


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


def _stripped(mask: str, start: int, end: int) -> tuple[int, int]:
    """Позиции куска без пробелов и переводов строк по краям."""
    while start < end and mask[start].isspace():
        start += 1
    while end > start and mask[end - 1].isspace():
        end -= 1
    return start, end


def split_spans(mask: str, start: int) -> tuple[list[tuple[int, int]], int] | None:
    """Позиции частей списка в скобках по запятым верхнего уровня (от позиции после «(»,
    без пробелов по краям) и позиция парной «)»; None — скобка не закрылась в пределах
    MAX_LIST."""
    out: list[tuple[int, int]] = []
    depth = 0
    piece = start
    for m in _LIST.finditer(mask, start, min(len(mask), start + MAX_LIST)):
        ch, i = m.group(), m.start()
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            if depth == 0:
                last = _stripped(mask, piece, i)
                if last[1] > last[0] or out:
                    out.append(last)
                return out, i
            depth -= 1
        elif ch == "," and depth == 0:
            out.append(_stripped(mask, piece, i))
            piece = i + 1
    return None


def split_list(mask: str, start: int) -> tuple[list[str], int] | None:
    """Части списка в скобках по запятым верхнего уровня (от позиции после «(») и позиция
    парной «)»; None — скобка не закрылась в пределах MAX_LIST."""
    parts = split_spans(mask, start)
    if parts is None:
        return None
    spans, close = parts
    return [mask[a:b] for a, b in spans], close


def _param_name(piece: str) -> str:
    """Имя параметра: «r chi.Router» → r, «a» (a, b T) → a; без имени («chi.Router») — «»."""
    m = _IDENT.match(piece)
    if m is None or (m.end() < len(piece) and piece[m.end()] not in " \t\r\n"):
        return ""
    return m.group()


def _param_types(pieces: list[str]) -> tuple[str, ...]:
    """Типы параметров по позициям: «a, b int» — у обоих int (тип стоит у последнего в
    группе); у части без имени тип — она сама."""
    own: list[str] = []
    for piece in pieces:
        name = _param_name(piece)
        own.append(piece[len(name):].strip() if name else piece.strip())
    out: list[str] = []
    later = ""
    for kind in reversed(own):
        later = kind or later
        out.append(later)
    return tuple(reversed(out))


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
        out.append(Func(
            m.group(1), tuple(_param_name(p) for p in pieces), m.start(1), *span,
            types=_param_types(pieces), method=mask[m.start() + 4:m.start(1)].strip() != "",
        ))
    return out


def calls(
    mask: str, names: Collection[str], skip: Collection[int], budget: int,
) -> list[tuple[str, int, list[str]]]:
    """Вызовы «имя(» и «x.имя(» для имён из names по порядку в файле: (имя, позиция
    имени, аргументы). skip — позиции имён в определениях; budget — сколько первых
    вызовов одного имени разбирается (разбор аргументов ограничен MAX_LIST, поэтому
    ограничено и число попыток)."""
    return [
        (name, at, [mask[a:b] for a, b in spans])
        for name, at, spans in call_spans(mask, names, skip, budget)
    ]


def call_spans(
    mask: str, names: Collection[str], skip: Collection[int], budget: int,
) -> list[tuple[str, int, list[tuple[int, int]]]]:
    """Как calls, но аргументы — позициями в маске (значение литерала берётся из текста)."""
    out: list[tuple[str, int, list[tuple[int, int]]]] = []
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
        parts = split_spans(mask, args)
        left -= parts[1] + 1 - args if parts is not None else min(MAX_LIST, size - args)
        if left < 0:
            break
        if parts is not None:
            out.append((name, at, parts[0]))
    return out


# Импорты, имя пакета и строковые константы файла (ТЗ §15 п. 14 Е1: обёртки чтения окружения
# и имя параметра через константу). Выражения начинаются с начала строки и литерала.
_IMPORT_ONE = re.compile(
    r'^import[ \t]+(?:([A-Za-z_.][A-Za-z0-9_]{0,99})[ \t]+)?("[ ]{0,1000}")', re.MULTILINE,
)
_IMPORT_SPEC = re.compile(
    r'^[ \t]*(?:([A-Za-z_.][A-Za-z0-9_]{0,99})[ \t]+)?("[ ]{0,1000}")', re.MULTILINE,
)
_PACKAGE = re.compile(r"^package[ \t]+([A-Za-z_][A-Za-z0-9_]{0,99})", re.MULTILINE)
_BLOCK = {
    "import": re.compile(r"^import[ \t]*\(", re.MULTILINE),
    "decl": re.compile(r"^(?:const|var)[ \t]*\(", re.MULTILINE),
}
# Объявление строковой константы или переменной: «Имя [Тип] = "литерал"» до конца строки
# (комментарий в маске уже пробелы). Склейка и выражение константой не считаются.
_VALUE = r'[ \t]*=[ \t]*("[ ]{0,10000}"|`[ \n]{0,10000}`)[ \t\r]*$'
_DECL_ONE = re.compile(
    r"^(?:const|var)[ \t]+([A-Za-z_][A-Za-z0-9_]{0,99})(?:[ \t]+[A-Za-z_][A-Za-z0-9_.]{0,99})?"
    + _VALUE, re.MULTILINE,
)
_DECL_SPEC = re.compile(
    r"^[ \t]*([A-Za-z_][A-Za-z0-9_]{0,99})(?:[ \t]+[A-Za-z_][A-Za-z0-9_.]{0,99})?" + _VALUE,
    re.MULTILINE,
)
_PAREN = re.compile(r"[()]")


def _block_end(mask: str, open_at: int) -> int:
    """Позиция «)», парной к «(» в open_at, в пределах MAX_SPAN; не закрылась — граница окна."""
    depth = 0
    stop = min(len(mask), open_at + MAX_SPAN)
    for m in _PAREN.finditer(mask, open_at, stop):
        depth += 1 if m.group() == "(" else -1
        if depth == 0:
            return m.start()
    return stop


def _blocks(mask: str, kind: str) -> list[tuple[int, int]]:
    """Тела блоков «import (…)» или «const (…)» и «var (…)» верхнего уровня."""
    out: list[tuple[int, int]] = []
    resume = 0
    for m in _BLOCK[kind].finditer(mask):
        if m.start() < resume:
            continue
        end = _block_end(mask, m.end() - 1)
        out.append((m.end(), end))
        resume = end
    return out


def imports(text: str, mask: str) -> list[tuple[str | None, str]]:
    """Импорты файла: (псевдоним или None, путь пакета) по порядку."""
    out: list[tuple[str | None, str]] = []
    for m in _IMPORT_ONE.finditer(mask):
        out.append((m.group(1), text[m.start(2) + 1:m.end(2) - 1]))
    for start, end in _blocks(mask, "import"):
        for m in _IMPORT_SPEC.finditer(mask, start, end):
            out.append((m.group(1), text[m.start(2) + 1:m.end(2) - 1]))
    return out


def package_name(mask: str) -> str | None:
    """Имя пакета из строки «package имя»."""
    m = _PACKAGE.search(mask)
    return m.group(1) if m else None


def string_constants(text: str, mask: str) -> dict[str, tuple[str, int]]:
    """Строковые константы и переменные верхнего уровня: имя → (литерал, позиция имени).
    Объявления внутри функций сюда не попадают: блоки const и var ищутся с начала строки, а
    одиночное объявление — словом const или var в начале строки (так пишет gofmt)."""
    out: dict[str, tuple[str, int]] = {}
    spans = [(m, m.start(1)) for m in _DECL_ONE.finditer(mask)]
    for start, end in _blocks(mask, "decl"):
        spans += [(m, m.start(1)) for m in _DECL_SPEC.finditer(mask, start, end)]
    for m, at in sorted(spans, key=lambda item: item[1]):
        out.setdefault(m.group(1), (text[m.start(2) + 1:m.end(2) - 1], at))
    return out
