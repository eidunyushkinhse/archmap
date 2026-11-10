"""Файл настроек по умолчанию в формате hjson (ТЗ §15 п. 16 Р2).

Читается config/defaults.hjson или config/default.hjson пакета (каталог config/ лежит рядом
с манифестом сборки: у Lemmy config/defaults.hjson рядом с корневым Cargo.toml); config.hjson
и другие имена — настройки экземпляра, они не читаются. Параметр — ключ с вложением через
точку (database.pool_size), дефолт как написан (30, http://localhost:8080/ без кавычек), тип
по значению (string, int, float, bool; массив одной строкой с типом array; null без дефолта);
основание — строка ключа.

Подмножество hjson: комментарии «#», «//» и «/* */», ключи без кавычек и в кавычках, строки в
двойных и одинарных кавычках, многострочные '''…''', значения без кавычек до конца строки,
числа, true, false, null, вложенные {} и [], необязательные запятые, корень без скобок. Разбор
одним проходом по тексту: str.find и шаблоны без возвратов (класс знаков, строка в кавычках).
Пределы: файл 1 МБ, глубина 50, 5000 ключей; сверх — файл непрочитан с подсказкой, ошибка
синтаксиса — подсказка без записей. Записи идут как CodeParam с from_file.
"""

from __future__ import annotations

import json
import re

from archmap_scan import codebase, paths, texts
from archmap_scan.context import Context
from archmap_scan.model import CodeParam, Findings, Loc, unparsed_hint
from archmap_scan.walk import Files

NAME = "hjson"
FILE_NAMES = frozenset({"defaults.hjson", "default.hjson"})
MAX_BYTES = 1_000_000
MAX_DEPTH = 50
MAX_KEYS = 5000

_WS = re.compile(r"[ \t\r\n]*")
_KEY = re.compile(r"[^ \t\r\n{}\[\],:\"'#/]+")
_STRINGS = {
    '"': re.compile(r'"[^"\\\n]*(?:\\.[^"\\\n]*)*"'),
    "'": re.compile(r"'[^'\\\n]*(?:\\.[^'\\\n]*)*'"),
}
_LITERAL = re.compile(r"true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")
_INT = re.compile(r"-?(?:0|[1-9][0-9]*)")
# За литералом: пробелы и конец строки, запятая, скобка или комментарий.
_AFTER_LITERAL = re.compile(r"[ \t]*(?:\r?\n|$|[,}\]#]|//|/\*)")
# Быстрый проход по длинному массиву: отрезок без скобок, кавычек и начал комментариев.
_PLAIN = re.compile(r"[^\[\]{}\"'#/]+")
# Массив длиннее этого разбирается быстрым проходом: его дефолт длиннее 200 знаков и всё
# равно не пишется (secrets.safe_default), нужны только его конец и тип.
RENDER_LIMIT = 1000

Entry = tuple[str, int, str | None, str | None]


class BadHjson(Exception):
    """Ошибка синтаксиса: файл пропускается с подсказкой."""


class TooBig(Exception):
    """Глубже MAX_DEPTH или больше MAX_KEYS ключей: файл непрочитан."""


