"""docker-compose*.y*ml и compose*.y*ml (ТЗ §6.1).

Сервис compose — кандидат в объект: имя, образ, каталог сборки, команда, переменные
окружения (имена; значения только ради адресов зависимостей), depends_on. Сервисы под
profiles и сервисы, которые есть только в файлах для разработки (признак по месту и форме
или служебная сборка, walk.manifest_sign), в схему не идут, а перечисляются в подсказках;
так же и сервис файла-основы,
который расширяют (extends) только файлы разработки (_dev_bases). extends и include не
раскрываются. Подстановки с
дефолтом (${VAR:-x}, ${VAR-x}) в image, environment и command раскрываются в дефолт,
остальные (${VAR}, $VAR) известны только при запуске: адрес из такого значения не берётся,
образ с ними технологию не даёт, а место уходит в подсказки. Закоммиченный в git .env рядом
с файлом (ТЗ §15 п. 12 С13) раскрывает ${VAR} и ${VAR:-x} в image, build (context,
dockerfile), environment и depends_on; без git он не читается.
Один сервис в нескольких файлах (основной и override) — один кандидат: поля поздних файлов
перекрывают ранние, как у самого compose.

Compose по содержимому (ТЗ §13.3): файл YAML не с именем compose, у которого на верхнем
уровне services со словарём и хотя бы у одного сервиса image или build (Sentry
devservices/config.yml), читается по тем же правилам; покрытие называет его «compose по
содержимому: путь». Чтобы не разбирать все YAML репозитория, сначала текст проверяется на
строку «services:» с начала строки. Записи с repo_link или repo_name где угодно в документе
compose (расширения x-*, dependencies) — сервисы других репозиториев: объектов из них нет, они
лежат в hints.external_repos для агента.

Блок x-programs верхнего уровня (ТЗ §13.3, ч. 2 В5: devservices/config.yml Sentry, 21
программа) {имя: {command: строка}} даёт процессы, как Procfile: роль по имени и словам
команды (vocab.role_by_program), команда в entrypoints.workers, каталог кода — корень
обхода. Признак разработки у программ тот же, что у файла, режимы devservices к ним не
применяются (программы перечислены только в режимах, кроме default). Программа с именем
сервиса того же файла склеивается с ним. Блоки x-* без command процессов не дают.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

from archmap_scan import paths, texts, vocab
from archmap_scan.context import Context, tracked_files
from archmap_scan.model import (
    EnvVar,
    Findings,
    Hint,
    ImageBuild,
    Loc,
    Unit,
    unparsed_hint,
)
from archmap_scan.walk import Files, is_compose_name, manifest_sign, name_tokens
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


def expand(value: str, depth: int = 0, env: Mapping[str, str] | None = None) -> str:
    """Раскрыть подстановки compose с дефолтом: ${VAR:-x} и ${VAR-x} дают x. Остальные
    (${VAR}, $VAR, ${VAR:?ошибка}, ${VAR:+x}) известны только при запуске и остаются как
    есть; экранированное $$ не трогается. env — переменные закоммиченного .env рядом с
    файлом (ТЗ §15 п. 12 С13): ими раскрываются ${VAR}, ${VAR:-x} и ${VAR-x}, когда VAR
    задана (у «:-» непустой); $VAR без скобок и прочие формы остаются как есть."""
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
        known = env.get(body[:j]) if env is not None and j else None
        if known is not None and (rest == "" or rest.startswith("-") or (
            rest.startswith(":-") and known != ""
        )):
            default = known
        if default is None or depth >= _MAX_NESTING:
            out.append(value[i:end + 1])
        else:
            out.append(expand(default, depth + 1, env))
        i = end + 1
    return "".join(out)


def _env(
    svc: LineDict, rel: str, out: list[EnvVar], dotenv: Mapping[str, str] | None = None,
) -> None:
    env = svc.get("environment")
    if isinstance(env, LineDict):
        for key, value in env.items():
            loc = Loc(rel, env.line_of(key))
            text = None if value is None else expand(_scalar(value), env=dotenv)
            out.append(EnvVar(str(key), loc, text, text is not None and is_dynamic(text)))
    elif isinstance(env, LineList):
        for i, item in enumerate(env):
            if not isinstance(item, str) or not item.strip():
                continue
            key, eq, value = item.partition("=")
            loc = Loc(rel, env.line_at(i))
            text = expand(value, env=dotenv) if eq else None
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


def _depends(
    svc: LineDict, rel: str, dotenv: Mapping[str, str] | None = None,
) -> list[tuple[str, Loc]]:
    dep = svc.get("depends_on")
    out: list[tuple[str, Loc]] = []
    if isinstance(dep, LineList):
        out = [(str(d), Loc(rel, dep.line_at(i))) for i, d in enumerate(dep) if d]
    elif isinstance(dep, LineDict):
        out = [(str(d), Loc(rel, dep.line_of(d))) for d in dep]
    if dotenv is not None:
        out = [(expand(name, env=dotenv), loc) for name, loc in out]
    return out


def _build(
    svc: LineDict, rel: str, name: str, found: Findings, files: Files, quiet: bool = False,
    dotenv: Mapping[str, str] | None = None,
) -> tuple[str | None, str | None]:
    """Каталог кода и путь Dockerfile из build. Каталог, которого нет в обходе (контекст
    относительно другого корня, удалённый каталог), каталогом кода не считается (ТЗ §5.1).
    quiet — без подсказок о негодном контексте (сервис файла для разработки). Подстановки в
    context и dockerfile раскрываются только переменными закоммиченного .env (dotenv, С13)."""
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
    if dotenv is not None:
        context = expand(context, env=dotenv) if isinstance(context, str) else context
        dockerfile = expand(dockerfile, env=dotenv) if isinstance(dockerfile, str) else dockerfile
    if not isinstance(context, str) or "://" in context or context.startswith("git@"):
        return None, None
    folder = paths.join(paths.parent(rel), context)
    if quiet and (folder is None or not files.has_dir(folder)):
        return None, None
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
    dotenv: Mapping[str, str] | None = None,
) -> Unit:
    raw_image = svc.get("image")
    image = expand(raw_image, env=dotenv) if isinstance(raw_image, str) else None
    folder, docker = _build(svc, rel, name, found, files, dotenv=dotenv)
    if image is not None and is_dynamic(image):
        # Имя образа известно только при запуске: технологию по нему не угадываем.
        if folder is None:
            found.hints.append(Hint("dynamic_names", {
                "kind": "image", "name": "image", "object": name,
                "reason": texts.REASON_DYNAMIC_IMAGE, "source": str(Loc(rel, svc.line_of("image"))),
            }))
        image = None
    command, cmd_line = _command(svc)
    restart = svc.get("restart")
    entry = svc.get("entrypoint")
    if isinstance(entry, list):
        entry = " ".join(_scalar(v) for v in entry)
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
        # restart: no без кавычек YAML читает как false.
        restart=("no" if restart is False else str(restart).lower())
        if isinstance(restart, (str, bool)) else None,
        entrypoint=expand(" ".join(entry.split())) if isinstance(entry, str) and entry.strip()
        else None,
    )
    _env(svc, rel, unit.env, dotenv)
    unit.depends_on = _depends(svc, rel, dotenv)
    for key, reason in (("extends", texts.REASON_EXTENDS), ("env_file", texts.REASON_ENV_FILE)):
        if key in svc:
            found.hints.append(Hint("unassigned", {
                "kind": "container", "name": name, "reason": reason,
                "source": str(Loc(rel, svc.line_of(key))),
            }))
    return unit


def _programs(doc: LineDict) -> list[tuple[str, LineDict, int]]:
    """Программы блока x-programs верхнего уровня с командой: (имя, запись, строка)."""
    block = doc.get("x-programs")
    if not isinstance(block, LineDict):
        return []
    out: list[tuple[str, LineDict, int]] = []
    for key, entry in block.items():
        if not isinstance(entry, LineDict) or _command(entry)[0] is None:
            continue
        out.append((str(key), entry, block.line_of(key)))
    return out


def _program_unit(name: str, entry: LineDict, rel: str, line: int, scope: str) -> Unit:
    """Процесс программы x-programs (ТЗ §15 п. 13 В5): как строка Procfile с кодом в корне
    (сборка снимает его, если есть контейнер со своей сборкой, Д10)."""
    command, cmd_line = _command(entry)
    text = command or ""
    return Unit(
        name=name, parser=NAME, loc=Loc(rel, line), command=text,
        command_loc=Loc(rel, cmd_line) if cmd_line else None,
        role=vocab.role_by_program(name, text), home_dir=scope,
    )


def _merge(into: Unit, other: Unit) -> None:
    """Поздний файл перекрывает поля раннего, переменные и зависимости складываются."""
    into.image = other.image or into.image
    if other.build_dir is not None:
        into.build_dir, into.dockerfile = other.build_dir, other.dockerfile
    if other.command:
        into.command, into.command_loc = other.command, other.command_loc
    into.restart = other.restart or into.restart
    into.entrypoint = other.entrypoint or into.entrypoint
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


# Имя стенда (ТЗ §15 п. 13 Д8): верхний ключ name: файла compose со словом из перечня
# (posthog-multinode-smoke PostHog поднимает кластер ClickHouse для проверки миграций) —
# файл стенда разработки или замеров. Имя проекта compose — строчные буквы, цифры, «-» и
# «_», поэтому слова — части между ними (walk.name_tokens); contest-shop не test.
_STAND_NAME_WORDS = frozenset({
    "smoke", "test", "tests", "ci", "e2e", "dev", "local", "bench", "benchmark",
})


def _stand_name(doc: LineDict) -> str | None:
    """Признак «имя стенда» по верхнему ключу name: файла или None."""
    name = doc.get("name")
    if not isinstance(name, str) or not name.strip():
        return None
    shown = expand(name.strip())
    return texts.dev_sign_stand_name(shown) if name_tokens(shown) & _STAND_NAME_WORDS else None


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    units: dict[str, Unit] = {}
    dev_units: dict[str, Unit] = {}
    # Файлы для разработки (признак по месту и форме или служебная сборка,
    # walk.manifest_sign) читаются после
    # остальных. Их сервисы, которых нет в основных файлах, становятся кандидатами с
    # признаком разработки (Unit.dev), а их судьбу решает сборка по ступени политики (ТЗ §15
    # п. 10 Б2, Б3). Compose по содержимому идёт тем же путём.
    content = set(_by_content(files))
    named = files.select(lambda p: is_compose_name(paths.name(p)))
    ordered = sorted([*named, *content], key=_order)
    signs = {rel: manifest_sign(rel) for rel in ordered}
    dev_files = {rel for rel in ordered if signs[rel]}
    docs: dict[str, LineDict] = {}
    programs: dict[str, list[tuple[str, LineDict, int]]] = {}
    modes: dict[str, dict[str, tuple[str, list[str]]]] = {}
    stands: dict[str, str | None] = {}
    for rel in [r for r in ordered if r not in dev_files] + [r for r in ordered if r in dev_files]:
        loaded = _load_services(files, rel, found, by_content=rel in content)
        if loaded is not None:
            docs[rel] = loaded[0]
            programs[rel] = _programs(loaded[1])
            stands[rel] = _stand_name(loaded[1])
            if rel in dev_files:
                modes[rel] = _devservices(loaded[1], loaded[0], rel)
    # Файл Laravel Sail целиком окружение разработки (ТЗ §15 п. 12 С6в): его базы и
    # кэш поднимаются для того же стенда. Так же файл с именем стенда (Д8).
    for rel, services in docs.items():
        sail = None if signs[rel] else stands.get(rel) or _sail(services, rel)
        if sail is not None:
            signs[rel] = sail
            dev_files.add(rel)
    docs = {r: docs[r] for r in [*(r for r in docs if r not in dev_files),
                                 *(r for r in docs if r in dev_files)]}
    bases = _dev_bases(docs, dev_files)
    dotenvs = _dotenvs(files, ctx, list(docs))
    for rel, services in docs.items():
        dev = signs[rel]
        # Пометка о compose по содержимому у файла разработки нужна, только если он даст
        # объекты (ступень 2): она едет с его кандидатами (Unit.dev_notes).
        note = texts.compose_by_content(rel) if rel in content else None
        if note is not None and not dev:
            found.notes.setdefault("containers", []).append(note)
        entries = [(str(k), v, services.line_of(k), False) for k, v in services.items()]
        entries += [(name, entry, line, True) for name, entry, line in programs.get(rel, [])]
        for name, svc, line, program in entries:
            if not isinstance(svc, LineDict):
                continue
            if program:
                unit = _program_unit(name, svc, rel, line, ctx.scope)
                if dev is None:
                    if name in units:
                        _merge(units[name], unit)
                    else:
                        units[name] = unit
                elif name not in units:
                    unit.dev = dev
                    unit.dev_notes = [note] if note is not None else []
                    if name in dev_units:
                        _merge(dev_units[name], unit)
                    else:
                        dev_units[name] = unit
                continue
            if _profiles(svc):
                found.hints.append(Hint("profiles", {
                    "kind": "container", "name": name, "reason": texts.REASON_PROFILE,
                    "source": str(Loc(rel, line)),
                    "profiles": sorted(str(p) for p in _profiles(svc)),
                }))
                continue
            sign = dev or bases.get((rel, name)) or _service_dev(name, svc, rel)
            skip = modes.get(rel, {}).get(name)
            if skip is not None and name not in units:
                # Сервис вне режима default devservices или отладочный: объектом не
                # становится ни на какой ступени политики (ТЗ §15 п. 10 Б3).
                found.hints.append(Hint("profiles", {
                    "kind": "container", "name": name, "reason": texts.dev_manifest(skip[0]),
                    "source": str(Loc(rel, line)), "profiles": skip[1],
                }))
                continue
            if sign is not None:
                if dev:
                    # Сборка сервиса в файле для разработки называет Dockerfile его образа: у
                    # сервиса основных файлов это Dockerfile его же контейнера (ТЗ §15 п. 10
                    # А6).
                    folder, docker = _build(
                        svc, rel, name, found, files, quiet=True, dotenv=dotenvs.get(rel),
                    )
                    if folder is not None and docker is not None:
                        found.image_builds.append(ImageBuild(
                            dockerfile=docker, loc=Loc(rel, svc.line_of("build")),
                            build_dir=folder, unit=name,
                        ))
                if name not in units:
                    # Подсказки разбора сервиса разработки идут в вывод, только если он
                    # станет объектом (Unit.dev_hints).
                    own = Findings()
                    unit = _unit(name, svc, rel, line, own, files, dotenvs.get(rel))
                    unit.dev, unit.dev_hints = sign, own.hints
                    unit.dev_notes = [note] if note is not None else []
                    if name in dev_units:
                        _merge(dev_units[name], unit)
                        dev_units[name].dev_hints += unit.dev_hints
                        dev_units[name].dev_notes += unit.dev_notes
                    else:
                        dev_units[name] = unit
                continue
            unit = _unit(name, svc, rel, line, found, files, dotenvs.get(rel))
            if name in units:
                _merge(units[name], unit)
            else:
                units[name] = unit
    found.units.extend(units.values())
    found.units.extend(dev_units.values())
    for unit in found.units:
        hints = found.hints if unit.dev is None else unit.dev_hints
        for var in unit.env:
            if var.dynamic:
                hints.append(Hint("dynamic_names", {
                    "kind": "env", "name": var.name, "object": unit.name,
                    "reason": texts.REASON_DYNAMIC_VALUE, "source": str(var.loc),
                }))
    return found


_DOTENV = ".env"


def _dotenvs(files: Files, ctx: Context, rels: list[str]) -> dict[str, dict[str, str]]:
    """Переменные .env из каталога каждого файла compose (ТЗ §15 п. 12 С13): только
    закоммиченный в git файл (закоммиченный файл не секрет), только для подстановки в поля
    compose. Без git .env не читается никогда, его значения не параметры и не факты."""
    near = {rel: paths.join(paths.parent(rel), _DOTENV) or _DOTENV for rel in rels}
    present = set(files.paths)
    wanted = {env for env in near.values() if env in present}
    if not wanted or not ctx.git:
        return {}
    tracked = tracked_files(ctx)
    # Разбор строк — тот же, что у примеров окружения (envexample.parse_text); импорт
    # внутри функции: envexample сам берёт is_dynamic у этого модуля.
    from archmap_scan.parsers import envexample

    values: dict[str, dict[str, str]] = {}
    for env in sorted(wanted & tracked):
        text = files.read(env)
        if text is not None:
            values[env] = {
                v.name: v.value for v in envexample.parse_text(env, text).vars
                if v.value is not None
            }
    return {rel: values[env] for rel, env in near.items() if env in values}


_SAIL_CONTEXT = "vendor/laravel/sail"
_SAIL_IMAGE = "sail-"


def _sail(services: LineDict, rel: str) -> str | None:
    """Признак файла Laravel Sail: контекст сборки сервиса внутри vendor/laravel/sail или
    образ sail-* (sail-8.4/app Monica). Каталога vendor в обходе нет (С1), поэтому
    сравнивается путь контекста из файла."""
    for key, svc in services.items():
        if not isinstance(svc, LineDict):
            continue
        build = svc.get("build")
        context = build.get("context") if isinstance(build, LineDict) else build
        folder = paths.join(paths.parent(rel), context) if isinstance(context, str) else None
        image = svc.get("image")
        if (folder is not None and paths.under(folder, _SAIL_CONTEXT)) or (
            isinstance(image, str) and image.strip().lower().startswith(_SAIL_IMAGE)
        ):
            return texts.dev_sign_sail(str(Loc(rel, services.line_of(key))))
    return None


def _service_dev(name: str, svc: LineDict, rel: str) -> str | None:
    """Признак разработки по форме сервиса (ТЗ §15 п. 12 С6): команда разработки (установка
    зависимостей, посев, сервер разработки, тесты, слежение, заглушка), раннер тестов по
    имени сервиса, образ инструмента разработчика (vocab.DEV_TOOL_IMAGES) или тег образа
    разработки (ТЗ §15 п. 13 Д1, vocab.dev_image_tag). Тег считается только у образа, который
    берётся готовым: у сервиса с build образ — имя результата локальной сборки (Forem:
    ghcr.io/forem/forem:1.0.0-development у web, rails и sidekiq боевого файла)."""
    for key in ("command", "entrypoint"):
        value = svc.get(key)
        text = " ".join(_scalar(v) for v in value) if isinstance(value, list) else value
        word = vocab.dev_command(text) if isinstance(text, str) else None
        if word is not None:
            return texts.dev_sign_command(word, str(Loc(rel, svc.line_of(key))))
    if name_tokens(name) & vocab.DEV_TEST_RUNNERS:
        return texts.dev_sign_test_service(name)
    image = svc.get("image")
    tool = vocab.dev_tool(image) if isinstance(image, str) else None
    if tool is not None:
        return texts.dev_sign_tool(tool)
    tag = vocab.dev_image_tag(expand(image)) if isinstance(image, str) else None
    if tag is not None and "build" not in svc:
        return texts.dev_sign_image_tag(tag)
    return None


def _profiles(svc: LineDict) -> list[Any]:
    profiles = svc.get("profiles")
    return list(profiles) if isinstance(profiles, list) and profiles else []


def _dev_bases(docs: dict[str, LineDict], dev_files: set[str]) -> dict[tuple[str, str], str]:
    """Сервисы файла-основы, которые расширяют (extends.file) только файлы разработки и
    которых нет без profiles ни в одном другом боевом файле, тоже разработка (ТЗ §15 п. 10
    Б1: maildev, kafka_ui и flower PostHog в docker-compose.base.yml). Сервис основы со своей
    сборкой (build) остаётся: это код репозитория, а не инструмент разработчика
    (usage-ingestion PostHog). Ответ: (файл основы, сервис) → признак."""
    users: dict[tuple[str, str], set[str]] = {}
    shown: dict[str, set[str]] = {}
    for rel, services in docs.items():
        for key, svc in services.items():
            if not isinstance(svc, LineDict):
                continue
            if rel not in dev_files and not _profiles(svc):
                shown.setdefault(str(key), set()).add(rel)
            ext = svc.get("extends")
            if not isinstance(ext, LineDict):
                continue
            file, service = ext.get("file"), ext.get("service")
            if isinstance(file, str) and isinstance(service, str):
                base = paths.join(paths.parent(rel), file)
                if base is not None and base != rel:
                    users.setdefault((base, service), set()).add(rel)
    out: dict[tuple[str, str], str] = {}
    for (base, service), by in users.items():
        if base in dev_files or base not in docs or not by <= dev_files:
            continue
        svc = docs[base].get(service)
        if isinstance(svc, LineDict) and "build" not in svc and not shown.get(service, set()) - {base}:
            out[(base, service)] = texts.dev_sign_base(base)
    return out


_DEBUG = re.compile(r"\bdebug", re.IGNORECASE)
_DESCRIPTION_CHARS = 1000


def _devservices(
    doc: LineDict, services: LineDict, rel: str,
) -> dict[str, tuple[str, list[str]]]:
    """Режимы devservices (ТЗ §15 п. 10 Б3): блок x-* верхнего уровня с modes, где есть
    режим default (x-sentry-service-config Sentry). Сервис, которого нет в default и под
    которого нет своего режима, нужен только сценарию другого режима (bigtable и
    redis-cluster только в backend-ci, relay-cell и relay-edge только в cell-routing);
    memcached со своим режимом memcached остаётся. Сервис со словом debug в описании
    (dependencies.<имя>.description) отладочный (spotlight «for local debugging»). Ответ:
    имя → (признак, режимы сервиса)."""
    out: dict[str, tuple[str, list[str]]] = {}
    for key, block in doc.items():
        if not str(key).startswith("x-") or not isinstance(block, LineDict):
            continue
        modes = block.get("modes")
        if not isinstance(modes, LineDict) or not isinstance(modes.get("default"), list):
            continue
        member: dict[str, list[str]] = {}
        for mode, names in modes.items():
            if isinstance(names, list):
                for item in names:
                    member.setdefault(str(item), []).append(str(mode))
        deps = block.get("dependencies")
        for name in (str(k) for k in services):
            own = member.get(name, [])
            if "default" not in own and name not in modes:
                out[name] = (texts.dev_sign_modes(own), own)
                continue
            entry = deps.get(name) if isinstance(deps, LineDict) else None
            if not isinstance(entry, LineDict):
                continue
            text = entry.get("description")
            if isinstance(text, str) and _DEBUG.search(text[:_DESCRIPTION_CHARS]):
                where = str(Loc(rel, entry.line_of("description")))
                out[name] = (texts.dev_sign_debug(where), own)
    return out


def _load_services(
    files: Files, rel: str, found: Findings, by_content: bool = False,
) -> tuple[LineDict, LineDict] | None:
    """Сервисы файла compose и сам документ. by_content — файл не с именем compose,
    отобранный по тексту: он не compose, пока разбор не покажет services со словарём
    (ошибка разбора тогда не подсказка, у чужого YAML бывают свои расширения)."""
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
    return (services, doc) if services is not None else None
