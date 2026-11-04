"""docker-compose*.y*ml и compose*.y*ml (ТЗ §6.1).

Сервис compose — кандидат в объект: имя, образ, каталог сборки, команда, переменные
окружения (имена; значения только ради адресов зависимостей), depends_on. Сервисы под
profiles и сервисы, которые есть только в файлах для разработки (dev, local), в схему не
идут, а перечисляются в подсказках. extends и include не раскрываются. Подстановки с
дефолтом (${VAR:-x}, ${VAR-x}) в image, environment и command раскрываются в дефолт,
остальные (${VAR}, $VAR) известны только при запуске: адрес из такого значения не берётся,
образ с ними технологию не даёт, а место уходит в подсказки.
Один сервис в нескольких файлах (основной и override) — один кандидат: поля поздних файлов
перекрывают ранние, как у самого compose.

Compose по содержимому (ТЗ §13.3): файл YAML не с именем compose, у которого на верхнем
уровне services со словарём и хотя бы у одного сервиса image или build (Sentry
devservices/config.yml), читается по тем же правилам; покрытие называет его «compose по
содержимому: путь». Чтобы не разбирать все YAML репозитория, сначала текст проверяется на
строку «services:» с начала строки. Записи с repo_link или repo_name где угодно в документе
compose (расширения x-*, dependencies) — сервисы других репозиториев: объектов из них нет, они
лежат в hints.external_repos для агента.
"""

from __future__ import annotations

import re
from typing import Any

from archmap_scan import paths, texts
from archmap_scan.context import Context
from archmap_scan.model import EnvVar, Findings, Hint, Loc, Unit, unparsed_hint
from archmap_scan.walk import Files, is_compose_name, is_dev_path
from archmap_scan.yamlload import BadYaml, LineDict, LineList, YamlTooLarge, load

NAME = "compose"
# Подстановка переменной compose: ${VAR}, ${VAR:-x}, $VAR (но не экранированное $$).
_DYNAMIC = re.compile(r"\$\{|\$[A-Za-z_]")
# Быстрая проверка файла YAML до разбора: ключ services верхнего уровня.
_SERVICES_LINE = re.compile(r"^services:[ \t]*(?:#[^\n]*)?$", re.MULTILINE)
# Ключи ссылки на другой репозиторий и обёртки, под которыми она лежит у сервиса
# (dependencies: snuba: remote: {repo_name, repo_link}): имя сервиса — ключ выше обёртки.
_REPO_KEYS = ("repo_link", "repo_name")
_REPO_WRAPPERS = frozenset({"remote", "source", "repo", "repository", "git", "origin"})


def _is_base(name: str) -> bool:
    """Основной файл проекта compose (а не override, prod, dev)."""
    return name.lower() in {
        "compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml",
    }


def _order(rel: str) -> tuple[str, int, str]:
    return (paths.parent(rel), 0 if _is_base(paths.name(rel)) else 1, rel)


# Подстановки с дефолтом раскрываются на глубину не больше этой и ищут закрывающую
# скобку не дальше этого числа символов: значения из чужого репозитория бывают
# враждебными, а разбор обязан оставаться линейным.
_MAX_NESTING = 8
_MAX_SPAN = 4096


def is_dynamic(value: str) -> bool:
    return _DYNAMIC.search(value.replace("$$", "")) is not None


def _closing(value: str, start: int) -> int:
    """Позиция «}», закрывающей подстановку, тело которой начинается в start; -1 — нет."""
    depth = 1
    i = start
    stop = min(len(value), start + _MAX_SPAN)
    while i < stop:
        if value.startswith("${", i):
            depth += 1
            i += 2
            continue
        if value[i] == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def expand(value: str, depth: int = 0) -> str:
    """Раскрыть подстановки compose с дефолтом: ${VAR:-x} и ${VAR-x} дают x. Остальные
    (${VAR}, $VAR, ${VAR:?ошибка}, ${VAR:+x}) известны только при запуске и остаются как
    есть; экранированное $$ не трогается."""
    out: list[str] = []
    i = 0
    n = len(value)
    while i < n:
        if value.startswith("$$", i):
            out.append("$$")
            i += 2
            continue
        if not value.startswith("${", i):
            nxt = value.find("$", i + 1)
            nxt = n if nxt == -1 else nxt
            out.append(value[i:nxt])
            i = nxt
            continue
        end = _closing(value, i + 2)
        if end == -1:
            out.append(value[i:])
            break
        body = value[i + 2:end]
        j = 0
        while j < len(body) and (body[j].isalnum() or body[j] == "_"):
            j += 1
        rest = body[j:]
        default: str | None = None
        if j and rest.startswith(":-"):
            default = rest[2:]
        elif j and rest.startswith("-"):
            default = rest[1:]
        if default is None or depth >= _MAX_NESTING:
            out.append(value[i:end + 1])
        else:
            out.append(expand(default, depth + 1))
        i = end + 1
    return "".join(out)


