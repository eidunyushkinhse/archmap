"""Файл настроек .NET appsettings.json (ТЗ §15 п. 16 Р1).

Читается appsettings.json в каталоге проекта (рядом с *.csproj), кроме каталогов тестов по
имени (clike.in_test_dir) и каталогов для разработки. appsettings.<Среда>.json не читается:
там значения сред, а не дефолты. Ключ с вложением — параметр «A:B:C», как его читает .NET;
значение — дефолт как написано (строка без кавычек, число, true или false), тип по виду
значения (string, int, float, bool); объект даёт ключи глубже, массив — значение одной
строкой с типом array; null — параметр без дефолта. Основание — строка ключа.

JSON читается так же, как его читает .NET: комментарии «//» и «/* */» и висячие запятые
допустимы. Разбор одним проходом по лексемам без регулярных выражений с возвратами. Файл
больше 1 МБ или глубже 50 уровней не читается и считается непрочитанным; файл с ошибкой
синтаксиса пропускается целиком. Запись идёт как CodeParam с from_file: с чтением того же
ключа в коде (dotnetenv) она сливается в один параметр (codefacts._merge).
"""

from __future__ import annotations

import json
import re

from archmap_scan import clike, codebase, paths
from archmap_scan.context import Context
from archmap_scan.model import CodeParam, Findings, Loc
from archmap_scan.walk import Files

NAME = "appsettings"
FILE_NAME = "appsettings.json"
MAX_BYTES = 1_000_000
MAX_DEPTH = 50

