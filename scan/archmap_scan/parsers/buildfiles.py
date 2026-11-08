"""Процессы по файлам сборки (ТЗ §13.4): когда ярус манифестов не дал ни одного контейнера.

Zabbix не держит манифестов развёртывания: процессы в C собирает autotools, процессы Go
лежат по соглашению cmd/<имя>/. Поэтому:

- Makefile.am со строками bin_PROGRAMS, sbin_PROGRAMS, libexec_PROGRAMS (с «+=» и переносом
  строки «\\») даёт контейнер на программу, каталог кода равен каталогу Makefile.am, технология
  C или C++ по расширениям исходников в этом каталоге (.c — C; .cpp, .cc, .cxx — C++);
- каталог cmd/<имя>/ в корне репозитория, в каталоге модуля Go (рядом go.mod) или вида
  */go/cmd/<имя>/ с файлом Go, где объявлена func main(), даёт контейнер <имя> на Go с этим
  каталогом кода. ТЗ называет main.go, но процесс Go объявляет main в любом файле пакета
  (Zabbix: cmd/zabbix_agent2/zabbix_agent2.go), поэтому основание — строка func main(), а
  main.go при нескольких файлах выбирается первым. Общий код (pkg/, include/, src/libs/)
  остаётся общим.

Результат лежит отдельно (Findings.build_units): сборка берёт его только вместо
единственного неявного контейнера корня, если манифестов нет (assemble.py).

Исключение — бинарные крейты Cargo workspace (ТЗ §15 п. 14 И1): Dockerfile, где ARG
задаёт переменную сборки `--bin $X` (PostHog rust/Dockerfile: ARG BIN, cargo build --bin
$BIN), рядом с Cargo.toml с [workspace] даёт обычного кандидата (Findings.units) на каждый
член workspace с src/main.rs: имя из [package] name, каталог кода — каталог крейта,
технология Rust, роль по словам имени (как у Procfile). Кандидат склеивается по имени с
сервисом compose или k8s и даёт ему каталог крейта вместо общего каталога workspace.
Признак разработки — по пути Dockerfile и Cargo.toml крейта (политика Б). Сборку Java
(build.xml) сборщик не читает: стек назван в покрытии контейнеров. Каталоги для разработки
(walk.is_dev_code) не читаются; tests и подобные исключены обходом. Маркер Bazel или CMake
в корне (root_stack) даёт стек репозитория, и тогда каталоги cmd/ модулей Go процессами не
считаются (ТЗ §15 п. 12 С12).
"""

from __future__ import annotations

import re

from archmap_scan import paths, texts, tomlite, vocab
from archmap_scan.context import Context
from archmap_scan.model import Findings, Loc, Unit
from archmap_scan.parsers.dockerfile import is_dockerfile
from archmap_scan.walk import Files, dev_sign, is_dev_code, manifest_sign

NAME = "buildfiles"
_PROGRAMS = re.compile(r"[ \t]*(?:bin|sbin|libexec)_PROGRAMS[ \t]*\+?=")
_WORD = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.+-]{0,199}")
_MAIN = re.compile(r"^func[ \t]+main[ \t]*\([ \t]*\)", re.MULTILINE)
_C_EXTS = (".c",)
_CPP_EXTS = (".cpp", ".cc", ".cxx")
# Переменная сборки бинарника крейта: «ARG BIN» и «cargo build --bin $BIN» (или ${BIN}).
_ARG = re.compile(r"^[ \t]*ARG[ \t]+([A-Za-z_][A-Za-z0-9_]{0,63})", re.MULTILINE | re.IGNORECASE)
_BIN_USE = re.compile(r"--bin[ \t=]{1,10}[\"']?\$\{?([A-Za-z_][A-Za-z0-9_]{0,63})")
_MAX_MEMBERS = 500