class _Reader:
    def __init__(self, text: str) -> None:
        self.text = text
        self.pos = 0
        self.line = 1
        self._counted = 0
        self.keys = 0
        self.out: list[Entry] = []

    def line_at(self, pos: int) -> int:
        self.line += self.text.count("\n", self._counted, pos)
        self._counted = pos
        return self.line

    def skip(self, commas: bool = False) -> None:
        """Пробелы, переводы строк и комментарии (и запятые, если commas)."""
        text = self.text
        while True:
            self.pos = _WS.match(text, self.pos).end()  # type: ignore[union-attr]
            if text.startswith("#", self.pos) or text.startswith("//", self.pos):
                eol = text.find("\n", self.pos)
                self.pos = len(text) if eol < 0 else eol
            elif text.startswith("/*", self.pos):
                close = text.find("*/", self.pos + 2)
                if close < 0:
                    raise BadHjson
                self.pos = close + 2
            elif commas and text.startswith(",", self.pos):
                self.pos += 1
            else:
                return

    def count_key(self) -> None:
        self.keys += 1
        if self.keys > MAX_KEYS:
            raise TooBig

    # Разбор

    def document(self) -> list[Entry]:
        self.skip()
        if self.text.startswith("{", self.pos):
            self.pos += 1
            self.members([], 1, braced=True)
            self.skip()
            if self.pos != len(self.text):
                raise BadHjson
        else:
            self.members([], 1, braced=False)
        return self.out

    def members(self, path: list[str], depth: int, braced: bool) -> None:
        text = self.text
        while True:
            self.skip(commas=True)
            if self.pos >= len(text):
                if braced:
                    raise BadHjson
                return
            if text[self.pos] == "}":
                if not braced:
                    raise BadHjson
                self.pos += 1
                return
            start = self.pos
            key = self.key()
            self.count_key()
            self.skip()
            if not text.startswith(":", self.pos):
                raise BadHjson
            self.pos += 1
            self.value([*path, key], self.line_at(start), depth)

    def key(self) -> str:
        ch = self.text[self.pos]
        if ch in _STRINGS:
            return self.quoted()
        m = _KEY.match(self.text, self.pos)
        if m is None:
            raise BadHjson
        self.pos = m.end()
        return m.group()

    def quoted(self) -> str:
        """Строка в кавычках с позиции pos: значение без кавычек."""
        text = self.text
        m = _STRINGS[text[self.pos]].match(text, self.pos)
        if m is None:
            raise BadHjson
        self.pos = m.end()
        raw = m.group()
        inner = raw[1:-1]
        if "\\" not in inner:
            return inner
        if raw[0] == "'":
            inner = inner.replace("\\'", "'").replace('"', '\\"')
        try:
            value = json.loads(f'"{inner}"')
        except ValueError:
            return raw[1:-1]
        return value if isinstance(value, str) else raw[1:-1]

    def multiline(self) -> str:
        """'''…''' с позиции pos: текст между кавычками."""
        close = self.text.find("'''", self.pos + 3)
        if close < 0:
            raise BadHjson
        value = self.text[self.pos + 3:close]
        self.pos = close + 3
        return value

    def scalar(self) -> tuple[str | None, str | None]:
        """Литерал (число, true, false, null) или строка без кавычек до конца строки."""
        text = self.text
        m = _LITERAL.match(text, self.pos)
        if m is not None and _AFTER_LITERAL.match(text, m.end()):
            self.pos = m.end()
            word = m.group()
            if word == "null":
                return None, None
            if word in ("true", "false"):
                return word, "bool"
            return word, "int" if _INT.fullmatch(word) else "float"
        eol = text.find("\n", self.pos)
        end = len(text) if eol < 0 else eol
        value = text[self.pos:end].strip()
        self.pos = end
        if not value:
            raise BadHjson
        return value, "string"

    def value(self, path: list[str], line: int, depth: int) -> None:
        self.skip()
        text = self.text
        if self.pos >= len(text):
            raise BadHjson
        ch = text[self.pos]
        name = ".".join(path)
        if ch == "{":
            if depth >= MAX_DEPTH:
                raise TooBig
            self.pos += 1
            self.members(path, depth + 1, braced=True)
        elif ch == "[":
            self.out.append((name, line, self.array(depth), "array"))
        elif text.startswith("'''", self.pos):
            self.out.append((name, line, self.multiline(), "string"))
        elif ch in _STRINGS:
            self.out.append((name, line, self.quoted(), "string"))
        elif ch in "]},:":
            raise BadHjson
        else:
            value, type_ = self.scalar()
            self.out.append((name, line, value, type_))

    def array(self, depth: int) -> str:
        """Массив с позиции pos: короткий одной строкой (render), длинный — быстрым
        проходом до парной скобки, текст как есть."""
        start = self.pos
        end = self.skip_array(depth)
        if end - start <= RENDER_LIMIT:
            return self.render(depth)
        self.pos = end
        return self.text[start:end]

    def skip_array(self, depth: int) -> int:
        """Конец массива с позиции pos (после парной скобки) без разбора значений: строки,
        комментарии и вложенность скобок. Строка без кавычек со скобкой внутри в длинном
        массиве сбивает счёт (тогда массив читается до другой скобки или BadHjson)."""
        text = self.text
        i = self.pos + 1
        level = 1
        while level:
            m = _PLAIN.match(text, i)
            if m is not None:
                i = m.end()
            if i >= len(text):
                raise BadHjson
            ch = text[i]
            if ch in "[{":
                level += 1
                if depth + level - 1 >= MAX_DEPTH:
                    raise TooBig
                i += 1
            elif ch in "]}":
                level -= 1
                i += 1
            elif text.startswith("'''", i):
                close = text.find("'''", i + 3)
                if close < 0:
                    raise BadHjson
                i = close + 3
            elif ch in _STRINGS:
                quoted = _STRINGS[ch].match(text, i)
                if quoted is None:
                    raise BadHjson
                i = quoted.end()
            elif ch == "#" or text.startswith("//", i):
                eol = text.find("\n", i)
                i = len(text) if eol < 0 else eol
            elif text.startswith("/*", i):
                close = text.find("*/", i + 2)
                if close < 0:
                    raise BadHjson
                i = close + 2
            else:  # одиночная «/»
                i += 1
        return i

    def render(self, depth: int) -> str:
        """Массив или объект с позиции pos одной строкой: строки в кавычках как написаны,
        элементы через «, »."""
        if depth >= MAX_DEPTH:
            raise TooBig
        text = self.text
        ch = text[self.pos]
        close = "]" if ch == "[" else "}"
        self.pos += 1
        parts: list[str] = []
        while True:
            self.skip(commas=True)
            if self.pos >= len(text):
                raise BadHjson
            if text[self.pos] == close:
                self.pos += 1
                return ch + ", ".join(parts) + close
            if ch == "{":
                start = self.pos
                self.key()
                self.count_key()
                key = text[start:self.pos]
                self.skip()
                if not text.startswith(":", self.pos):
                    raise BadHjson
                self.pos += 1
                parts.append(f"{key}: {self.item(depth)}")
            else:
                parts.append(self.item(depth))

    def item(self, depth: int) -> str:
        """Элемент массива или значение в объекте внутри массива как написано."""
        self.skip()
        text = self.text
        if self.pos >= len(text):
            raise BadHjson
        ch = text[self.pos]
        if ch in "[{":
            return self.render(depth + 1)
        start = self.pos
        if text.startswith("'''", self.pos):
            self.multiline()
            return text[start:self.pos]
        if ch in _STRINGS:
            self.quoted()
            return text[start:self.pos]
        if ch in "]},:":
            raise BadHjson
        value, _type = self.scalar()
        return "null" if value is None else value


