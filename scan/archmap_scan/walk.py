"""Перечень файлов и чтение (ТЗ §4): git или обход, исключения, .archmapignore, пределы.

Открываются только файлы, которые нужны какому-то разборщику: перечень строится по путям,
а содержимое читает Files.read по запросу разборщика. Файл больше 2 МБ не читается, байты
не в UTF-8 заменяются, двоичный файл (с нулевым байтом) пропускается; всё это считается в
отчёте о покрытии (unread).
"""

from __future__ import annotations

import os
import re
from collections import Counter
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

from archmap_scan.context import Context, git_files

MAX_BYTES = 2 * 1024 * 1024
MARKER = ".archmap-scan"
IGNORE_FILE = ".archmapignore"

# Без git: каталоги, в которые обход не заходит (то, что обычно лежит в .gitignore).
SKIP_DIRS = frozenset({
    ".git", "node_modules", "vendor", "dist", "build", "target", ".venv", "venv",
    "__pycache__", ".tox", ".mypy_cache", ".idea", ".vscode", "coverage",
})

# Исключение по соглашению: сегменты пути (сравнение без учёта регистра).
CONVENTION_DIRS = frozenset({
    "test", "tests", "__tests__", "testing", "spec", "specs", "testdata", "fixtures",
    "mocks", "__mocks__", "e2e", "docs", "doc", "examples", "example", "samples",
    "benchmarks",
})

_COMPOSE_NAME = re.compile(r"(docker-)?compose([._-][^/]*)?\.ya?ml", re.IGNORECASE)
_NAME_TOKENS = re.compile(r"[._-]")
_COMPOSE_TEST_TOKENS = frozenset({"test", "tests", "ci", "e2e"})


def is_compose_name(name: str) -> bool:
    """docker-compose*.y*ml и compose*.y*ml (имя файла без каталога)."""
    return _COMPOSE_NAME.fullmatch(name) is not None


def name_tokens(name: str) -> set[str]:
    """Части имени файла между точками, дефисами и подчёркиваниями, в нижнем регистре."""
    return {t for t in _NAME_TOKENS.split(name.lower()) if t}


# Манифесты для разработки (ТЗ §4): compose, Dockerfile, supervisor, systemd и k8s, у
# которых в пути есть каталог или в имени файла есть часть из этого перечня, объектов в
# схему не дают. Перечень один на все разборщики; сами каталоги из обхода не исключаются,
# код в них читается. «.devcontainer» после разбиения имени даёт часть «devcontainer»;
# tests и e2e исключены соглашением целиком, но бывают частью имени файла
# (Dockerfile.e2e).
DEV_TOKENS = frozenset({
    "dev", "devenv", "development", "local", "hack", "contrib", "sandbox", "demo",
    "playground", "devcontainer", "vagrant", "ci", "test", "tests", "e2e",
})


def is_dev_path(rel: str) -> bool:
    """Манифест для разработки: часть из DEV_TOKENS в любом каталоге пути или в имени."""
    return any(name_tokens(seg) & DEV_TOKENS for seg in rel.split("/"))


def _name_rule(name: str) -> str | None:
    """Правило соглашения по имени файла: шаблон для отчёта или None."""
    low = name.lower()
    if low == "conftest.py":
        return "conftest.py"
    if low.startswith("test_") and low.endswith(".py"):
        return "test_*.py"
    if low.endswith("_test.py"):
        return "*_test.py"
    if low.endswith("_test.go"):
        return "*_test.go"
    if ".test." in low:
        return "*.test.*"
    if ".spec." in low:
        return "*.spec.*"
    return None


def convention_rule(rel_in_scope: str) -> tuple[str, bool] | None:
    """Почему путь исключён по соглашению. Первое — что писать в отчёт: каталог («tests/»),
    шаблон имени или путь compose-файла для тестов и CI; второе — это путь от области обхода
    (тогда к нему добавляется путь области). None — путь не исключается."""
    parts = rel_in_scope.split("/")
    for i, seg in enumerate(parts[:-1]):
        if seg.lower() in CONVENTION_DIRS:
            return "/".join(parts[: i + 1]) + "/", True
    name = parts[-1]
    if is_compose_name(name) and name_tokens(name) & _COMPOSE_TEST_TOKENS:
        return rel_in_scope, True
    rule = _name_rule(name)
    if rule is not None:
        return rule, False
    return None


