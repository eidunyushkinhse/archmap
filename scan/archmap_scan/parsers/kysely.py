"""DDL в тегированных шаблонах миграций на JavaScript и TypeScript (ТЗ §15 п. 14 З2).

Миграции Kysely (immich `server/src/schema/migrations/*.ts`) пишут SQL текстом:
``await sql`CREATE TABLE "users" (…)`.execute(db)``. Файлы `.ts` и `.js` в каталоге с именем
`migrations` любой глубины, где есть ``sql` `` или `sql.raw(`, отдают содержимое шаблонов `sql` (и
`sql<Тип>`) и текстовых аргументов `sql.raw(`…`)` разборщику DDL (`sqlddl.py`) в порядке
имён файлов с числами по значению; набор — каталог файлов. Тело функции `down` (откат) не
читается. Вставка `${…}` заменяется заглушкой: если она стоит на месте имени таблицы или
колонки, запись идёт в `hints.dynamic_names`, а таблица или колонка с таким именем в схему
не попадает; в типе колонки остаётся текст вставки. Диалект — по драйверу в package.json
пакета файла (`pg`, `postgres` — PostgreSQL, `mysql2` — MySQL, `better-sqlite3` — SQLite),
иначе по типам колонок. Шаблоны ищутся по маске кода (`codetext`): шаблон в комментарии
или в строке не читается.

Часть 5 (ТЗ §15 п. 16 М1). Шаблон `sql.raw(`…`)` внутри цикла `for (const { a, b } of
СПИСОК)` или `for (const [a, b] of СПИСОК)`, где СПИСОК — массив-литерал верхнего уровня
того же файла из объектов `{ a: 'x', b: 'y' }` или массивов `['x', 'y']` со строковыми
литералами, читается для каждого элемента по порядку: вставки `${a}` и `${b}` (имена из
деструктуризации, других вставок нет) заменяются значениями элемента (StandardizeNames
immich: 30 переименований таблиц `ALTER TABLE "${oldName}" RENAME TO "${newName}"`).
Список длиннее 1000 элементов, элемент другой формы, значение не литерал или вставка с
выражением — шаблон читается как раньше (вставка — заглушка, подсказка).
"""

from __future__ import annotations

import re
from bisect import bisect_right
from collections.abc import Iterator
from dataclasses import dataclass, field
from functools import partial

from archmap_scan import codebase, codetext, dialect, paths, sqlddl, texts
from archmap_scan.context import Context
from archmap_scan.model import Findings, Hint, Loc, Table, TableSet
from archmap_scan.parsers import sql
from archmap_scan.walk import Files

NAME = "kysely"
_DIR = "migrations"
# Файл читается, если в нём есть шаблон sql или sql.raw (файл только с циклом sql.raw по
# списку переименований тоже миграция, М1).
_NEEDLES = ("sql`", "sql.raw(")
_TAG = re.compile(
    r"\bsql(?:[ \t]{0,20}<[^<>`\n]{0,200}>)?[ \t]{0,20}`"
    r"|\bsql\.raw[ \t]{0,20}\([ \t\r\n]{0,200}`"
)
# Объявление отката: функция, свойство или переменная со стрелкой, метод класса. Совпадение
# кончается сразу за «(» параметров.
_DOWN = re.compile(
    r"\bfunction[ \t]{1,20}down[ \t]{0,20}\("
    r"|\bdown[ \t]{0,20}[:=][ \t]{0,20}(?:async[ \t]{1,20})?(?:function\b[^(\n]{0,100})?\("
    r"|\bdown[ \t]{0,20}\((?=[^()\n]{0,200}\)[ \t]{0,20}(?::[^{;\n]{0,200})?\{)"
)
# Инструкции шаблона, которые читаются: DDL. Прочее (запросы, фрагменты `now()` для
# построителя) структуры таблиц не меняет и в счёт пропусков не идёт.
_DDL = frozenset({"CREATE", "ALTER", "DROP", "RENAME"})
_FIRST_WORD = re.compile(r"[A-Za-z]{1,20}")
# Заглушка вставки: имя SQL, которое не встретится в настоящей схеме.
_STUB = "archmap_dyn_"
_STUB_NAME = re.compile(_STUB + r"[0-9]+")
_MAX_HOLE = 2000
# Пределы на файл: шаблонов, инструкций (по «;») и вставок. В настоящих миграциях их сотни
# (InitialMigration immich — 300 шаблонов); файл сверх предела — враждебный вход, он
# считается непрочитанным.
_MAX_TEMPLATES = 5000
_MAX_MARKS = 20_000
# Цикл по списку (М1): деструктуризация объекта или массива и имя списка.
_FOR_OF = re.compile(
    r"\bfor[ \t]{0,20}\([ \t]{0,20}(?:const|let|var)[ \t]{1,20}"
    r"(\{[^{}()\n]{0,300}\}|\[[^\[\]()\n]{0,300}\])"
    r"[ \t]{0,20}of[ \t]{1,20}([A-Za-z_$][\w$]{0,100})[ \t]{0,20}\)"
)
_IDENT = re.compile(r"[A-Za-z_$][\w$]{0,100}")
_ALIAS = re.compile(r"([A-Za-z_$][\w$]{0,100})[ \t]{0,20}:[ \t]{0,20}([A-Za-z_$][\w$]{0,100})")
# Вставка шаблона — одно имя: ${a}.
_SIMPLE_HOLE = re.compile(r"\$\{[ \t]{0,20}([A-Za-z_$][\w$]{0,100})[ \t]{0,20}\}")
# Лексемы массива-литерала по маске: пробелы и комментарии (в маске пробелы), скобки и
# знаки, имя, строка (в маске кавычки и пробелы между ними).
_LIST_TOKEN = re.compile(
    r"(?P<sp>[ \t\r\n]+)|(?P<p>[\[\]{},:])|(?P<id>[A-Za-z_$][\w$]{0,100})"
    r"|(?P<str>'[^'\n]*'|\"[^\"\n]*\"|`[^`]*`)"
)
# Сколько элементов списка читается и сколько циклов по спискам смотрится в файле.
_MAX_PAIRS = 1000
_MAX_LOOPS = 100
_DRIVERS = (
    ("pg", dialect.POSTGRESQL), ("postgres", dialect.POSTGRESQL),
    ("kysely-postgres-js", dialect.POSTGRESQL), ("mysql2", dialect.MYSQL),
    ("better-sqlite3", dialect.SQLITE),
)