def read(text: str) -> list[Entry]:
    """Параметры файла: (имя через точку, строка ключа, дефолт, тип). Повтор ключа даёт
    одну запись по последнему. BadHjson — ошибка синтаксиса, TooBig — сверх пределов."""
    last: dict[str, Entry] = {}
    for entry in _Reader(text).document():
        last.pop(entry[0], None)
        last[entry[0]] = entry
    return sorted(last.values(), key=lambda e: e[1])


def _is_defaults(files: Files, ctx: Context, rel: str) -> bool:
    """config/defaults.hjson или config/default.hjson рядом с манифестом сборки пакета."""
    folder = paths.parent(rel)
    if paths.name(rel) not in FILE_NAMES or paths.name(folder) != "config":
        return False
    package = paths.parent(folder)
    return any(p.dir == package for p in codebase.packages(files, ctx))


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    for rel in files.select(lambda p: paths.name(p) in FILE_NAMES):
        if not _is_defaults(files, ctx, rel):
            continue
        text = files.read(rel)
        if text is None:
            continue
        if len(text.encode("utf-8", "replace")) > MAX_BYTES:
            files.refuse(rel)
            found.hints.append(unparsed_hint(rel, texts.REASON_BAD_HJSON))
            continue
        try:
            entries = read(text)
        except TooBig:
            files.refuse(rel)
            found.hints.append(unparsed_hint(rel, texts.REASON_BAD_HJSON))
            continue
        except (BadHjson, RecursionError):
            found.hints.append(unparsed_hint(rel, texts.REASON_BAD_HJSON))
            continue
        for name, line, value, type_ in entries:
            found.code_params.append(CodeParam(
                name=name, loc=Loc(rel, line), parser=NAME, default=value,
                has_default=value is not None, type=type_, from_file=True,
            ))
    return found