def _env(svc: LineDict, rel: str, out: list[EnvVar]) -> None:
    env = svc.get("environment")
    if isinstance(env, LineDict):
        for key, value in env.items():
            loc = Loc(rel, env.line_of(key))
            text = None if value is None else expand(_scalar(value))
            out.append(EnvVar(str(key), loc, text, text is not None and is_dynamic(text)))
    elif isinstance(env, LineList):
        for i, item in enumerate(env):
            if not isinstance(item, str) or not item.strip():
                continue
            key, eq, value = item.partition("=")
            loc = Loc(rel, env.line_at(i))
            text = expand(value) if eq else None
            out.append(EnvVar(key.strip(), loc, text, text is not None and is_dynamic(text)))


def _scalar(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _command(svc: LineDict) -> tuple[str | None, int | None]:
    for key in ("command", "entrypoint"):
        value = svc.get(key)
        if isinstance(value, str) and value.strip():
            return expand(" ".join(value.split())), svc.line_of(key)
        if isinstance(value, list) and value:
            return expand(" ".join(_scalar(v) for v in value)), svc.line_of(key)
    return None, None


def _depends(svc: LineDict, rel: str) -> list[tuple[str, Loc]]:
    dep = svc.get("depends_on")
    out: list[tuple[str, Loc]] = []
    if isinstance(dep, LineList):
        out = [(str(d), Loc(rel, dep.line_at(i))) for i, d in enumerate(dep) if d]
    elif isinstance(dep, LineDict):
        out = [(str(d), Loc(rel, dep.line_of(d))) for d in dep]
    return out


def _build(
    svc: LineDict, rel: str, name: str, found: Findings, files: Files,
) -> tuple[str | None, str | None]:
    """Каталог кода и путь Dockerfile из build. Каталог, которого нет в обходе (контекст
    относительно другого корня, удалённый каталог), каталогом кода не считается (ТЗ §5.1)."""
    build = svc.get("build")
    if build is None:
        return None, None
    context: Any = "."
    dockerfile: Any = "Dockerfile"
    if isinstance(build, str):
        context = build
    elif isinstance(build, LineDict):
        context = build.get("context", ".")
        dockerfile = build.get("dockerfile", "Dockerfile")
    if not isinstance(context, str) or "://" in context or context.startswith("git@"):
        return None, None
    folder = paths.join(paths.parent(rel), context)
    if folder is None:
        found.hints.append(Hint("unassigned", {
            "kind": "container", "name": name, "reason": texts.REASON_BUILD_OUTSIDE,
            "source": str(Loc(rel, svc.line_of("build"))),
        }))
        return None, None
    if not files.has_dir(folder):
        found.hints.append(Hint("unassigned", {
            "kind": "container", "name": name, "reason": texts.REASON_BUILD_MISSING,
            "source": str(Loc(rel, svc.line_of("build"))),
        }))
        return None, None
    docker = paths.join(folder, dockerfile) if isinstance(dockerfile, str) else None
    return folder, docker


def _services(doc: LineDict) -> LineDict | None:
    services = doc.get("services")
    if isinstance(services, LineDict):
        return services
    # Формат compose первой версии: сервисы прямо в корне документа.
    if "services" not in doc and "version" not in doc and doc and all(
        isinstance(v, LineDict) and ("image" in v or "build" in v) for v in doc.values()
    ):
        return doc
    return None


def _unit(
    name: str, svc: LineDict, rel: str, line: int, found: Findings, files: Files,
) -> Unit:
    raw_image = svc.get("image")
    image = expand(raw_image) if isinstance(raw_image, str) else None
    folder, docker = _build(svc, rel, name, found, files)
    if image is not None and is_dynamic(image):
        # Имя образа известно только при запуске: технологию по нему не угадываем.
        if folder is None:
            found.hints.append(Hint("dynamic_names", {
                "kind": "image", "name": "image", "object": name,
                "reason": texts.REASON_DYNAMIC_IMAGE, "source": str(Loc(rel, svc.line_of("image"))),
            }))
        image = None
    command, cmd_line = _command(svc)
    unit = Unit(
        name=name,
        parser=NAME,
        loc=Loc(rel, line),
        image=image,
        build_dir=folder,
        dockerfile=docker,
        command=command,
        command_loc=Loc(rel, cmd_line) if cmd_line else None,
        host=name,
    )
    _env(svc, rel, unit.env)
    unit.depends_on = _depends(svc, rel)
    for key, reason in (("extends", texts.REASON_EXTENDS), ("env_file", texts.REASON_ENV_FILE)):
        if key in svc:
            found.hints.append(Hint("unassigned", {
                "kind": "container", "name": name, "reason": reason,
                "source": str(Loc(rel, svc.line_of(key))),
            }))
    return unit


def _merge(into: Unit, other: Unit) -> None:
    """Поздний файл перекрывает поля раннего, переменные и зависимости складываются."""
    into.image = other.image or into.image
    if other.build_dir is not None:
        into.build_dir, into.dockerfile = other.build_dir, other.dockerfile
    if other.command:
        into.command, into.command_loc = other.command, other.command_loc
    names = {e.name for e in other.env}
    into.env = [e for e in into.env if e.name not in names] + other.env
    seen = {d for d, _ in into.depends_on}
    into.depends_on += [(d, loc) for d, loc in other.depends_on if d not in seen]
    into.extra_locs.append(other.loc)


def _is_yaml(rel: str) -> bool:
    return paths.name(rel).lower().endswith((".yaml", ".yml"))


def _by_content(files: Files) -> list[str]:
    """Файлы YAML не с именем compose, похожие на compose по тексту: строка «services:» с
    начала строки. Каталоги чартов Helm сюда не попадают: их читает helm.py, а манифесты k8s
    отсекаются после разбора по apiVersion и kind."""
    charts = [paths.parent(p) for p in files.paths if paths.name(p) == "Chart.yaml"]
    out: list[str] = []
    for rel in files.select(_is_yaml):
        if is_compose_name(paths.name(rel)) or any(paths.under(rel, c) for c in charts):
            continue
        text = files.read(rel)
        if text is not None and _SERVICES_LINE.search(text) is not None:
            out.append(rel)
    return out


def _compose_like(doc: LineDict) -> LineDict | None:
    """Сервисы документа, если он compose по содержимому (ТЗ §13.3): services со словарём на
    верхнем уровне, хотя бы у одного сервиса image или build, и это не манифест k8s."""
    if "apiVersion" in doc and "kind" in doc:
        return None
    services = doc.get("services")
    if not isinstance(services, LineDict) or not any(
        isinstance(v, LineDict) and ("image" in v or "build" in v) for v in services.values()
    ):
        return None
    return services


def _repo_key(node: LineDict) -> str | None:
    return next((k for k in _REPO_KEYS if isinstance(node.get(k), str) and node.get(k)), None)


def _external_repos(doc: LineDict, rel: str, found: Findings) -> None:
    """Сервисы других репозиториев: словарь с repo_link или repo_name где угодно в документе.
    Имя — ключ, под которым лежит словарь, а у обёртки (remote, source) — ключ выше; у
    элемента списка — его ключ name, иначе сама ссылка. Обход без рекурсии в порядке
    документа; документ уже прошёл пределы yamlload."""
    stack: list[tuple[object, list[str | None]]] = [(doc, [])]
    seen: set[int] = set()
    while stack:
        node, keys = stack.pop()
        if id(node) in seen:
            continue
        seen.add(id(node))
        if isinstance(node, LineDict):
            key = _repo_key(node)
            if key is not None:
                names = [k for k in keys if k is None or k.lower() not in _REPO_WRAPPERS]
                own = node.get("name")
                if names and names[-1] is not None:
                    name = names[-1]
                elif isinstance(own, str) and own:
                    name = own
                else:
                    name = str(node[key])
                link = node.get("repo_link")
                found.hints.append(Hint("external_repos", {
                    "kind": "repo", "name": name, "reason": texts.REASON_EXTERNAL_REPO,
                    "source": str(Loc(rel, node.line_of(key))),
                    "repo": link if isinstance(link, str) and link else str(node[key]),
                }))
            stack.extend((v, [*keys, str(k)]) for k, v in reversed(list(node.items())))
        elif isinstance(node, LineList):
            stack.extend((v, [*keys, None]) for v in reversed(node))


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    units: dict[str, Unit] = {}
    dev_only: dict[str, Loc] = {}
    # Файлы для разработки (dev, local, devenv в пути или в имени, walk.is_dev_path)
    # читаются после остальных и в схему не добавляют ничего: их сервисы, которых нет в
    # основных файлах, уходят в подсказки. Compose по содержимому идёт тем же путём.
    content = set(_by_content(files))
    named = files.select(lambda p: is_compose_name(paths.name(p)))
    ordered = sorted([*named, *content], key=_order)
    dev_files = [r for r in ordered if is_dev_path(r)]
    for rel in [r for r in ordered if r not in dev_files] + dev_files:
        services = _load_services(files, rel, found, by_content=rel in content)
        if services is None:
            continue
        dev = rel in dev_files
        if rel in content and not dev:
            # Файл для разработки объектов не даёт, пометка о нём читателя только запутает.
            found.notes.setdefault("containers", []).append(texts.compose_by_content(rel))
        for key, svc in services.items():
            if not isinstance(svc, LineDict):
                continue
            name = str(key)
            line = services.line_of(key)
            profiles = svc.get("profiles")
            if isinstance(profiles, list) and profiles:
                found.hints.append(Hint("profiles", {
                    "kind": "container", "name": name, "reason": texts.REASON_PROFILE,
                    "source": str(Loc(rel, line)), "profiles": sorted(str(p) for p in profiles),
                }))
                continue
            if dev:
                if name not in units:
                    dev_only.setdefault(name, Loc(rel, line))
                continue
            unit = _unit(name, svc, rel, line, found, files)
            if name in units:
                _merge(units[name], unit)
            else:
                units[name] = unit
    for name, loc in dev_only.items():
        found.hints.append(Hint("profiles", {
            "kind": "container", "name": name, "reason": texts.REASON_DEV_FILE,
            "source": str(loc), "profiles": [],
        }))
    found.units.extend(units.values())
    for unit in found.units:
        for var in unit.env:
            if var.dynamic:
                found.hints.append(Hint("dynamic_names", {
                    "kind": "env", "name": var.name, "object": unit.name,
                    "reason": texts.REASON_DYNAMIC_VALUE, "source": str(var.loc),
                }))
    return found


def _load_services(
    files: Files, rel: str, found: Findings, by_content: bool = False,
) -> LineDict | None:
    """Сервисы файла compose. by_content — файл не с именем compose, отобранный по тексту:
    он не compose, пока разбор не покажет services со словарём (ошибка разбора тогда не
    подсказка, у чужого YAML бывают свои расширения)."""
    text = files.read(rel)
    if text is None:
        return None
    try:
        doc = load(text)
    except YamlTooLarge:
        files.refuse(rel)
        return None
    except BadYaml:
        if not by_content:
            found.hints.append(unparsed_hint(rel, texts.REASON_BAD_YAML))
        return None
    if not isinstance(doc, LineDict):
        return None
    services = _compose_like(doc) if by_content else _services(doc)
    if by_content and services is None:
        return None
    _external_repos(doc, rel, found)
    if "include" in doc:
        found.hints.append(Hint("unassigned", {
            "kind": "compose", "name": paths.name(rel), "reason": texts.REASON_INCLUDE,
            "source": str(Loc(rel, doc.line_of("include"))),
        }))
    return services