def _glob_match(
    pattern: Sequence[str], items: Sequence[str], star: str, eq: Callable[[str, str], bool]
) -> bool:
    """Сопоставление со звёздочкой без экспоненциальных возвратов: жадный проход с откатом к
    последней звезде, O(len(pattern) * len(items)). Работает и по символам сегмента, и по
    сегментам пути (там «звезда» — это «**»)."""
    pi = si = 0
    star_at = -1
    mark = 0
    while si < len(items):
        if pi < len(pattern) and pattern[pi] != star and eq(pattern[pi], items[si]):
            pi += 1
            si += 1
        elif pi < len(pattern) and pattern[pi] == star:
            star_at = pi
            mark = si
            pi += 1
        elif star_at != -1:
            pi = star_at + 1
            mark += 1
            si = mark
        else:
            return False
    while pi < len(pattern) and pattern[pi] == star:
        pi += 1
    return pi == len(pattern)


def _char_eq(a: str, b: str) -> bool:
    return a == "?" or a == b


def segment_match(pattern: str, name: str) -> bool:
    """Шаблон одного сегмента пути: «*» любые символы, «?» один символ, без «/»."""
    return _glob_match(list(pattern), list(name), "*", _char_eq)


class Pattern:
    """Шаблон подмножества .gitignore: «*», «**», «?», ведущий «/» привязывает к корню,
    хвостовой «/» означает каталог. Отрицаний «!» нет. Шаблон без «/» внутри сравнивается с
    именем на любой глубине, с «/» — с путём от корня репозитория."""

    def __init__(self, raw: str) -> None:
        self.raw = raw
        text = raw.strip()
        self.dir_only = text.endswith("/")
        text = text.rstrip("/")
        anchored_lead = text.startswith("/")
        text = text.lstrip("/")
        self.anchored = anchored_lead or "/" in text
        segs: list[str] = []
        for seg in text.split("/"):
            if seg == "**" and segs and segs[-1] == "**":
                continue
            segs.append(seg)
        self._segs = segs

    def matches(self, rel: str, is_dir: bool) -> bool:
        if self.dir_only and not is_dir:
            return False
        if not self.anchored:
            seg = self._segs[0] if self._segs else ""
            return seg == "**" or segment_match(seg, rel.rsplit("/", 1)[-1])
        return _glob_match(self._segs, rel.split("/"), "**", segment_match)

    def hits(self, rel: str) -> bool:
        """Файл или любой из его каталогов подходит под шаблон."""
        parts = rel.split("/")
        for i in range(1, len(parts)):
            if self.matches("/".join(parts[:i]), True):
                return True
        return self.matches(rel, False)


def parse_patterns(text: str) -> list[Pattern]:
    """Строки файла .archmapignore: пустые и с «#» пропускаются, отрицания не поддержаны."""
    out: list[Pattern] = []
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#") or s.startswith("!"):
            continue
        out.append(Pattern(s))
    return out


@dataclass(frozen=True)
class Excluded:
    """Строка отчёта об исключённом: каталог или шаблон, число файлов, причина."""

    path: str
    files: int
    reason: str  # convention | archmapignore | option


@dataclass(frozen=True)
class Listing:
    files: tuple[str, ...]
    excluded: tuple[Excluded, ...]
    ignore_file: str | None  # путь .archmapignore, если он был


def _walk(top: Path, root: Path, skip: Sequence[Path]) -> list[str]:
    """Обход без git: пропуски SKIP_DIRS, каталогов вывода и каталогов с маркером."""
    out: list[str] = []
    skip_set = {p.resolve() for p in skip}
    for dirpath, dirnames, filenames in os.walk(top):
        here = Path(dirpath)
        kept = []
        for d in sorted(dirnames):
            full = here / d
            if d in SKIP_DIRS or full in skip_set or (full / MARKER).exists():
                continue
            if full.is_symlink():
                continue
            kept.append(d)
        dirnames[:] = kept
        for f in filenames:
            full = here / f
            if full.is_symlink() or not full.is_file():
                continue
            out.append(full.relative_to(root).as_posix())
    return sorted(out)


def _under(rel: str, prefixes: Sequence[str]) -> bool:
    return any(rel == p or rel.startswith(p + "/") for p in prefixes)


