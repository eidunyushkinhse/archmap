"""Текст кода JavaScript/TypeScript, Go, C#, Java, Rust и Ruby для разборщиков на регулярных
выражениях (ТЗ §6.2).

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

JS, GO, CS, JAVA, RUST, RUBY = "js", "go", "cs", "java", "rust", "ruby"

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
# Rust (ТЗ §15 п. 14 И2): сырая строка r"…", r#"…"# и br"…" (до кавычки с тем же числом «#»),
# символ ровно из одного знака или экранирования ('a', '\n', '\u{1F600}'): время жизни 'a
# литералом не считается, иначе код между двумя временами жизни ушёл бы в маску. Обычная
# строка Rust бывает в несколько строк.
_TOKENS[RUST] = re.compile(
    _C_COMMENTS
    + r'|(?<![A-Za-z0-9_])b?r(?P<hashes>#{0,10})"[\s\S]*?(?:"(?P=hashes)|\Z)'
    + r"|'(?:\\(?:u\{[0-9a-fA-F]{1,6}\}|[^\n])|[^'\\\n])'"
    + r'|"(?:[^"\\]|\\[\s\S])*"?'
)
_NOT_NEWLINE = re.compile(r"[^\n]")

# Ruby (ТЗ §15 п. 15 К1): комментарий «#», блок =begin … =end, всё после __END__, строки в
# одинарных и двойных кавычках (бывают в несколько строк), литералы %w[…], %i[…], %r{…} и
# подобные с одним уровнем вложенных скобок, начало heredoc («<<~SQL», «<<-EOS», «<<'EOS'»,
# «<<EOS» только с заглавным именем: «a << b» и «class << self» не heredoc) и регулярное
# выражение /…/ после знака, за которым деление не стоит. Тело heredoc начинается со
# следующей строки и кончается строкой с одним именем; его ищет _heredoc_end. У каждой ветки
# есть успешный исход, разбор линейный.
_PCT = (
    r"%[qQwWiIrsx]?(?:"
    r"\[(?:[^\[\]\\]|\\[\s\S]|\[[^\[\]]*\])*\]?"
    r"|\((?:[^()\\]|\\[\s\S]|\([^()]*\))*\)?"
    r"|\{(?:[^{}\\]|\\[\s\S]|\{[^{}]*\})*\}?"
    r"|<(?:[^<>\\]|\\[\s\S]|<[^<>]*>)*>?"
    r"|\|[^|]*\|?)"
)
_RUBY_TOKENS = re.compile(
    r"#[^\n]*"
    r"|^=begin\b[\s\S]*?(?:^=end\b[^\n]*|\Z)"
    r"|^__END__$[\s\S]*"
    r"|'(?:[^'\\]|\\[\s\S])*'?"
    r'|"(?:[^"\\]|\\[\s\S])*"?'
    r"|(?<![\w)\]}])" + _PCT
    + r"|<<[~-](?P<q1>['\"`]?)(?P<h1>[A-Za-z_]\w{0,99})(?P=q1)"
    r"|<<(?P<q2>['\"`])(?P<h2>[A-Za-z_]\w{0,99})(?P=q2)"
    r"|<<(?P<h3>[A-Z_][A-Z0-9_]{0,99})\b"
    r"|(?<=[(,=:{\[|&!~;])[ \t]*/(?:[^/\\\n]|\\.)*/?",
    re.MULTILINE,
)

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
    if lang == RUBY:
        marks = (
            text.count("'") + text.count('"') + text.count("#") + text.count("%")
            + text.count("/") + text.count("<<")
        )
        if marks > MAX_MARKS:
            raise TooDense
        return _mask_ruby(text)
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
        elif lang == RUST and tok[0] in "rb":
            out.append(_raw(tok))
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


# Строка с одним словом: кандидат в конец тела heredoc (_heredoc_end).
_LONE_WORD = re.compile(r"^([ \t]*)(\w{1,100})[ \t\r]*$", re.MULTILINE)
_PAIRS = {"[": "]", "(": ")", "{": "}", "<": ">", "|": "|"}


def _heredoc_end(text: str, start: int, name: str, indented: bool) -> int:
    """Конец тела heredoc, которое начинается в позиции start: конец строки, где стоит
    одно имя name (у «<<~» и «<<-» с отступом), иначе конец текста. Строки с одним словом
    перебираются вперёд одним выражением без подстановки имени, поэтому разбор линейный и
    при множестве разных имён."""
    for m in _LONE_WORD.finditer(text, start):
        if m.group(2) == name and (indented or not m.group(1)):
            return m.end()
    return len(text)


def _ruby_token(tok: str) -> str:
    """Маска одного токена Ruby: у комментария и блоков =begin и __END__ всё пробелы, у
    строки, литерала % и регулярного выражения остаются открывающие и закрывающий знаки."""
    if tok[0] in "#=_":
        return _NOT_NEWLINE.sub(" ", tok)
    body = tok.lstrip(" \t")
    lead = tok[:len(tok) - len(body)]
    if body[0] == "%":
        opener = 2 if body[1:2] in _PAIRS else 3
        close = _PAIRS[body[opener - 1]]
    else:
        opener, close = 1, body[0]
    closing = close if len(body) > opener and body[-1] == close else ""
    inner = body[opener:len(body) - len(closing)]
    return lead + body[:opener] + _NOT_NEWLINE.sub(" ", inner) + closing


def _mask_ruby(text: str) -> str:
    """Маска кода Ruby (ТЗ §15 п. 15 К1) той же длины, что текст: комментарии и тела heredoc —
    пробелы, у строк и литералов остаются кавычки и скобки."""
    out: list[str] = []
    pos = 0
    size = len(text)
    while pos < size:
        m = _RUBY_TOKENS.search(text, pos)
        if m is None:
            out.append(text[pos:])
            break
        start, end = m.span()
        out.append(text[pos:start])
        tok = m.group()
        name = m.group("h1") or m.group("h2") or m.group("h3")
        if name is None:
            out.append(_ruby_token(tok))
            pos = end
            continue
        # Начало heredoc: остаток строки — код, тело со следующей строки — пробелы.
        out.append(tok)
        line_end = text.find("\n", end)
        if line_end == -1:
            pos = end
            continue
        rest = _mask_ruby(text[end:line_end]) if line_end > end else ""
        out.append(rest)
        body_end = _heredoc_end(text, line_end + 1, name, m.group("h1") is not None)
        out.append(text[line_end:line_end + 1])
        out.append(_NOT_NEWLINE.sub(" ", text[line_end + 1:body_end]))
        pos = body_end
    return "".join(out)


def _raw(tok: str) -> str:
    """Маска сырой строки Rust: префикс до кавычки и закрывающая кавычка с «#» остаются,
    содержимое — пробелы."""
    quote = tok.index('"')
    closing = '"' + "#" * tok[:quote].count("#")
    end = len(tok) - len(closing) if len(tok) > quote + 1 and tok.endswith(closing) else len(tok)
    return tok[:quote + 1] + _NOT_NEWLINE.sub(" ", tok[quote + 1:end]) + tok[end:]


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