def _logical_lines(text: str) -> list[list[tuple[int, str]]]:
    """Логические строки Makefile.am: физические строки (номер, текст) со склейкой «\\»."""
    out: list[list[tuple[int, str]]] = []
    buf: list[tuple[int, str]] = []
    for no, raw in enumerate(text.splitlines(), start=1):
        line = raw.split("#", 1)[0]
        cont = line.rstrip().endswith("\\")
        buf.append((no, line.rstrip()[:-1] if cont else line))
        if not cont:
            out.append(buf)
            buf = []
    if buf:
        out.append(buf)
    return out


def programs(text: str) -> list[tuple[str, int]]:
    """Программы из *_PROGRAMS: (имя, строка, где оно стоит). Подстановки $(VAR) и @VAR@
    не имена: программа под ними известна только при сборке."""
    out: list[tuple[str, int]] = []
    for parts in _logical_lines(text):
        head = _PROGRAMS.match(parts[0][1])
        if head is None:
            continue
        for i, (no, line) in enumerate(parts):
            rest = line[head.end():] if i == 0 else line
            for word in rest.split():
                if "$" in word or "@" in word or _WORD.fullmatch(word) is None:
                    continue
                out.append((word, no))
    return out


def _c_language(files: Files, folder: str) -> str | None:
    """C или C++ по исходникам в каталоге Makefile.am (без подкаталогов)."""
    names = [paths.name(p).lower() for p in files.paths if paths.parent(p) == folder]
    if any(n.endswith(_CPP_EXTS) for n in names):
        return "C++"
    if any(n.endswith(_C_EXTS) for n in names):
        return "C"
    return None


def _autotools(files: Files, found: Findings) -> None:
    for rel in files.select(lambda p: paths.name(p) == "Makefile.am"):
        if is_dev_code(rel):
            continue
        text = files.read(rel)
        if text is None:
            continue
        folder = paths.parent(rel)
        language = _c_language(files, folder)
        seen: set[str] = set()
        for name, line in programs(text):
            # Программа под условием automake (if/else) названа дважды: процесс один.
            if name in seen:
                continue
            seen.add(name)
            found.build_units.append(Unit(
                name=name, parser=NAME, loc=Loc(rel, line), build_dir=folder,
                language=language,
            ))


def _cmd_dir(rel: str, modules: frozenset[str]) -> str | None:
    """Каталог cmd/<имя>/ файла Go: в корне, у модуля Go или вида */go/cmd/<имя>/."""
    parts = rel.split("/")
    if len(parts) < 3 or parts[-3] != "cmd" or not rel.endswith(".go"):
        return None
    above = "/".join(parts[:-3])
    if above == "" or above in modules or parts[-4] == "go":
        return "/".join(parts[:-1])
    return None


def _go(files: Files, found: Findings) -> None:
    modules = frozenset(paths.parent(p) for p in files.paths if paths.name(p) == "go.mod")
    mains: dict[str, list[Loc]] = {}
    for rel in files.paths:
        folder = _cmd_dir(rel, modules)
        if folder is None or is_dev_code(rel):
            continue
        text = files.read(rel, keep=False)
        hit = _MAIN.search(text) if text is not None else None
        if text is not None and hit is not None:
            mains.setdefault(folder, []).append(Loc(rel, text.count("\n", 0, hit.start()) + 1))
    for folder, locs in sorted(mains.items()):
        loc = min(locs, key=lambda x: (paths.name(x.path) != "main.go", x))
        found.build_units.append(Unit(
            name=paths.name(folder), parser=NAME, loc=loc, build_dir=folder, language="Go",
        ))


def bin_arg(text: str) -> str | None:
    """Имя ARG, которым Dockerfile выбирает бинарник крейта (`--bin $BIN`), или None."""
    declared = set(_ARG.findall(text))
    for m in _BIN_USE.finditer(text):
        if m.group(1) in declared:
            return m.group(1)
    return None