def is_migration(rel: str) -> bool:
    """Файл кода JavaScript или TypeScript в каталоге migrations любой глубины."""
    if not codebase.is_code_file(rel, codebase.NODE) or rel.lower().endswith(".d.ts"):
        return False
    return any(seg.lower() == _DIR for seg in rel.split("/")[:-1])


@dataclass
class _Chain:
    """Набор миграций: состояние базы и вставки по заглушкам (текст выражения и место)."""

    schema: sqlddl.Schema
    stubs: dict[str, tuple[str, Loc]] = field(default_factory=dict)
    hints: list[Hint] = field(default_factory=list)
    seen: set[tuple[str, str]] = field(default_factory=set)
    # Диалект по типам колонок (dialect.sql_types) и его место: если драйвера в package.json нет.
    types: tuple[str, Loc] | None = None

    def hint(self, stub: str, loc: Loc | None = None) -> None:
        expr, where = self.stubs[stub]
        source = str(loc or where)
        if (expr, source) in self.seen:
            return
        self.seen.add((expr, source))
        self.hints.append(Hint("dynamic_names", {
            "kind": "table", "name": "${" + expr + "}", "reason": texts.REASON_DYNAMIC_TABLE,
            "source": source,
        }))


def _skip_parens(mask: str, pos: int) -> int:
    """Позиция после скобки, закрывающей открытую до pos (pos — сразу за «(»)."""
    depth = 1
    while pos < len(mask) and depth:
        ch = mask[pos]
        depth += 1 if ch == "(" else -1 if ch == ")" else 0
        pos += 1
    return pos


def _down_ranges(mask: str) -> list[tuple[int, int]]:
    """Участки маски с функцией down по возрастанию, без пересечений: от объявления до
    закрывающей скобки тела (у стрелки без фигурных скобок — до конца инструкции)."""
    out: list[tuple[int, int]] = []
    # Позиция, после которой «{» в маске нет: поиск не повторяется для каждого совпадения.
    no_brace = len(mask) + 1
    for m in _DOWN.finditer(mask):
        if out and m.start() < out[-1][1]:
            continue
        pos = _skip_parens(mask, m.end())
        brace = -1 if pos >= no_brace else mask.find("{", pos)
        if brace < 0:
            no_brace = min(no_brace, pos)
        arrow = mask.find("=>", pos, brace) if brace >= 0 else -1
        if brace < 0 or (arrow >= 0 and mask[arrow + 2:brace].strip()):
            stop = mask.find(";", pos)
            out.append((m.start(), len(mask) if stop < 0 else stop + 1))
            continue
        depth = 0
        end = len(mask)
        for i in range(brace, len(mask)):
            ch = mask[i]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
        out.append((m.start(), end))
    return out


