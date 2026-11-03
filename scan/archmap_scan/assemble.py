"""Сборка схемы из находок разборщиков (ТЗ §5.1, §7, уточнения задания §3).

Кандидаты из разных манифестов с одним именем — один объект (compose «orders» и Deployment
«orders»). Вид объекта: свой код (каталог сборки) — контейнер; образ без кода — по словарю
образов (база, брокер, сервис). Связи «использует» — только к тому, что видно в манифестах:
адреса в переменных окружения и depends_on к базам и брокерам. Пары сервис→сервис из
depends_on в связи не идут (порядок запуска не вызов), они в подсказках.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from archmap_scan import owners, paths, secrets, texts, vocab
from archmap_scan.context import Context
from archmap_scan.links import hosts_in, link_technology
from archmap_scan.model import (
    Dockerfile,
    EnvVar,
    Findings,
    Loc,
    Package,
    Table,
    TableSet,
    Unit,
)
from archmap_scan.walk import Pattern, is_dev_path

SERVICE, DATABASE, BROKER = "service", "database", "broker"
SHAPE_ORDER = {SERVICE: 0, DATABASE: 1, BROKER: 2}
# Старшинство манифестов при слиянии кандидатов с одним именем.
PRIORITY = {
    "compose": 0, "k8s": 1, "helm": 2, "supervisor": 3, "systemd": 4, "procfile": 5,
    "dockerfile": 6, "implicit": 7,
}
# Манифесты, у которых путь для разработки (walk.is_dev_path) уводит объект в подсказки.
# compose решает это сам: у него есть основные файлы, которые перекрывают dev-файлы.
_DEV_MANIFESTS = frozenset({"supervisor", "systemd", "k8s"})
_VARIANT_IGNORED = frozenset({"prod", "production", "release", "alpine", "slim", "base"})


@dataclass
class Obj:
    """Объект схемы: контейнер, база или брокер (дети корня-системы)."""

    name: str
    shape: str = SERVICE
    role: str | None = None
    technology: str | None = None
    host: str | None = None
    code_dir: str | None = None  # каталог кода контейнера от корня репозитория
    path: str | None = None  # source.path после правила уникальности каталога
    repo: bool = False  # ставить ли source.repo
    locs: set[Loc] = field(default_factory=set)
    parsers: list[str] = field(default_factory=list)
    units: list[Unit] = field(default_factory=list)
    env: list[EnvVar] = field(default_factory=list)
    dockerfile: Dockerfile | None = None
    package_locs: list[Loc] = field(default_factory=list)
    language: str | None = None  # язык кода контейнера: по нему отбираются манифесты и файлы

    @property
    def is_container(self) -> bool:
        return self.shape == SERVICE


@dataclass
class Link:
    src: Obj
    dst: Obj
    label: str
    technology: str | None
    locs: set[Loc] = field(default_factory=set)
    parsers: set[str] = field(default_factory=set)


@dataclass
class Worker:
    """Процесс-воркер или планировщик: команда запуска и очереди из её аргументов."""

    command: str
    queues: list[str]
    loc: Loc
    parser: str
    replicas: int | None = None


@dataclass
class Schedule:
    """Расписание из манифеста (CronJob): имя, расписание как написано, задача."""

    name: str
    schedule: str
    task: str | None
    loc: Loc
    parser: str


@dataclass
class Param:
    """Параметр конфигурации контейнера: имя, тип и дефолт только из примера окружения."""

    name: str
    type: str | None = None
    default: str | None = None
    locs: set[Loc] = field(default_factory=set)
    parsers: set[str] = field(default_factory=set)


@dataclass
class TableStats:
    found: int = 0
    unassigned: int = 0
    dropped: int = 0
    skipped: dict[str, int] = field(default_factory=dict)
    parsers: set[str] = field(default_factory=set)
    errors: list[str] = field(default_factory=list)


@dataclass
class Model:
    system: str
    system_locs: list[Loc]
    objects: list[Obj]
    links: list[Link]
    implicit: bool = False
    db_by_migrations: bool = False  # есть база, определённая по миграциям (ТЗ §7, пункт 3)
    hints: dict[str, list[dict[str, object]]] = field(default_factory=dict)
    workers: dict[str, list[Worker]] = field(default_factory=dict)
    schedules: dict[str, list[Schedule]] = field(default_factory=dict)
    # Параметры по контейнерам: имя контейнера → имя параметра → параметр.
    params: dict[str, dict[str, Param]] = field(default_factory=dict)
    # Таблицы по базам: имя базы → таблицы; счёт для покрытия — в table_stats.
    tables: dict[str, list[Table]] = field(default_factory=dict)
    table_stats: TableStats = field(default_factory=lambda: TableStats())

    def obj(self, name: str) -> Obj | None:
        return next((o for o in self.objects if o.name == name), None)

    def hint(self, section: str, data: dict[str, object]) -> None:
        self.hints.setdefault(section, []).append(data)


def _go_module_name(module: str) -> str:
    parts = [p for p in module.split("/") if p]
    if len(parts) > 1 and parts[-1][:1] == "v" and parts[-1][1:].isdigit():
        parts = parts[:-1]
    return parts[-1] if parts else module


def system_name(ctx: Context, packages: list[Package]) -> tuple[str, list[Loc]]:
    """Имя корня: --system, имя корневого манифеста сборки, иначе имя каталога."""
    if ctx.system:
        return ctx.system, []
    for kind in ("package.json", "pyproject.toml", "go.mod"):
        for pkg in packages:
            if pkg.dir == ctx.scope and pkg.kind == kind and pkg.name:
                name = _go_module_name(pkg.name) if kind == "go.mod" else pkg.name
                return name, [pkg.name_loc] if pkg.name_loc else []
    return ctx.root.name, []


def _variant(rel: str) -> str | None:
    """Суффикс варианта Dockerfile: Dockerfile-postgresql и worker.Dockerfile → имя."""
    low = paths.name(rel)
    for sep in ("Dockerfile.", "Dockerfile-", "dockerfile.", "dockerfile-"):
        if low.startswith(sep):
            rest = low[len(sep):]
            return None if rest.lower() in _VARIANT_IGNORED else rest or None
    for sep in (".Dockerfile", "-Dockerfile", ".dockerfile", "-dockerfile"):
        if low.endswith(sep):
            rest = low[: -len(sep)]
            return None if rest.lower() in _VARIANT_IGNORED else rest or None
    return None


def _dockerfile_units(
    units: list[Unit], dockerfiles: list[Dockerfile], root_name: str, model: Model
) -> list[Unit]:
    """Dockerfile, на который не ссылается ни один манифест, сам задаёт контейнер."""
    used = {u.dockerfile for u in units if u.dockerfile}
    claimed = {u.build_dir for u in units if u.build_dir is not None}
    out: list[Unit] = []
    for d in sorted(dockerfiles, key=lambda x: x.path):
        if d.path in used:
            continue
        if is_dev_path(d.path):
            model.hint("profiles", {
                "service": d.path, "profiles": [], "reason": texts.REASON_DEV_FILE,
                "source": str(d.from_loc),
            })
            continue
        variant = _variant(d.path)
        if variant is None and d.dir in claimed:
            continue
        name = variant or (paths.name(d.dir) if d.dir else root_name)
        kind = vocab.image_kind(d.images[-1])
        # Dockerfile с суффиксом (Dockerfile-postgresql, worker.Dockerfile) каталогом кода
        # не владеет (ТЗ §5.1): вид и технология только по FROM, стек и repo/path каталога
        # ему не достаются.
        out.append(Unit(
            name=name, parser="dockerfile", loc=d.from_loc,
            build_dir=None if variant else d.dir,
            dockerfile=d.path, command=d.command, command_loc=d.command_loc,
            shape=kind.shape if kind and kind.shape != SERVICE else None,
        ))
    return out


def _procfile_web(units: list[Unit]) -> None:
    """Procfile «web» в каталоге кода другого контейнера — это сам контейнер."""
    homes = {u.build_dir: u.name for u in units if u.parser != "procfile" and u.build_dir is not None}
    for u in units:
        if u.parser == "procfile" and u.name == "web" and u.home_dir in homes:
            u.name = homes[u.home_dir]


def _attach_dockerfile(obj: Obj, by_path: dict[str, Dockerfile]) -> None:
    for u in obj.units:
        if u.dockerfile and u.dockerfile in by_path:
            obj.dockerfile = by_path[u.dockerfile]
            obj.locs.add(obj.dockerfile.from_loc)
            return


def _code_packages(obj: Obj, packages: list[Package]) -> list[Package]:
    if obj.code_dir is None:
        return []
    return [p for p in packages if p.dir == obj.code_dir]


def _classify(obj: Obj, packages: list[Package]) -> None:
    """Вид, технология и роль объекта по кандидатам, Dockerfile и манифестам сборки."""
    units = obj.units
    image = next((u.image for u in units if u.image), None)
    shape_hint = next((u.shape for u in units if u.shape), None)
    own_code = obj.code_dir is not None
    if shape_hint is None and not own_code and image:
        kind = vocab.image_kind(image)
        if kind is not None:
            obj.shape, obj.technology, obj.role = kind.shape, kind.technology, kind.role
        else:
            obj.shape, obj.technology = SERVICE, vocab.image_name(image) or None
    elif shape_hint is not None and obj.dockerfile is not None:
        kind = vocab.image_kind(obj.dockerfile.images[-1])
        if kind is not None:
            obj.shape, obj.technology, obj.role = kind.shape, kind.technology, kind.role
    if obj.shape != SERVICE:
        return
    pkgs = [
        p for p in _code_packages(obj, packages)
        if obj.language is None or p.language == obj.language
    ]
    language, server, front = stack_of(pkgs)
    if language is None and obj.dockerfile is not None:
        language = next(
            (lang for img in obj.dockerfile.images if (lang := vocab.image_language(img))), None
        )
    if language is None:
        language = next((u.language for u in units if u.language), None)
    if obj.language is None:
        obj.language = language
    if obj.technology is None:
        obj.technology = vocab.technology(language, server or front)
    for p in pkgs:
        obj.locs.add(p.name_loc or Loc(p.path, 1))
    if obj.role is None:
        explicit = next((u.role for u in units if u.role), None)
        by_cmd = next((r for u in units if (r := vocab.role_by_command(u.command))), None)
        if explicit:
            obj.role = explicit
        elif by_cmd:
            obj.role = by_cmd
        elif front and not server and all(p.language == "Node.js" for p in pkgs):
            obj.role = vocab.ROLE_FRONTEND
        else:
            obj.role = vocab.ROLE_SERVICE


def stack_of(pkgs: list[Package]) -> tuple[str | None, str | None, str | None]:
    """Язык, серверный фреймворк и фреймворк интерфейса каталога кода.

    Фреймворк пишется вместе с языком своего манифеста: в корне с package.json (Koa) и
    pyproject.toml (Django) получится «Python + Django», а не «Node.js + Django». Без
    серверного фреймворка язык — первый язык не Node.js, если такой есть: Go-сервер с
    React-интерфейсом — «Go + React», и это сервис, а не фронтенд."""
    for key, name in vocab.SERVER_FRAMEWORKS:
        for p in pkgs:
            if vocab.find_framework(p.deps, ((key, name),)):
                front = vocab.find_framework(
                    tuple(d for q in pkgs for d in q.deps), vocab.FRONTEND_FRAMEWORKS
                )
                return p.language, name, front
    front = vocab.find_framework(tuple(d for p in pkgs for d in p.deps), vocab.FRONTEND_FRAMEWORKS)
    backend = next((p.language for p in pkgs if p.language != "Node.js"), None)
    language = backend or next((p.language for p in pkgs), None)
    return language, None, front


def _drop_dev_units(units: list[Unit], model: Model) -> list[Unit]:
    """Процессы и нагрузки из манифестов для разработки — в подсказки, не в схему (ТЗ §4)."""
    kept: list[Unit] = []
    for u in units:
        if u.parser in _DEV_MANIFESTS and is_dev_path(u.loc.path):
            model.hint("profiles", {
                "service": u.name, "profiles": [], "reason": texts.REASON_DEV_FILE,
                "source": str(u.loc),
            })
            continue
        kept.append(u)
    return kept


def _objects(
    units: list[Unit], findings: Findings, model: Model, ctx: Context
) -> list[Obj]:
    units = _drop_dev_units(units, model)
    units = units + _dockerfile_units(units, findings.dockerfiles, model.system, model)
    _procfile_web(units)
    by_name: dict[str, Obj] = {}
    for u in sorted(units, key=lambda x: (PRIORITY.get(x.parser, 99), x.loc)):
        obj = by_name.setdefault(u.name, Obj(name=u.name))
        obj.units.append(u)
        obj.locs.add(u.loc)
        obj.locs.update(u.extra_locs)
        if u.command_loc:
            obj.locs.add(u.command_loc)
        if u.parser not in obj.parsers:
            obj.parsers.append(u.parser)
        if obj.host is None and u.host:
            obj.host = u.host
        if obj.code_dir is None:
            obj.code_dir = u.build_dir if u.build_dir is not None else u.home_dir
        obj.env.extend(u.env)
    by_path = {d.path: d for d in findings.dockerfiles}
    spaces = _workspace_dirs(findings, ctx)
    go_binaries = frozenset(
        _go_module_name(p.name) for p in findings.packages if p.kind == "go.mod" and p.name
    )
    for obj in by_name.values():
        if obj.code_dir is None:
            obj.code_dir = _workspace_dir(obj, spaces)
        _attach_dockerfile(obj, by_path)
        _process_stack(obj, findings.packages, ctx, go_binaries)
        _classify(obj, findings.packages)
    return list(by_name.values())


_PROCESS_PARSERS = frozenset({"supervisor", "systemd", "procfile"})


def _process_stack(
    obj: Obj, packages: list[Package], ctx: Context, go_binaries: frozenset[str],
) -> None:
    """Процесс supervisor, systemd или Procfile без каталога кода и образа (находка фазы 1а
    на Zulip: 28 программ без технологии). Команда, которая запускает рантайм языка
    (python3, manage.py, uwsgi, node, бинарь модуля Go), даёт технологию корневого пакета
    этого языка с фреймворком, и процесс владеет корнем как каталогом кода (ТЗ §7). Без
    корневого манифеста этого языка технология — сам язык. Команда, которая запускает
    программу вне репозитория (nginx, cron), даёт технологию по словарю образов."""
    if obj.code_dir is not None or obj.dockerfile is not None:
        return
    if any(u.image for u in obj.units) or any(u.parser not in _PROCESS_PARSERS for u in obj.units):
        return
    command = next((u.command for u in obj.units if u.command), None)
    language = vocab.command_language(command, go_binaries)
    if language is not None:
        obj.language = language
        root = [p for p in packages if p.dir == ctx.scope and p.language == language]
        if root:
            lang, server, front = stack_of(root)
            obj.technology = vocab.technology(lang, server or front)
            obj.code_dir = ctx.scope
        else:
            obj.technology = language
        return
    program = vocab.command_program(command)
    kind = vocab.image_kind(program) if program else None
    if kind is not None:
        obj.shape, obj.technology, obj.role = kind.shape, kind.technology, kind.role


def _workspace_dirs(findings: Findings, ctx: Context) -> list[str]:
    """Каталоги сервисов монорепо: workspaces корневого package.json и services/*, apps/*."""
    globs = ["services/*", "apps/*"]
    for pkg in findings.packages:
        if pkg.kind == "package.json" and pkg.dir == ctx.scope:
            globs += list(pkg.workspaces)
    patterns = [Pattern("/" + g.strip("./")) for g in globs if g.strip("./")]
    prefix = ctx.scope + "/" if ctx.scope else ""
    dirs = {p.dir for p in findings.packages} | {d.dir for d in findings.dockerfiles}
    out = []
    for folder in sorted(dirs):
        if not folder or not folder.startswith(prefix):
            continue
        inner = folder[len(prefix):]
        if inner and any(p.matches(inner, True) for p in patterns):
            out.append(folder)
    return out


def _workspace_dir(obj: Obj, spaces: list[str]) -> str | None:
    """Каталог кода объекта без каталога сборки: каталог монорепо с тем же именем.
    Контейнер из Dockerfile с суффиксом каталогом кода не владеет (ТЗ §5.1)."""
    if any(u.parser == "dockerfile" for u in obj.units):
        return None
    image = next((u.image for u in obj.units if u.image), None)
    if image is not None and vocab.image_kind(image) is not None:
        return None
    same = [d for d in spaces if paths.name(d) == obj.name]
    return same[0] if len(same) == 1 else None


def _implicit(model: Model, findings: Findings, ctx: Context) -> Obj | None:
    """Репозиторий без манифестов контейнеров: один контейнер с именем корня (ТЗ §7)."""
    roots = [p for p in findings.packages if p.dir == ctx.scope]
    if not roots:
        return None
    obj = Obj(name=model.system, code_dir=ctx.scope, parsers=["implicit"])
    obj.units.append(Unit(name=model.system, parser="implicit", loc=roots[0].name_loc
                          or Loc(roots[0].path, 1)))
    _classify(obj, findings.packages)
    return obj


def _redis_brokers(objects: list[Obj], env_vars: list[EnvVar]) -> None:
    """Redis, на который указывает адрес брокера задач, считается брокером, а не кэшем."""
    by_host = {o.host: o for o in objects if o.host}
    for var in env_vars:
        name = var.name.upper()
        if var.dynamic or var.value is None:
            continue
        if name not in vocab.REDIS_BROKER_VARS and not name.startswith(vocab.REDIS_BROKER_PREFIX):
            continue
        for host, _scheme in hosts_in(var.name, var.value):
            obj = by_host.get(host)
            if obj is not None and obj.technology == "Redis":
                obj.shape, obj.role = BROKER, vocab.ROLE_BROKER
                obj.locs.add(var.loc)


def _add_link(
    links: dict[tuple[str, str], Link], src: Obj, dst: Obj, tech: str | None, loc: Loc,
    parser: str,
) -> None:
    key = (src.name, dst.name)
    link = links.get(key)
    if link is None:
        link = links[key] = Link(src=src, dst=dst, label="использует", technology=tech)
    if link.technology is None and tech:
        link.technology = tech
    link.locs.add(loc)
    link.parsers.add(parser)


def _links(model: Model, env_of: dict[str, list[tuple[EnvVar, str]]]) -> list[Link]:
    by_host = {o.host.lower(): o for o in model.objects if o.host}
    by_name = {o.name: o for o in model.objects}
    links: dict[tuple[str, str], Link] = {}
    for src in model.objects:
        if not src.is_container:
            continue
        for var, parser in env_of.get(src.name, []):
            if var.dynamic or var.value is None:
                continue
            for host, scheme in hosts_in(var.name, var.value):
                dst = by_host.get(host)
                if dst is None or dst is src:
                    continue
                tech = dst.technology if dst.shape != SERVICE else link_technology(scheme)
                _add_link(links, src, dst, tech, var.loc, parser)
        for unit in src.units:
            for dep, loc in unit.depends_on:
                dst = by_name.get(dep)
                if dst is None or dst is src:
                    continue
                if dst.shape == SERVICE:
                    if (src.name, dst.name) in links:
                        # Связь уже нарисована по адресу из окружения: подсказка лишняя.
                        continue
                    model.hint("depends_on", {
                        "from": src.name, "to": dst.name, "reason": texts.REASON_DEPENDS_ON,
                        "source": str(loc),
                    })
                    continue
                _add_link(links, src, dst, dst.technology, loc, unit.parser)
    return sorted(links.values(), key=lambda lk: (lk.src.name, lk.dst.name))


def _sources(model: Model, ctx: Context) -> None:
    """repo + path только контейнерам со своим неповторимым каталогом кода (ТЗ §5.1)."""
    by_dir: dict[str, list[Obj]] = {}
    for obj in model.objects:
        if obj.is_container and obj.code_dir is not None:
            by_dir.setdefault(obj.code_dir, []).append(obj)
    for folder, objs in sorted(by_dir.items()):
        if len(objs) == 1:
            objs[0].repo = bool(ctx.repo)
            objs[0].path = folder or None
            continue
        model.hint("shared_code", {
            "path": paths.show_dir(folder), "containers": sorted(o.name for o in objs),
            "reason": texts.REASON_SHARED_CODE,
        })


def assemble(findings: Findings, ctx: Context) -> Model:
    system, system_locs = system_name(ctx, findings.packages)
    model = Model(system=system, system_locs=system_locs, objects=[], links=[])
    for hint in findings.hints:
        model.hint(hint.section, hint.data)
    model.objects = _objects(list(findings.units), findings, model, ctx)
    if not any(o.is_container for o in model.objects):
        implicit = _implicit(model, findings, ctx)
        if implicit is not None:
            model.objects.append(implicit)
            model.implicit = True
    env_of: dict[str, list[tuple[EnvVar, str]]] = {}
    for obj in model.objects:
        for u in obj.units:
            env_of.setdefault(obj.name, []).extend((v, u.parser) for v in u.env)
    containers = [o for o in model.objects if o.is_container]
    for env_file in findings.env_files:
        for obj in owners.code_owners(env_file.path, containers):
            env_of.setdefault(obj.name, []).extend((v, "env-example") for v in env_file.vars)
    _redis_brokers(model.objects, [v for vs in env_of.values() for v, _ in vs]
                   + [v for ef in findings.env_files for v in ef.vars])
    model.objects.sort(key=lambda o: (SHAPE_ORDER[o.shape], o.name))
    model.links = _links(model, env_of)
    _sources(model, ctx)
    _entrypoints(model)
    _params(model, findings, env_of)
    _clients(model, findings)
    _tables(model, findings, env_of)
    _openapi(model, findings)
    return model


def _openapi(model: Model, findings: Findings) -> None:
    """Файлы OpenAPI — подсказка агенту с контейнером-владельцем, если он один (ТЗ §6.1)."""
    containers = [o for o in model.objects if o.is_container]
    for spec in sorted(findings.openapi, key=lambda s: s.path):
        data: dict[str, object] = {"path": spec.path}
        found = owners.code_owners(spec.path, containers)
        if len(found) == 1:
            data["container"] = found[0].name
        if spec.operations is None:
            data["reason"] = texts.REASON_OPENAPI_TOO_LARGE
        else:
            data["operations"] = spec.operations
        model.hint("openapi_files", data)


_SKIPPED_KEY = {"sql": "sql_statements", "alembic": "alembic_operations",
                "django": "django_operations"}
_NO_OWNER = {"no_database": texts.REASON_NO_DATABASE,
             "many_databases": texts.REASON_MANY_DATABASES}


def _tables(
    model: Model, findings: Findings, env_of: dict[str, list[tuple[EnvVar, str]]]
) -> None:
    """Таблицы наборов миграций — базе-владельцу (ТЗ §7), без владельца — в подсказки."""
    containers = [o for o in model.objects if o.is_container]
    databases = [o for o in model.objects if o.shape == DATABASE]
    plain = {name: [v for v, _ in pairs] for name, pairs in env_of.items()}
    stats = model.table_stats
    for ts in sorted(findings.table_sets, key=lambda t: (t.dir, t.parser)):
        if ts.error:
            stats.errors.append(texts.migration_error_in(paths.show_dir(ts.dir), ts.error))
            model.hint("unassigned", {
                "kind": ts.parser, "name": paths.show_dir(ts.dir),
                "reason": texts.migration_failed(ts.error), "source": ts.dir or ".",
            })
            continue
        if ts.tables:
            stats.parsers.add(ts.parser)
        stats.found += len(ts.tables)
        stats.dropped += ts.dropped
        if ts.skipped:
            key = _SKIPPED_KEY.get(ts.parser, ts.parser)
            stats.skipped[key] = stats.skipped.get(key, 0) + ts.skipped
        for loc, text in ts.skipped_examples:
            model.hint("unassigned", {
                "kind": ts.parser, "name": text, "reason": texts.REASON_SKIPPED_STATEMENT,
                "source": str(loc),
            })
        db, why = owners.database_for(ts.dir, containers, databases, plain)
        if db is None and why == "no_database" and ts.tables:
            db = _migration_database(model, ts, containers)
        if db is None:
            stats.unassigned += len(ts.tables)
            for table in ts.tables:
                model.hint("unassigned", {
                    "kind": "table", "name": table.name, "reason": _NO_OWNER[why or ""],
                    "source": str(min(table.locs)),
                })
            continue
        bucket = model.tables.setdefault(db.name, [])
        for table in ts.tables:
            same = next((t for t in bucket if (t.schema, t.name) == (table.schema, table.name)), None)
            if same is None:
                bucket.append(table)
                continue
            same.locs.extend(table.locs)
            for col in table.columns:
                if same.column(col.name) is None:
                    same.columns.append(col)


_MIGRATION_LANGUAGE = {"alembic": "Python", "django": "Python"}


def _migration_database(model: Model, ts: TableSet, containers: list[Obj]) -> Obj:
    """Базы в манифестах нет, а миграции есть (Sentry, Zulip): объект-база по признакам
    миграций (ТЗ §7, пункт 3). Имя — имя диалекта, диалект не опознан — «База данных» без
    технологии; source нет. Контейнер-владелец каталога миграций, если он определён,
    получает связь «использует»."""
    name = ts.dialect or texts.UNKNOWN_DATABASE
    db = model.obj(name)
    if db is None:
        db = Obj(name=name, shape=DATABASE, role=vocab.ROLE_DB, technology=ts.dialect)
        model.objects.append(db)
        model.objects.sort(key=lambda o: (SHAPE_ORDER[o.shape], o.name))
        model.db_by_migrations = True
    if ts.parser not in db.parsers:
        db.parsers.append(ts.parser)
    first = min(loc for table in ts.tables for loc in table.locs)
    db.locs.add(ts.dialect_loc or first)
    found = owners.file_owners(ts.dir or ".", containers, _MIGRATION_LANGUAGE.get(ts.parser))
    owner = owners.primary(found, vocab.ROLE_SERVICE)
    if owner is not None:
        links = {(lk.src.name, lk.dst.name): lk for lk in model.links}
        link = links.get((owner.name, db.name))
        if link is None:
            link = Link(src=owner, dst=db, label="использует", technology=db.technology)
            model.links.append(link)
            model.links.sort(key=lambda lk: (lk.src.name, lk.dst.name))
        link.locs.add(first)
        link.parsers.add(ts.parser)
    return db


def _params(
    model: Model, findings: Findings, env_of: dict[str, list[tuple[EnvVar, str]]]
) -> None:
    """Параметры конфигурации (ТЗ §7): environment манифеста — прямо его контейнеру, пример
    окружения — контейнеру своего каталога; одинаковый параметр у двух контейнеров — две
    записи. Дефолт и тип только из примера и только по инварианту 6."""
    containers = [o for o in model.objects if o.is_container]
    for obj in containers:
        for var, parser in env_of.get(obj.name, []):
            table = model.params.setdefault(obj.name, {})
            param = table.setdefault(var.name, Param(name=var.name))
            param.locs.add(var.loc)
            param.parsers.add(parser)
            if parser != "env-example":
                continue
            if param.type is None:
                param.type = secrets.value_type(var.value)
            if param.default is None and not var.dynamic:
                param.default = secrets.safe_default(var.name, var.value)
    for env_file in findings.env_files:
        if owners.code_owners(env_file.path, containers):
            continue
        for var in env_file.vars:
            model.hint("unassigned", {
                "kind": "config", "name": var.name, "reason": texts.REASON_SHARED_LIB,
                "source": str(var.loc),
            })


def _clients(model: Model, findings: Findings) -> None:
    """Клиентские библиотеки контейнера — подсказка вида его зависимостей (ТЗ §6.1)."""
    for obj in model.objects:
        if not obj.is_container:
            continue
        for pkg in _code_packages(obj, findings.packages):
            for lib, kind in vocab.clients_of(pkg.deps):
                model.hint("clients", {
                    "container": obj.name, "library": lib, "kind": kind,
                    "source": str(pkg.name_loc or Loc(pkg.path, 1)),
                })


def _entrypoints(model: Model) -> None:
    """Воркеры и планировщики с командами запуска, расписания CronJob (ТЗ §5.3)."""
    for obj in model.objects:
        if not obj.is_container:
            continue
        workers: list[Worker] = []
        if obj.role in (vocab.ROLE_WORKER, vocab.ROLE_SCHEDULER):
            for u in obj.units:
                if u.command and all(w.command != u.command for w in workers):
                    workers.append(Worker(
                        command=u.command, queues=vocab.queues_in(u.command),
                        loc=u.command_loc or u.loc, parser=u.parser, replicas=u.replicas,
                    ))
        if workers:
            model.workers[obj.name] = workers
        schedules = [
            Schedule(name=u.name, schedule=u.schedule, task=u.command, loc=u.loc, parser=u.parser)
            for u in obj.units
            if u.schedule
        ]
        if schedules:
            model.schedules[obj.name] = schedules
