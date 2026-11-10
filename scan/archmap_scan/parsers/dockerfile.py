"""Dockerfile* (ТЗ §6.1): базовые образы стадий (язык), каталог файла (код контейнера),
CMD и ENTRYPOINT (команда для точек входа). skaffold.yaml: артефакты build.artifacts
(образ, контекст, Dockerfile) называют образ, который собирает Dockerfile в подкаталоге
(Online Boutique: cartservice из src/cartservice/src, ТЗ §15 п. 10 А6).

Строки с переносом «\\» склеиваются, комментарии пропускаются. FROM со ссылкой на прежнюю
стадию («FROM build AS final») берёт образ той стадии. Аргументы ${VAR} не подставляются:
по имени образа до подстановки язык виден и так (python:${PY} → python).
"""

from __future__ import annotations

import json
from collections.abc import Iterator

from archmap_scan import paths, texts
from archmap_scan.context import Context
from archmap_scan.model import Dockerfile, Findings, ImageBuild, Loc, unparsed_hint
from archmap_scan.walk import Files
from archmap_scan.yamlload import BadYaml, LineDict, LineList, YamlTooLarge, load_all

NAME = "dockerfile"


def is_dockerfile(rel: str) -> bool:
    low = paths.name(rel).lower()
    return (
        low == "dockerfile"
        or low.startswith(("dockerfile.", "dockerfile-"))
        or low.endswith((".dockerfile", "-dockerfile"))
    )


def _logical_lines(text: str) -> list[tuple[int, str]]:
    """(номер первой строки, инструкция) со склейкой переносов «\\»."""
    out: list[tuple[int, str]] = []
    buf: list[str] = []
    start = 0
    for no, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not buf and (not line or line.startswith("#")):
            continue
        if buf and line.startswith("#"):
            continue
        if not buf:
            start = no
        if line.endswith("\\"):
            buf.append(line[:-1].strip())
            continue
        buf.append(line)
        out.append((start, " ".join(p for p in buf if p)))
        buf = []
    if buf:
        out.append((start, " ".join(p for p in buf if p)))
    return out


def _exec_form(value: str) -> str:
    """CMD ["a", "b"] → «a b»; оболочечная форма как есть."""
    value = value.strip()
    if value.startswith("["):
        try:
            items = json.loads(value)
        except ValueError:
            return value
        if isinstance(items, list):
            return " ".join(str(i) for i in items)
    return value


_CONTEXT = frozenset({".", "./"})


def _copies_context(rest: str) -> bool:
    """COPY или ADD всего контекста сборки: источник «.» или «./» (форма оболочки и JSON),
    но не из другой стадии или образа (--from)."""
    value = rest.strip()
    if value.startswith("["):
        try:
            items = json.loads(value)
        except ValueError:
            return False
        args = [str(i) for i in items] if isinstance(items, list) else []
    else:
        args = value.split()
    if any(a.startswith("--from") for a in args):
        return False
    args = [a for a in args if not a.startswith("--")]
    return len(args) >= 2 and any(a in _CONTEXT for a in args[:-1])


def copy_sources(text: str) -> Iterator[tuple[int, str]]:
    """(строка, путь) источников COPY и ADD последней стадии из контекста сборки (ТЗ §15
    п. 16 С1): без --from (другая стадия или образ), без адресов URL и шаблонов с «*», «?»,
    «[»; последний аргумент — назначение. Стадии сборки до последнего FROM в образ не
    попадают. Источники идут лениво: вызывающий останавливается на своём пределе."""
    lines = _logical_lines(text)
    last = -1
    for i, (_no, line) in enumerate(lines):
        if line.partition(" ")[0].upper() == "FROM":
            last = i
    for no, line in lines[last + 1:]:
        word, _, rest = line.partition(" ")
        if word.upper() not in ("COPY", "ADD"):
            continue
        value = rest.strip()
        args: list[str]
        if value.startswith("["):
            try:
                items = json.loads(value)
            except ValueError:
                continue
            args = [str(i) for i in items] if isinstance(items, list) else []
        else:
            args = value.split()
        if any(a.startswith("--from") for a in args):
            continue
        args = [a for a in args if not a.startswith("--")]
        for source in args[:-1]:
            if "://" not in source and not any(c in source for c in "*?["):
                yield no, source


def parse_text(rel: str, text: str) -> Dockerfile | None:
    images: list[str] = []
    stages: dict[str, str] = {}
    from_line = 0
    cmd: tuple[int, str] | None = None
    entry: tuple[int, str] | None = None
    context = False
    for no, line in _logical_lines(text):
        word, _, rest = line.partition(" ")
        op = word.upper()
        if op in ("COPY", "ADD"):
            context = context or _copies_context(rest)
        elif op == "FROM":
            args = [a for a in rest.split() if not a.startswith("--")]
            if not args:
                continue
            image = stages.get(args[0].lower(), args[0])
            images.append(image)
            if len(args) >= 3 and args[1].upper() == "AS":
                stages[args[2].lower()] = image
            if not from_line:
                from_line = no
        elif op == "CMD":
            cmd = (no, _exec_form(rest))
        elif op == "ENTRYPOINT":
            entry = (no, _exec_form(rest))
    if not images:
        return None
    command: str | None = None
    command_line = 0
    picked = entry or cmd
    if entry is not None and cmd is not None:
        command, command_line = f"{entry[1]} {cmd[1]}", entry[0]
    elif picked is not None:
        command_line, command = picked
    return Dockerfile(
        path=rel,
        dir=paths.parent(rel),
        images=images,
        from_loc=Loc(rel, from_line),
        command=command,
        command_loc=Loc(rel, command_line) if command else None,
        copies_context=context,
    )


def is_skaffold(rel: str) -> bool:
    return paths.name(rel).lower() in ("skaffold.yaml", "skaffold.yml")


def _skaffold(files: Files, rel: str, found: Findings) -> None:
    """Артефакты skaffold: образ, каталог контекста и Dockerfile в нём (по умолчанию
    Dockerfile). Профили (patches) не применяются: они меняют сборку для отладки."""
    text = files.read(rel)
    if text is None:
        return
    try:
        docs = load_all(text)
    except YamlTooLarge:
        files.refuse(rel)
        return
    except BadYaml:
        found.hints.append(unparsed_hint(rel, texts.REASON_BAD_YAML))
        return
    for doc in docs:
        build = doc.get("build") if isinstance(doc, LineDict) else None
        artifacts = build.get("artifacts") if isinstance(build, LineDict) else None
        if not isinstance(artifacts, LineList):
            continue
        for i, item in enumerate(artifacts):
            if not isinstance(item, LineDict) or not isinstance(item.get("image"), str):
                continue
            context = item.get("context", ".")
            docker = item.get("docker")
            name = docker.get("dockerfile", "Dockerfile") if isinstance(docker, LineDict) \
                else "Dockerfile"
            if not isinstance(context, str) or not isinstance(name, str):
                continue
            folder = paths.join(paths.parent(rel), context)
            path = paths.join(folder, name) if folder is not None else None
            if folder is None or path is None:
                continue
            found.image_builds.append(ImageBuild(
                dockerfile=path, loc=Loc(rel, artifacts.line_at(i)), build_dir=folder,
                image=item["image"],
            ))


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    for rel in files.select(is_dockerfile):
        text = files.read(rel)
        if text is None:
            continue
        info = parse_text(rel, text)
        if info is not None:
            found.dockerfiles.append(info)
    for rel in files.select(is_skaffold):
        _skaffold(files, rel, found)
    return found