def _hole_end(raw: str, pos: int) -> int:
    """Позиция после «}», закрывающей вставку, которая начинается в pos (сразу за «${»)."""
    depth = 1
    limit = min(len(raw), pos + _MAX_HOLE)
    while pos < limit:
        ch = raw[pos]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return pos + 1
        pos += 1
    return limit


def _template_sql(raw: str, rel: str, line: int, chain: _Chain) -> str:
    """Текст шаблона для разбора DDL: вставки — заглушки той же высоты в строках,
    экранированные «`», «$» и «\\» — как написаны в SQL."""
    out: list[str] = []
    i = 0
    while True:
        j = raw.find("${", i)
        if j < 0:
            out.append(raw[i:])
            break
        out.append(raw[i:j])
        line += raw.count("\n", i, j)
        k = _hole_end(raw, j + 2)
        stub = f"{_STUB}{len(chain.stubs)}"
        expr = " ".join(raw[j + 2:k - 1].split())[:80]
        chain.stubs[stub] = (expr, Loc(rel, line))
        breaks = raw.count("\n", j, k)
        out.append(stub + "\n" * breaks)
        line += breaks
        i = k
    text = "".join(out)
    if "\\" in text:
        text = text.replace("\\`", "`").replace("\\$", "$").replace("\\\\", "\\")
    return text


def _apply(text: str, rel: str, offset: int, chain: _Chain) -> None:
    schema = chain.schema
    for line, stmt in sqlddl.split_statements(text):
        word = _FIRST_WORD.match(stmt)
        if word is None or word.group().upper() not in _DDL:
            continue
        loc = Loc(rel, line + offset)
        if _STUB in stmt:
            target = sqlddl.table_of(stmt, schema.fold)
            stub = _STUB_NAME.search(target[1]) if target is not None else None
            if stub is not None:
                chain.hint(stub.group(), loc)
        sqlddl.apply(stmt, loc, schema)


_Selector = str | int  # поле объекта или номер в массиве


def _destructure(text: str) -> dict[str, _Selector] | None:
    """Имена деструктуризации цикла: «{ a, b: c }» → {a: 'a', c: 'b'}, «[a, b]» → {a: 0,
    b: 1}; другая форма (значения по умолчанию, вложенность, пропуски) — None."""
    inner = text[1:-1]
    out: dict[str, _Selector] = {}
    for i, part in enumerate(inner.split(",")):
        part = part.strip()
        if not part and i == len(inner.split(",")) - 1 and i:
            continue  # висячая запятая
        if text[0] == "{":
            alias = _ALIAS.fullmatch(part)
            if alias is not None:
                out[alias.group(2)] = alias.group(1)
            elif _IDENT.fullmatch(part):
                out[part] = part
            else:
                return None
        elif _IDENT.fullmatch(part):
            out[part] = i
        else:
            return None
    return out or None


def _tokens(code: codetext.Code, start: int) -> Iterator[tuple[str, int, int]]:
    """Лексемы массива-литерала с позиции start маски (вид, начало, конец) без пробелов."""
    mask = code.mask
    pos = start
    while pos < len(mask):
        m = _LIST_TOKEN.match(mask, pos)
        if m is None:
            return
        pos = m.end()
        if m.lastgroup != "sp":
            yield m.lastgroup or "", m.start(), m.end()


def _string(code: codetext.Code, start: int, end: int) -> str | None:
    """Значение строкового литерала без вставок и экранирования; иначе None."""
    value = code.text[start + 1:end - 1]
    if any(c in value for c in "\\\n\"`$"):
        return None
    return value