# Пробелы и комментарии строки между лексемами: шаблон без продолжения, поэтому жадное
# совпадение принимается сразу, без возвратов. Начало блочного комментария «/*» ищется
# отдельно (конец — str.find).
_SKIP = re.compile(r"(?:[ \t\r\n]+|//[^\n]*)*")
# Лексема: строка (без перевода строки внутри), знак, прочее (число, true, false, null).
_TOKEN = re.compile(
    r'(?P<str>"[^"\\\n]*(?:\\.[^"\\\n]*)*")|(?P<p>[{}\[\]:,])|(?P<atom>[^ \t\r\n{}\[\]:,"/]+)'
)
_INT = re.compile(r"-?(?:0|[1-9][0-9]*)")
_FLOAT = re.compile(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")


class BadJson(Exception):
    """Ошибка синтаксиса: файл пропускается."""


class TooDeep(Exception):
    """Вложенность больше MAX_DEPTH: файл непрочитан."""


_Token = tuple[str, int, int]


class _Reader:
    """Лексемы текста по порядку, без пробелов и комментариев, и номера строк."""

    def __init__(self, text: str) -> None:
        self.text = text
        self.pos = 0
        self.line = 1
        self._counted = 0  # до какой позиции посчитаны переводы строк
        self.out: list[tuple[str, int, str | None, str | None]] = []

    def line_at(self, pos: int) -> int:
        """Номер строки позиции pos (позиции идут по возрастанию: счёт с прошлой)."""
        self.line += self.text.count("\n", self._counted, pos)
        self._counted = pos
        return self.line

    def next(self) -> _Token:
        text = self.text
        pos = _SKIP.match(text, self.pos).end()  # type: ignore[union-attr]
        while text.startswith("/*", pos):
            close = text.find("*/", pos + 2)
            if close < 0:
                raise BadJson
            pos = _SKIP.match(text, close + 2).end()  # type: ignore[union-attr]
        m = _TOKEN.match(text, pos)
        if m is None:
            raise BadJson
        self.pos = m.end()
        return m.lastgroup or "", pos, self.pos

    def char(self, tok: _Token) -> str:
        return self.text[tok[1]] if tok[0] == "p" else ""

    def string(self, tok: _Token) -> str:
        raw = self.text[tok[1]:tok[2]]
        if "\\" not in raw:
            return raw[1:-1]
        try:
            value = json.loads(raw)
        except ValueError:
            return raw[1:-1]
        return value if isinstance(value, str) else raw[1:-1]

    # Разбор

    def document(self) -> None:
        if self.char(self.next()) != "{":
            raise BadJson
        self.obj([], 1)
        if self.text[self.pos:].strip():
            # За корнем только пробелы и комментарии.
            try:
                self.next()
            except BadJson:
                return
            raise BadJson

    def obj(self, path: list[str], depth: int) -> None:
        """Тело объекта после «{»: ключи пишутся параметрами."""
        while True:
            tok = self.next()
            if self.char(tok) == "}":
                return
            if tok[0] != "str":
                raise BadJson
            key = self.string(tok)
            line = self.line_at(tok[1])
            if self.char(self.next()) != ":":
                raise BadJson
            self.value([*path, key], line, self.next(), depth)
            sep = self.char(self.next())
            if sep == "}":
                return
            if sep != ",":
                raise BadJson

    def value(self, path: list[str], line: int, tok: _Token, depth: int) -> None:
        ch = self.char(tok)
        name = ":".join(path)
        if ch == "{":
            if depth >= MAX_DEPTH:
                raise TooDeep
            self.obj(path, depth + 1)
        elif ch == "[":
            self.out.append((name, line, self.render(tok, depth), "array"))
        elif tok[0] == "str":
            self.out.append((name, line, self.string(tok), "string"))
        elif tok[0] == "atom":
            atom = self.text[tok[1]:tok[2]]
            if atom in ("true", "false"):
                self.out.append((name, line, atom, "bool"))
            elif atom == "null":
                self.out.append((name, line, None, None))
            elif _INT.fullmatch(atom):
                self.out.append((name, line, atom, "int"))
            elif _FLOAT.fullmatch(atom):
                self.out.append((name, line, atom, "float"))
            else:
                raise BadJson
        else:
            raise BadJson

    def render(self, tok: _Token, depth: int) -> str:
        """Значение одной строкой: строки в кавычках как написаны, элементы через «, »."""
        ch = self.char(tok)
        if tok[0] in ("str", "atom"):
            return self.text[tok[1]:tok[2]]
        if ch not in ("[", "{"):
            raise BadJson
        if depth >= MAX_DEPTH:
            raise TooDeep
        close = "]" if ch == "[" else "}"
        parts: list[str] = []
        while True:
            item = self.next()
            if self.char(item) == close:
                break
            if ch == "{":
                if item[0] != "str" or self.char(self.next()) != ":":
                    raise BadJson
                key = self.text[item[1]:item[2]]
                parts.append(f"{key}: {self.render(self.next(), depth + 1)}")
            else:
                parts.append(self.render(item, depth + 1))
            sep = self.char(self.next())
            if sep == close:
                break
            if sep != ",":
                raise BadJson
        return ch + ", ".join(parts) + close


def read(text: str) -> list[tuple[str, int, str | None, str | None]]:
    """Параметры файла: (имя «A:B», строка ключа, дефолт, тип). Повтор ключа в файле
    даёт одну запись по последнему, как у .NET. BadJson — ошибка синтаксиса, TooDeep —
    вложенность больше предела."""
    reader = _Reader(text)
    reader.document()
    last: dict[str, tuple[str, int, str | None, str | None]] = {}
    for entry in reader.out:
        last.pop(entry[0], None)
        last[entry[0]] = entry
    return sorted(last.values(), key=lambda e: e[1])


def _is_project_file(files: Files, ctx: Context, rel: str) -> bool:
    """appsettings.json в каталоге с .csproj, не в каталоге тестов и не для разработки."""
    if paths.name(rel) != FILE_NAME or clike.in_test_dir(rel):
        return False
    folder = paths.parent(rel)
    pkgs = codebase.owner_packages(files, ctx, rel, codebase.DOTNET)
    if not any(p.kind == "csproj" and p.dir == folder for p in pkgs):
        return False
    return not files.skip_dev_code(rel)


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not codebase.stack_present(files, ctx, codebase.DOTNET):
        return found
    for rel in files.select(lambda p: paths.name(p) == FILE_NAME):
        if not _is_project_file(files, ctx, rel):
            continue
        text = files.read(rel)
        if text is None:
            continue
        if len(text.encode("utf-8", "replace")) > MAX_BYTES:
            files.refuse(rel)
            continue
        try:
            entries = read(text)
        except TooDeep:
            files.refuse(rel)
            continue
        except BadJson:
            continue
        for name, line, value, type_ in entries:
            found.code_params.append(CodeParam(
                name=name, loc=Loc(rel, line), parser=NAME, default=value,
                has_default=value is not None, type=type_, from_file=True,
            ))
    return found
