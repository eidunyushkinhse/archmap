"""Текст кода JavaScript/TypeScript, Go, C# и Java для разборщиков на регулярных выражениях
(ТЗ §6.2).

Маска — текст той же длины, где комментарии заменены пробелами, а содержимое строк —
пробелами между сохранёнными кавычками (переводы строк сохраняются). Регулярные выражения
ищут конструкции по маске, а значение литерала берут из исходного текста по тем же
позициям: строка в комментарии не находится, кавычки и скобки внутри строк не мешают.

Токенизатор — одно регулярное выражение, у каждой ветки которого есть успешный исход
(строка без закрывающей кавычки кончается на конце строки, комментарий — на конце
файла), поэтому разбор линейный и на враждебном входе. Все выражения разборщиков
начинаются с литерала («.», «@», «process.env») и не перебирают с возвратами.
"""

from __future__ import annotations

import re
from bisect import bisect_right

from archmap_scan import texts
from archmap_scan.walk import Files

JS, GO, CS, JAVA = "js", "go", "cs", "java"

_C_COMMENTS = r"//[^\n]*|/\*[\s\S]*?(?:\*/|\Z)"
# Подстановка интерполированной строки C#: «{выражение}», строки внутри без вложенных скобок.
_CS_HOLE = r'\{(?:[^{}"\n]|"(?:[^"\\\n]|\\.)*")*\}'
_CS_PIECES = re.compile(r"\{\{|(?P<hole>" + _CS_HOLE + r")|[^{]+|\{")

_TOKENS = {
    JS: re.compile(
        r"//[^\n]*"
        r"|/\*[\s\S]*?(?:\*/|\Z)"
        r"|'(?:[^'\\\n]|\\[\s\S])*'?"
        r'|"(?:[^"\\\n]|\\[\s\S])*"?'
        r"|`(?:[^`\\]|\\[\s\S])*`?"
    ),
    GO: re.compile(
        r"//[^\n]*"
        r"|/\*[\s\S]*?(?:\*/|\Z)"
        r"|'(?:[^'\\\n]|\\[\s\S])*'?"
        r'|"(?:[^"\\\n]|\\[\s\S])*"?'
        r"|`[^`]*`?"
    ),
    # Java: текстовый блок «"""…"""», символ и строка.
    JAVA: re.compile(
        _C_COMMENTS
        + r'|"""[\s\S]*?(?:"""|\Z)'
        + r"|'(?:[^'\\\n]|\\[\s\S])*'?"
        + r'|"(?:[^"\\\n]|\\[\s\S])*"?'
    ),
    # C#: сырая строка «"""…"""», дословная @"…" (кавычка внутри удвоена, переводы строк
    # допустимы), интерполяция $"…{выражение}…" (ТЗ §15 п. 14 Е4): выражения подстановок в маске
    # остаются кодом, иначе чтение Configuration["X"] внутри $"{…}/signin" не видно.
    CS: re.compile(
        _C_COMMENTS
        + r'|\$*"""[\s\S]*?(?:"""|\Z)'
        + r'|(?:\$@|@\$|@)"(?:[^"]|"")*"?'
        + r'|\$"(?:[^"\\\n{]|\\.|\{\{|' + _CS_HOLE + r')*"?'
        + r"|'(?:[^'\\\n]|\\[\s\S])*'?"
        + r'|"(?:[^"\\\n]|\\[\s\S])*"?'
    ),
}
_NOT_NEWLINE = re.compile(r"[^\n]")

# Строковый литерал в маске (содержимое уже пробелы): одинарные, двойные, обратные кавычки.
STR = r"""(?:'[ ]*'|"[ ]*"|`[ \n]*`)"""
# Пробелы между частями конструкции: ограничены, чтобы перебор был коротким.
SP = r"[ \t\r\n]{0,200}"

# Сколько пробелов и переводов строк смотреть вокруг литерала в поисках «+» склейки.
_MAX_GAP = 200
_IDENT_CHARS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$")
_MAX_IDENT = 100


# Сколько кавычек и начал комментариев допустимо в одном файле. Каждая — токен, а разбор
# токена стоит времени; настоящий код (и даже сжатый) далёк от предела, а файл из одних
# кавычек — враждебный вход: такой файл не читается и считается непрочитанным.
MAX_MARKS = 600_000


class TooDense(ValueError):
    """В файле слишком много строк и комментариев для разбора за разумное время."""


def mask(text: str, lang: str) -> str:
    marks = (
        text.count("'") + text.count('"') + text.count("`") + text.count("/*")
        + text.count("//")
    )
    if marks > MAX_MARKS:
        raise TooDense
    out: list[str] = []
    pos = 0
    for m in _TOKENS[lang].finditer(text):
        start, end = m.span()
        if start > pos:
            out.append(text[pos:start])
        tok = m.group()
        if end - start <= 2:
            # Пустая строка или пустой комментарий: в маске то же, что в тексте, кроме
            # знаков комментария.
            out.append("  " if tok[0] == "/" else tok)
        elif tok[0] == "/":
            out.append(_NOT_NEWLINE.sub(" ", tok))
        elif lang == CS and tok.startswith('$"') and not tok.startswith('$""'):
            out.append(_holes(tok))
        elif lang == CS and tok[0] in "$@":
            # Префикс дословной или сырой строки остаётся, содержимое — пробелы.
            quote = tok.index('"')
            closing = '"' if len(tok) > quote + 1 and tok[-1] == '"' else ""
            inner = tok[quote + 1:len(tok) - len(closing)]
            out.append(tok[:quote + 1] + _NOT_NEWLINE.sub(" ", inner) + closing)
        else:
            first = tok[0]
            closing = first if tok[-1] == first else ""
            inner = tok[1:len(tok) - len(closing)]
            out.append(first + _NOT_NEWLINE.sub(" ", inner) + closing)
        pos = end
    out.append(text[pos:])
    return "".join(out)