def list_files(
    ctx: Context,
    *,
    excludes: Sequence[str] = (),
    includes: Sequence[str] = (),
    skip: Sequence[Path] = (),
) -> Listing:
    """Перечень файлов области с исключениями. Пути от корня, отсортированы."""
    raw = git_files(ctx) if ctx.git else None
    if raw is None:
        raw = _walk(ctx.scope_dir, ctx.root, skip)
    else:
        raw = _drop_ours(ctx.root, raw, skip)

    ignore_path = ctx.root / IGNORE_FILE
    ignore: list[Pattern] = []
    ignore_file: str | None = None
    if ignore_path.is_file() and not ignore_path.is_symlink():
        try:
            if ignore_path.stat().st_size <= MAX_BYTES:
                ignore = parse_patterns(ignore_path.read_text("utf-8", "replace"))
                ignore_file = IGNORE_FILE
        except OSError:
            ignore = []
    opt = [Pattern(p) for p in excludes if p.strip()]
    inc = [Pattern(p) for p in includes if p.strip()]

    files: list[str] = []
    counts: Counter[tuple[str, str]] = Counter()
    prefix = ctx.scope + "/" if ctx.scope else ""
    for rel in raw:
        if prefix and not rel.startswith(prefix):
            continue
        hit = next((p for p in ignore if p.hits(rel)), None)
        if hit is not None:
            counts[(hit.raw, "archmapignore")] += 1
            continue
        hit = next((p for p in opt if p.hits(rel)), None)
        if hit is not None:
            counts[(hit.raw, "option")] += 1
            continue
        rule = convention_rule(rel[len(prefix):])
        if rule is not None and not any(p.hits(rel) for p in inc):
            # Каталог и compose-файл отчитываются от корня, шаблон имени — как есть.
            shown, scoped = rule
            counts[(prefix + shown if scoped else shown, "convention")] += 1
            continue
        files.append(rel)
    excluded = tuple(
        Excluded(path=path, files=n, reason=reason)
        for (path, reason), n in sorted(counts.items())
    )
    return Listing(files=tuple(files), excluded=excluded, ignore_file=ignore_file)


def _drop_ours(root: Path, rels: Iterable[str], skip: Sequence[Path]) -> list[str]:
    """Из перечня git убрать каталоги вывода сборщика (свой и с маркером) и не-файлы."""
    skip_rel: list[str] = []
    for p in skip:
        try:
            skip_rel.append(p.resolve().relative_to(root).as_posix())
        except ValueError:
            continue
    marked: dict[str, bool] = {}

    def has_marker(d: str) -> bool:
        if d not in marked:
            marked[d] = (root / d / MARKER).is_file()
        return marked[d]

    out: list[str] = []
    for rel in rels:
        if _under(rel, skip_rel):
            continue
        parts = rel.split("/")
        if any(has_marker("/".join(parts[:i])) for i in range(1, len(parts))):
            continue
        full = root / rel
        if full.is_symlink() or not full.is_file():
            continue
        out.append(rel)
    return out


class Files:
    """Файлы области и их чтение по запросу разборщика (с кэшем и пределами)."""

    def __init__(self, root: Path, paths: Iterable[str]) -> None:
        self.root = root
        self.paths: tuple[str, ...] = tuple(sorted(paths))
        self._cache: dict[str, str | None] = {}
        self.too_large: set[str] = set()
        self.binary: set[str] = set()

    def read(self, rel: str) -> str | None:
        """Текст файла или None: больше предела, двоичный, не читается."""
        if rel in self._cache:
            return self._cache[rel]
        text: str | None = None
        full = self.root / rel
        try:
            st = full.lstat()
            if not full.is_file() or full.is_symlink():
                text = None
            elif st.st_size > MAX_BYTES:
                self.too_large.add(rel)
            else:
                data = full.read_bytes()
                if b"\0" in data[:8192]:
                    self.binary.add(rel)
                else:
                    text = data.decode("utf-8-sig", "replace")
        except OSError:
            text = None
        self._cache[rel] = text
        return text

    def refuse(self, rel: str) -> None:
        """Файл прочитан, но разбирать его разборщик отказался по своему пределу размера."""
        self.too_large.add(rel)

    def select(self, pred: Callable[[str], bool]) -> list[str]:
        return [p for p in self.paths if pred(p)]