def _list_items(code: codetext.Code, start: int) -> list[dict[_Selector, str]] | None:
    """Элементы массива-литерала с «[» в позиции start: объекты {поле: 'строка'} или массивы
    ['строка', …]. Другая форма или больше _MAX_PAIRS элементов — None."""
    toks = _tokens(code, start + 1)
    items: list[dict[_Selector, str]] = []
    for kind, a, _b in toks:
        ch = code.mask[a] if kind == "p" else ""
        if ch == "]":
            return items
        if len(items) >= _MAX_PAIRS or ch not in ("{", "["):
            return None
        item: dict[_Selector, str] = {}
        close = "}" if ch == "{" else "]"
        while True:
            kind, a, b = next(toks, ("", 0, 0))
            if code.mask[a:b] == close and kind == "p":
                break
            key: _Selector = len(item)
            if ch == "{":
                if kind == "id":
                    key = code.text[a:b]
                elif kind == "str":
                    got = _string(code, a, b)
                    if got is None:
                        return None
                    key = got
                else:
                    return None
                colon = next(toks, ("", 0, 0))
                if colon[0] != "p" or code.mask[colon[1]] != ":":
                    return None
                kind, a, b = next(toks, ("", 0, 0))
            value = _string(code, a, b) if kind == "str" else None
            if value is None:
                return None
            item[key] = value
            sep = next(toks, ("", 0, 0))
            if sep[0] != "p" or code.mask[sep[1]] not in (",", close):
                return None
            if code.mask[sep[1]] == close:
                break
        items.append(item)
        sep = next(toks, ("", 0, 0))
        if sep[0] != "p" or code.mask[sep[1]] not in (",", "]"):
            return None
        if code.mask[sep[1]] == "]":
            return items
    return None


def _depths(mask: str) -> tuple[list[int], list[int], dict[int, int]]:
    """Позиции фигурных скобок маски, глубина после каждой и пары «{» → «}»."""
    marks: list[int] = []
    depth_after: list[int] = []
    pairs: dict[int, int] = {}
    stack: list[int] = []
    for m in re.finditer(r"[{}]", mask):
        pos = m.start()
        if mask[pos] == "{":
            stack.append(pos)
        elif stack:
            pairs[stack.pop()] = pos
        marks.append(pos)
        depth_after.append(len(stack))
    return marks, depth_after, pairs


# Объявление массива-литерала: имя и «[» в конце совпадения.
_LIST_DECL = re.compile(
    r"\b(?:const|let|var)[ \t]{1,20}([A-Za-z_$][\w$]{0,100})[ \t]{0,20}"
    r"(?::[^=;\n]{0,200})?=[ \t\r\n]{0,200}\["
)


def _top_lists(mask: str, marks: list[int], depth_after: list[int]) -> dict[str, int | None]:
    """Массивы-литералы верхнего уровня файла: имя → позиция «[»; у имени, объявленного на
    верхнем уровне дважды, позиции нет (None). Один проход по маске."""
    out: dict[str, int | None] = {}
    for m in _LIST_DECL.finditer(mask):
        k = bisect_right(marks, m.start()) - 1
        if k >= 0 and depth_after[k] > 0:
            continue
        name = m.group(1)
        out[name] = None if name in out else m.end() - 1
    return out


@dataclass
class _Loop:
    start: int  # начало тела
    end: int  # конец тела
    names: dict[str, _Selector]
    items: list[dict[_Selector, str]] | None


def _loops(code: codetext.Code) -> list[_Loop]:
    """Циклы по спискам верхнего уровня (М1), не больше _MAX_LOOPS; тело — фигурные скобки
    или одна инструкция до «;»."""
    mask = code.mask
    heads: list[re.Match[str]] = []
    for m in _FOR_OF.finditer(mask):
        if len(heads) >= _MAX_LOOPS:
            break
        heads.append(m)
    if not heads:
        return []
    marks, depth_after, pairs = _depths(mask)
    declared = _top_lists(mask, marks, depth_after)
    lists: dict[str, list[dict[_Selector, str]] | None] = {}
    out: list[_Loop] = []
    for m in heads:
        names = _destructure(m.group(1))
        if names is None:
            continue
        body = m.end()
        while body < len(mask) and mask[body] in " \t\r\n":
            body += 1
        if body < len(mask) and mask[body] == "{":
            end = pairs.get(body, len(mask))
        else:
            stop = mask.find(";", body)
            end = len(mask) if stop < 0 else stop
        name = m.group(2)
        if name not in lists:
            at = declared.get(name)
            lists[name] = _list_items(code, at) if at is not None else None
        out.append(_Loop(body, end, names, lists[name]))
    return out


def _expanded(raw: str, loops: list[_Loop], start: int) -> list[str] | None:
    """Шаблон sql.raw внутри цикла по списку: текст для каждого элемента; не тот случай —
    None (шаблон читается как раньше)."""
    loop = None
    for item in loops:
        if item.start <= start < item.end and (loop is None or item.start > loop.start):
            loop = item
    if loop is None or loop.items is None or "${" not in raw:
        return None
    holes = _SIMPLE_HOLE.findall(raw)
    if len(holes) != raw.count("${") or any(h not in loop.names for h in holes):
        return None
    out: list[str] = []
    for values in loop.items:
        picked: dict[str, str] = {}
        for name in holes:
            value = values.get(loop.names[name])
            if value is None:
                return None
            picked[name] = value
        text = _SIMPLE_HOLE.sub(partial(_fill, picked), raw)
        if "\\" in text:
            text = text.replace("\\`", "`").replace("\\$", "$").replace("\\\\", "\\")
        out.append(text)
    return out