def _holes(tok: str) -> str:
    """Маска интерполированной строки C#: текст строки — пробелы, подстановки «{…}» — код
    (строки внутри них замаскированы как обычно)."""
    closing = '"' if len(tok) > 2 and tok[-1] == '"' else ""
    out = ['$"']
    for m in _CS_PIECES.finditer(tok, 2, len(tok) - len(closing)):
        if m.group("hole") is not None:
            out.append(mask(m.group(), CS))
        else:
            out.append(_NOT_NEWLINE.sub(" ", m.group()))
    out.append(closing)
    return "".join(out)


def imports(text: str, modules: frozenset[str], lang: str) -> bool:
    """Файл подключает один из модулей. Go: путь импорта в кавычках без учёта регистра
    («github.com/IBM/sarama»), с подпакетом или без. JS: спецификатор модуля в кавычках,
    сам или с подпутём (require('kafkajs'), from "nats/lib"). Имена методов клиентов
    (publish, subscribe, consume) общие с другими библиотеками, поэтому без подключения
    клиента файл не читается."""
    if lang == GO:
        low = text.lower()
        return any(f'"{m}' in low for m in modules)
    return any(f"{q}{m}{end}" in text for m in modules for q in "'\"" for end in (q, "/"))


def load(files: Files, rel: str, text: str, lang: str) -> Code | None:
    """Код файла для разбора; слишком плотный файл отмечается непрочитанным (None)."""
    try:
        return Code(text, lang)
    except TooDense:
        files.refuse(rel)
        return None


class Code:
    """Исходный текст, его маска и номера строк по позиции."""

    def __init__(self, text: str, lang: str) -> None:
        self.text = text
        self.mask = mask(text, lang)
        self._breaks: list[int] | None = None

    def line(self, pos: int) -> int:
        if self._breaks is None:
            self._breaks = [m.start() for m in re.finditer("\n", self.text)]
        return bisect_right(self._breaks, pos - 1) + 1

    def literal(self, start: int, end: int) -> tuple[str, bool]:
        """Значение строкового литерала по позициям в маске (с кавычками) и признак
        динамического имени: шаблонная строка с ${…} или литерал в склейке строк
        (joined) известны только при запуске."""
        quote = self.text[start]
        value = self.text[start + 1:end - 1]
        return value, (quote == "`" and "${" in value) or self.joined(start, end)

    def joined(self, start: int, end: int) -> bool:
        """Литерал на позициях [start, end) маски — часть склейки строк: к нему на маске
        примыкает «+» слева или справа (пробелы и переводы строк допустимы). Такой
        литерал — лишь часть имени, и склейка из двух литералов («/a» + «/b») не
        исключение: имя целиком сборщик не собирает (ТЗ §15 п. 10 А)."""
        mask = self.mask
        i = start - 1
        while i >= 0 and start - i <= _MAX_GAP and mask[i] in " \t\r\n":
            i -= 1
        if i >= 0 and mask[i] == "+":
            return True
        j = end
        while j < len(mask) and j - end < _MAX_GAP and mask[j] in " \t\r\n":
            j += 1
        return j < len(mask) and mask[j] == "+"

    def reason(self, start: int, end: int, dynamic: str) -> str:
        """Причина подсказки о динамическом литерале: склейка или подстановка."""
        return texts.REASON_JOINED_NAME if self.joined(start, end) else dynamic

    def receiver(self, dot: int) -> str | None:
        """Имя перед точкой вызова: «router» в «router.get(», «app» в «this.app.get(»."""
        i = dot - 1
        while i >= 0 and self.mask[i] in " \t":
            i -= 1
        end = i + 1
        while i >= 0 and end - i <= _MAX_IDENT and self.mask[i] in _IDENT_CHARS:
            i -= 1
        name = self.mask[i + 1:end]
        if not name or name[0].isdigit() or end - i > _MAX_IDENT:
            return None
        return name

    def expression(self, start: int, limit: int = 80) -> str:
        """Короткий текст выражения от позиции start до запятой или скобки (для подсказки
        о динамическом имени)."""
        out = []
        depth = 0
        for i in range(start, min(len(self.mask), start + limit)):
            ch = self.mask[i]
            if ch in "([{":
                depth += 1
            elif ch in ")]}":
                if depth == 0:
                    break
                depth -= 1
            elif ch in ",;\n" and depth == 0:
                break
            out.append(self.text[i])
        return "".join(out).strip()