def _member_dirs(files: Files, folder: str, members: list[object]) -> list[str]:
    """Каталоги членов workspace: путь как написан или «каталог/*» (подкаталоги с
    Cargo.toml); прочие шаблоны не раскрываются."""
    crates: dict[str, list[str]] = {}
    for rel in files.paths:
        if paths.name(rel) == "Cargo.toml":
            crate = paths.parent(rel)
            crates.setdefault(paths.parent(crate), []).append(crate)
    out: list[str] = []
    for item in members[:_MAX_MEMBERS]:
        if not isinstance(item, str) or not item.strip("./"):
            continue
        if item.endswith("/*") and "*" not in item[:-2]:
            base = paths.join(folder, item[:-2])
            out += sorted(crates.get(base, [])) if base is not None else []
        elif "*" not in item:
            member = paths.join(folder, item)
            if member is not None:
                out.append(member)
    return list(dict.fromkeys(out))


def _crate(
    files: Files, present: set[str], member: str, docker: str, workspace: str,
) -> Unit | None:
    """Кандидат крейта с src/main.rs: имя из [package] name, строка имени — основание."""
    manifest = paths.join(member, "Cargo.toml") or "Cargo.toml"
    main = paths.join(member, "src/main.rs") or "src/main.rs"
    if manifest not in present or main not in present or is_dev_code(manifest):
        return None
    text = files.read(manifest)
    doc = tomlite.parse(text) if text is not None else None
    name = doc.get("package", "name") if doc is not None else None
    if not isinstance(name, str) or not name:
        return None
    line = (doc.line("package", "name") if doc is not None else None) or 1
    role = vocab.role_by_command(name.replace("-", " ").replace("_", " "))
    return Unit(
        name=name, parser=NAME, loc=Loc(manifest, line), build_dir=member, dockerfile=docker,
        language="Rust", role=role, dev=manifest_sign(docker) or dev_sign(manifest),
        workspace=workspace,
    )


def _cargo(files: Files, found: Findings) -> None:
    """Бинарные крейты workspace у Dockerfile с ARG для --bin (ТЗ §15 п. 14 И1)."""
    present = set(files.paths)
    for rel in files.select(is_dockerfile):
        folder = paths.parent(rel)
        cargo = paths.join(folder, "Cargo.toml") or "Cargo.toml"
        if cargo not in present:
            continue
        text = files.read(rel)
        if text is None or bin_arg(text) is None:
            continue
        cargo_text = files.read(cargo)
        doc = tomlite.parse(cargo_text) if cargo_text is not None else None
        members = doc.get("workspace", "members") if doc is not None else None
        if not isinstance(members, list):
            continue
        for member in _member_dirs(files, folder, members):
            unit = _crate(files, present, member, rel, folder)
            if unit is not None:
                found.units.append(unit)


_BAZEL_MARKERS = ("WORKSPACE", "WORKSPACE.bazel", "MODULE.bazel", "BUILD.bazel")
_CMAKE_MARKER = "CMakeLists.txt"


def root_stack(files: Files, scope: str) -> str | None:
    """Стек по маркеру сборки в корне (ТЗ §15 п. 12 С12): Bazel старше CMake."""
    present = set(files.paths)
    if any((paths.join(scope, name) or name) in present for name in _BAZEL_MARKERS):
        return vocab.STACK_BAZEL
    if (paths.join(scope, _CMAKE_MARKER) or _CMAKE_MARKER) in present:
        return vocab.STACK_CMAKE
    return None


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    found.root_stack = root_stack(files, ctx.scope)
    _autotools(files, found)
    # Модули Go при маркере Bazel или CMake в корне — SDK и утилиты: процессов не дают.
    if found.root_stack is None:
        _go(files, found)
    _cargo(files, found)
    if any(paths.name(p) == "build.xml" and not is_dev_code(p) for p in files.paths):
        found.build_unsupported.append(texts.STACK_ANT)
    return found