def _fill(values: dict[str, str], m: re.Match[str]) -> str:
    return values[m.group(1)]


def _file(files: Files, rel: str, chain: _Chain) -> None:
    text = files.read(rel, keep=False)
    if text is None or not any(n in text for n in _NEEDLES):
        return
    if text.count(";") > _MAX_MARKS or text.count("${") > _MAX_MARKS:
        files.refuse(rel)
        return
    code = codetext.load(files, rel, text, codetext.JS)
    if code is None:
        return
    downs = _down_ranges(code.mask)
    starts = [a for a, _ in downs]
    loops = _loops(code)
    for n, m in enumerate(_TAG.finditer(code.mask)):
        if n >= _MAX_TEMPLATES:
            files.refuse(rel)
            return
        start = m.end() - 1
        k = bisect_right(starts, start) - 1
        if k >= 0 and start < downs[k][1]:
            continue
        end = code.mask.find("`", start + 1)
        if end < 0:
            return
        line = code.line(start)
        raw = text[start + 1:end]
        bodies = _expanded(raw, loops, start) if m.group().startswith("sql.raw") else None
        for body in bodies if bodies is not None else [_template_sql(raw, rel, line, chain)]:
            if chain.types is None:
                hit = dialect.sql_types(body)
                if hit is not None:
                    chain.types = (hit[0], Loc(rel, line - 1 + hit[1]))
            _apply(body, rel, line - 1, chain)


def _dynamic(chain: _Chain) -> None:
    """Таблицы и колонки, имя которых — вставка, в схему не попадают: подсказка вместо них.
    В типе колонки заглушка заменяется текстом вставки."""
    schema = chain.schema
    for key, table in list(schema.tables.items()):
        stub = _STUB_NAME.search(table.name)
        if stub is not None:
            del schema.tables[key]
            chain.hint(stub.group())
            continue
        stub = _STUB_NAME.search(table.schema or "")
        if stub is not None:
            chain.hint(stub.group())
            table.schema = None
        _columns(table, chain)


def _columns(table: Table, chain: _Chain) -> None:
    kept = []
    for col in table.columns:
        stub = _STUB_NAME.search(col.name)
        if stub is not None:
            chain.hint(stub.group())
            continue
        ref = _STUB_NAME.search(col.references or "")
        if ref is not None:
            chain.hint(ref.group())
            col.references = None
        if col.type and _STUB in col.type:
            col.type = _STUB_NAME.sub(lambda m: "${" + chain.stubs[m.group()][0] + "}", col.type)
        kept.append(col)
    table.columns = kept


def _dialect(files: Files, ctx: Context, rel: str) -> tuple[str, Loc] | None:
    for pkg in codebase.owner_packages(files, ctx, rel, codebase.NODE):
        for dep, name in _DRIVERS:
            if dep in pkg.deps:
                text = files.read(pkg.path) or ""
                hit = text.find(f'"{dep}"')
                line = text.count("\n", 0, hit) + 1 if hit >= 0 else 1
                return name, Loc(pkg.path, line)
    return None


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not codebase.stack_present(files, ctx, codebase.NODE):
        return found
    found.applied.add(NAME)
    sets: dict[str, list[str]] = {}
    for rel in files.select(is_migration):
        if not files.skip_dev_code(rel):
            sets.setdefault(paths.parent(rel), []).append(rel)
    for folder in sorted(sets):
        chain_files = sorted(sets[folder], key=sql.natural_key)
        hit = _dialect(files, ctx, chain_files[0])
        keep_case = hit is not None and hit[0] in (dialect.MYSQL, dialect.SQLITE)
        chain = _Chain(sqlddl.Schema(fold=not keep_case))
        for rel in chain_files:
            _file(files, rel, chain)
        _dynamic(chain)
        schema = chain.schema
        found.hints += chain.hints
        if not schema.tables and not schema.skipped and not schema.dropped:
            continue
        ts = TableSet(
            parser=NAME, dir=folder, tables=list(schema.tables.values()),
            dropped=schema.dropped, skipped=schema.skipped,
            skipped_examples=schema.examples, queried=schema.from_query(),
        )
        hit = hit or chain.types
        if hit is not None:
            ts.dialect, ts.dialect_loc = hit
        found.table_sets.append(ts)
    return found
