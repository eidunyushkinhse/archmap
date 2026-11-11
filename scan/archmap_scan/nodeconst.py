"""Строковые константы кода Node.js для раскрытия имён (ТЗ §15 п. 18 В1, К1).

Константа — объявление верхнего уровня «export const ИМЯ = 'литерал'» или «const ИМЯ =
'литерал'» (тип после имени и «as const» допустимы), а также шаблон без выражений или с
подстановками «${ДРУГАЯ}» констант того же файла, которые сами литералы (одна вложенность:
`${CONTROL_PLANE_PREFIX}/status-callback`). Склейка через «+», вызов и шаблон с выражением
константой не считаются. Имя ищется как перечисление у NestJS (parsers/nest.py): сначала в
файле, потом среди экспортов пакета файла (ближайший package.json), потом единственное
экспортированное в репозитории; разные значения в пакете или в репозитории — неоднозначность.
Пути импортов не разбираются: поиск по имени этого не требует (псевдонимы путей вида
@/constants так и так не видны). Но за пределами файла имя ищется, только если файл его
импортирует (import { ИМЯ } from …, import { ДРУГОЕ as ИМЯ }, const { ИМЯ } = require(…)):
имя, которое не объявлено в файле и не импортировано, — переменная или параметр, а не
константа другого файла (n8n healthPath, PostHog channel).

Индекс экспортов строится один раз за запуск и только при первом поиске за пределами файла:
сырой текст файлов проходится одним выражением по началу строки, маска строится только у
файлов, где нужное имя объявлено.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import cast

from archmap_scan import codebase, codetext
from archmap_scan.codetext import STR
from archmap_scan.context import Context
from archmap_scan.model import Loc
from archmap_scan.walk import Files

_NAME = r"[A-Za-z_$][\w$]{0,199}"
# Объявление по маске: начало строки, без отступа (верхний уровень файла).
_DECL = re.compile(
    rf"^(export[ \t]+)?const[ \t]+({_NAME})[ \t]*(?::[^=\n]{{0,100}})?=[ \t]*({STR})", re.M,
)
# То же по сырому тексту для индекса экспортов: только имя, значение проверит маска.
_RAW_EXPORT = re.compile(rf"^export[ \t]+const[ \t]+({_NAME})[ \t]*(?::[^=\n]{{0,100}})?=[ \t]*[`'\"]", re.M)
_HOLE = re.compile(rf"\$\{{[ \t]*({_NAME})[ \t]*\}}")
# Импорт по именам и разбор require по маске: список в фигурных скобках (предел длины).
_IMPORT = re.compile(r"\bimport[ \t]+(?:type[ \t]+)?(?:[A-Za-z_$][\w$]{0,199}[ \t]*,[ \t]*)?\{([^{}]{0,10000})\}")
_REQUIRE = re.compile(r"\b(?:const|let|var)[ \t]+\{([^{}]{0,10000})\}[ \t]*=[ \t]*require[ \t]*\(")
_ITEM = re.compile(rf"(?:type[ \t]+)?({_NAME})(?:[ \t]*(?:as|:)[ \t]*({_NAME}))?")
# Сколько объявлений файла и экспортов одного имени в репозитории смотреть (враждебный вход).
_MAX_DECLS = 2000
_MAX_SAME_NAME = 50
_MEMO = "node-consts"


@dataclass(frozen=True)
class Const:
    value: str
    loc: Loc


# Имя объявлено в нескольких файлах с разными значениями.
AMBIGUOUS = Const("", Loc("", 0))


def _after(mask: str, end: int) -> bool:
    """За литералом конец объявления: «;», перевод строки, «as const» или конец файла."""
    i = end
    while i < len(mask) and mask[i] in " \t":
        i += 1
    if mask.startswith("as", i):
        i += 2
        while i < len(mask) and mask[i] in " \t":
            i += 1
        if not mask.startswith("const", i):
            return False
        i += 5
        while i < len(mask) and mask[i] in " \t":
            i += 1
    return i >= len(mask) or mask[i] in ";\r\n"


def declarations(code: codetext.Code, rel: str) -> dict[str, tuple[Const | None, bool]]:
    """Константы файла: имя → (значение и место или None, если значение не литерал;
    экспортирована ли). Подстановки шаблона раскрываются константами этого же файла."""
    raw: dict[str, tuple[str, int, bool, bool]] = {}
    for count, m in enumerate(_DECL.finditer(code.mask)):
        if count >= _MAX_DECLS:
            break
        name = m.group(2)
        start, end = m.span(3)
        if name in raw or not _after(code.mask, end):
            continue
        template = code.text[start] == "`"
        raw[name] = (code.text[start + 1:end - 1], code.line(m.start()), template,
                     m.group(1) is not None)
    out: dict[str, tuple[Const | None, bool]] = {}
    for name, (value, line, template, exported) in raw.items():
        text: str | None = value
        if template and "${" in value:
            text = _fill(value, raw)
        out[name] = (Const(text, Loc(rel, line)) if text is not None else None, exported)
    return out


def _fill(value: str, raw: dict[str, tuple[str, int, bool, bool]]) -> str | None:
    """Шаблон с подстановками «${ИМЯ}» констант файла, которые сами литералы без
    подстановок; любое другое выражение — None."""
    out: list[str] = []
    pos = 0
    for m in _HOLE.finditer(value):
        other = raw.get(m.group(1))
        if other is None or (other[2] and "${" in other[0]):
            return None
        out.append(value[pos:m.start()])
        out.append(other[0])
        pos = m.end()
    rest = value[pos:]
    if "${" in rest:
        return None
    return "".join(out) + rest


def imported(code: codetext.Code) -> dict[str, str]:
    """Имена, которые файл импортирует по именам: местное имя → имя экспорта (у «A as B» и
    «{ A: B } = require(…)» местное B, экспорт A)."""
    out: dict[str, str] = {}
    for pattern in (_IMPORT, _REQUIRE):
        for m in pattern.finditer(code.mask):
            for piece in m.group(1).split(","):
                item = _ITEM.fullmatch(piece.strip())
                if item is not None:
                    out.setdefault(item.group(2) or item.group(1), item.group(1))
    return out


class Index:
    """Константы Node.js репозитория: свои у файла и экспорты по именам."""

    def __init__(self, files: Files, ctx: Context) -> None:
        self.files = files
        self.ctx = ctx
        self._own: dict[str, dict[str, tuple[Const | None, bool]]] = {}
        self._imports: dict[str, dict[str, str]] = {}
        self._exports: dict[str, list[str]] | None = None

    def of(self, rel: str, code: codetext.Code | None = None) -> dict[str, tuple[Const | None, bool]]:
        """Константы файла rel (код уже разобран — code, иначе файл читается)."""
        if rel not in self._own:
            if code is None:
                text = self.files.read(rel, keep=False)
                code = codetext.load(self.files, rel, text, codetext.JS) if text is not None else None
            self._own[rel] = declarations(code, rel) if code is not None else {}
            self._imports[rel] = imported(code) if code is not None else {}
        return self._own[rel]

    def _export_files(self) -> dict[str, list[str]]:
        if self._exports is None:
            index: dict[str, list[str]] = {}
            # Пропуск кода для разработки при поиске констант в покрытие разборщика, который
            # спросил первым, не идёт: его записей в этих файлах никто не искал (как у
            # перечислений nest._enums).
            kept, self.files.dev_code = self.files.dev_code, set()
            for rel in codebase.code_files(self.files, self.ctx, codebase.NODE):
                text = self.files.read(rel, keep=False)
                if text is None or "export const" not in text:
                    continue
                for m in _RAW_EXPORT.finditer(text):
                    rels = index.setdefault(m.group(1), [])
                    if (not rels or rels[-1] != rel) and len(rels) < _MAX_SAME_NAME:
                        rels.append(rel)
            self.files.dev_code = kept
            self._exports = index
        return self._exports

    def _package(self, rel: str) -> str | None:
        pkgs = codebase.owner_packages(self.files, self.ctx, rel, codebase.NODE)
        return pkgs[0].dir if pkgs else None

    def lookup(self, rel: str, name: str, code: codetext.Code | None = None) -> Const | None:
        """Значение константы name для файла rel: в файле, затем, если файл импортирует это
        имя, в пакете файла, единственное в репозитории. AMBIGUOUS — разные значения; None —
        не найдена, не импортирована или не литерал."""
        own = self.of(rel, code).get(name)
        if own is not None:
            return own[0]
        exported = self._imports.get(rel, {}).get(name)
        if exported is None:
            return None
        found: list[Const] = []
        for other in self._export_files().get(exported, []):
            if other == rel:
                continue
            item = self.of(other).get(exported)
            if item is not None and item[1] and item[0] is not None:
                found.append(item[0])
        if not found:
            return None
        home = self._package(rel)
        near = [c for c in found if home is not None and self._package(c.loc.path) == home]
        for group in (near, found):
            values = {c.value for c in group}
            if len(values) == 1:
                return min(group, key=lambda c: c.loc)
            if len(values) > 1:
                return AMBIGUOUS
        return None


def index(files: Files, ctx: Context) -> Index:
    """Индекс констант на запуск (один на все разборщики, Files.memo)."""
    memo = files.memo.get(_MEMO)
    if memo is None:
        memo = files.memo[_MEMO] = Index(files, ctx)
    return cast(Index, memo)
