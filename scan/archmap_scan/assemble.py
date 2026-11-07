"""Сборка схемы из находок разборщиков (ТЗ §5.1, §7, уточнения задания §3).

Кандидаты из разных манифестов с одним именем — один объект (compose «orders» и Deployment
«orders»). Вид объекта: свой код (каталог сборки) — контейнер; образ без кода — по словарю
образов (база, брокер, сервис). Связи «использует» — только к тому, что видно в манифестах:
адреса в переменных окружения и depends_on к базам и брокерам. Пары сервис→сервис из
depends_on в связи не идут (порядок запуска не вызов), они в подсказках.
"""

from __future__ import annotations

from archmap_scan import codefacts, owners, paths, secrets, texts, vocab
from archmap_scan.context import Context
from archmap_scan.dialect import SQLITE
from archmap_scan.links import hosts_in, link_technology
from archmap_scan.model import (
    Dockerfile,
    EnvVar,
    Findings,
    ImageBuild,
    Loc,
    Package,
    TableSet,
    Unit,
)
from archmap_scan.objects import (
    BROKER,
    DATABASE,
    SERVICE,
    SHAPE_ORDER,
    Link,
    Model,
    Obj,
    Param,
    Schedule,
    Worker,
)
from archmap_scan.walk import Pattern, dev_sign, manifest_sign, mobile_dir, service_sign

# Старшинство манифестов при слиянии кандидатов с одним именем.
PRIORITY = {
    "compose": 0, "k8s": 1, "helm": 2, "supervisor": 3, "systemd": 4, "procfile": 5,
    "dockerfile": 6, "buildfiles": 7, "implicit": 8,
}
# Манифесты, у которых признак разработки по пути (walk.dev_sign) ставит сборка; compose и
# Procfile ставят его сами (Unit.dev): у compose есть ещё основа с extends, у Procfile —
# запуск менеджером процессов. Признак служебной сборки (walk.service_sign) получают все
# они, кроме Helm (ТЗ §15 п. 12 С3).
_DEV_MANIFESTS = frozenset({"supervisor", "systemd", "k8s", "helm"})
_NO_SERVICE_SIGN = frozenset({"helm"})
_DEVCONTAINER = ".devcontainer"
# Манифесты развёртывания: хоть один без признака разработки — ступень 1 политики, ни
# одного — ступень 2 (ТЗ §15 п. 10 Б2, Б3). Dockerfile и файлы сборки манифестом
# развёртывания не считаются.
_MANIFEST_PARSERS = frozenset({"compose", "k8s", "helm", "systemd", "supervisor", "procfile"})
_VARIANT_IGNORED = frozenset({"prod", "production", "release", "alpine", "slim", "base"})
# Суффиксы Dockerfile для разработки: рядом с основным Dockerfile это вариант того же
# контейнера (hints.merged), без основного — манифест разработки (ТЗ §15 п. 10 А6).
_DEV_VARIANTS = frozenset({"debug", "dev", "test", "e2e", "playwright", "tilt"})
# Имена каталогов, которые не называют контейнер: Dockerfile в src/ сервиса cartservice
# принадлежит cartservice, а не объекту «src».
_GENERIC_DIRS = frozenset({"src", "app", "docker", "build"})




def _is_task(unit: Unit, image: str, images: dict[str, str]) -> bool:
    """Сервис compose на образе базы или брокера — разовая задача (ТЗ §15 п. 10 А8), если
    у него своя команда и он выходит: оболочка (sh -c …) с restart «no» или «on-failure»
    либо с depends_on на сервис того же образа (kafka-init ждёт kafka и создаёт топики);
    программа образа — только с restart «no» и зависимостью от сервиса того же образа.
    Сервер с restart: on-failure (kafka PostHog: redpanda start) и реплика с командой
    сервера (postgres … с depends_on на основную базу) задачами не становятся."""
    run = unit.entrypoint or unit.command
    if unit.parser != "compose" or not run:
        return False
    same = any(images.get(dep) == image for dep, _ in unit.depends_on if dep != unit.name)
    if vocab.is_shell(run):
        return unit.restart in ("no", "on-failure") or same
    return unit.restart == "no" and same


def _tasks(model: Model) -> None:
    """Задачи на образе базы или брокера — сервисы с ролью «задача»: ни базой, ни брокером
    они не считаются, а depends_on к ним уходит в подсказки, как к любому сервису."""
    images: dict[str, str] = {}
    for obj in model.objects:
        image = next((u.image for u in obj.units if u.image), None)
        if image is not None:
            images[obj.name] = vocab.image_name(image)
    for obj in model.objects:
        if obj.shape not in (DATABASE, BROKER) or obj.name not in images:
            continue
        if any(_is_task(u, images[obj.name], images) for u in obj.units):
            obj.shape, obj.role = SERVICE, vocab.ROLE_TASK
            obj.technology = images[obj.name]


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


def _flat(name: str) -> str:
    """Имя для сравнения образа с каталогом: без регистра, дефисов, точек и подчёркиваний
    (каталог argo-cd и образ argocd — одно имя)."""
    return "".join(ch for ch in name.lower() if ch.isalnum())


def _image_targets(
    d: Dockerfile, units: list[Unit], builds: dict[str, list[ImageBuild]], root_names: list[str],
) -> list[str]:
    """Сервисы манифестов, чей образ собирает Dockerfile d (ТЗ §15 п. 10 А6): по артефакту
    skaffold с этим Dockerfile, иначе по имени образа (без реестра и тега), равному имени
    ближайшего каталога-предка, а у корневого Dockerfile — имени репозитория или корня.
    Свой каталог, совпавший с именем сервиса, решает раньше: это прежняя склейка по имени."""
    by_image: dict[str, list[str]] = {}
    for u in units:
        if u.image and u.build_dir is None and u.dockerfile is None:
            names = by_image.setdefault(_flat(vocab.image_name(u.image)), [])
            if u.name not in names:
                names.append(u.name)
    for build in builds.get(d.path, []):
        if build.image is not None and _flat(vocab.image_name(build.image)) in by_image:
            return by_image[_flat(vocab.image_name(build.image))]
    segments = d.dir.split("/") if d.dir else []
    if segments and segments[-1] in {u.name for u in units}:
        return []
    for seg in [*reversed(segments), *([] if segments else root_names)]:
        hit = by_image.get(_flat(seg))
        if hit:
            return hit
    return []


def _own_name(d: Dockerfile, variant: str | None, root_name: str) -> str:
    """Имя контейнера Dockerfile без привязки к сервису манифеста: суффикс варианта, иначе
    ближайший каталог с именем не из _GENERIC_DIRS, иначе имя корня."""
    if variant:
        return variant
    return _dir_name(d.dir, root_name)


def _dir_name(folder: str, root_name: str) -> str:
    """Имя каталога кода: ближайший сегмент не из _GENERIC_DIRS, иначе имя корня."""
    for seg in reversed(folder.split("/") if folder else []):
        if seg.lower() not in _GENERIC_DIRS:
            return seg
    return root_name


# Каталог кода по имени сервиса или образа (ТЗ §15 п. 12 С5а): Petclinic описывает сервисы
# compose только образами springcommunity/spring-petclinic-*, а код лежит в одноимённых
# каталогах корня; OpenTelemetry Demo собирает все сервисы из корня (context: ./), а код
# лежит в src/<сервис>/. Каталог с именем ищется в корне и в каталогах монорепо верхнего
# уровня; хвост из _GENERIC_DIRS имя не задаёт (src/cart/src — каталог «cart»). Каталогом
# кода служит каталог с манифестом сборки или с Dockerfile самого объекта (src/currency/
# с Dockerfile на C++): чужой Dockerfile в каталоге с тем же именем образу ничего не даёт.
_CODE_PARENTS = frozenset({"", "src", "services", "apps", "packages", "cmd", "modules"})
_NAMED_PARSERS = frozenset({"compose", "k8s", "helm"})


# (глубина каталога с именем, нет манифеста сборки, глубина каталога кода, каталог кода,
# каталог с именем): меньший ключ ближе к корню и с манифестом.
_NamedDir = tuple[int, int, int, str, str]


def _named_entry(folder: str, scope: str, package: bool) -> tuple[str, _NamedDir] | None:
    """Имя каталога кода folder (без регистра и знаков, _flat) и запись индекса или None:
    корень, каталог глубже каталогов монорепо верхнего уровня."""
    prefix = scope + "/" if scope else ""
    if not folder.startswith(prefix) or folder == scope:
        return None
    segments = folder[len(prefix):].split("/")
    k = len(segments)
    while k > 0 and segments[k - 1].lower() in _GENERIC_DIRS:
        k -= 1
    if k == 0 or "/".join(segments[: k - 1]).lower() not in _CODE_PARENTS:
        return None
    named = prefix + "/".join(segments[:k])
    return _flat(segments[k - 1]), (k, 0 if package else 1, len(segments), folder, named)


def _named_dirs(findings: Findings, scope: str) -> dict[str, list[_NamedDir]]:
    """Каталоги с манифестом сборки по имени."""
    out: dict[str, list[_NamedDir]] = {}
    for folder in sorted({p.dir for p in findings.packages}):
        entry = _named_entry(folder, scope, True)
        if entry is not None:
            out.setdefault(entry[0], []).append(entry[1])
    return out


def _named_dir(
    names: list[str], index: dict[str, list[_NamedDir]], own: list[str] | None = None,
    scope: str = "",
) -> str | None:
    """Каталог кода по первому имени, у которого он есть: ближайший к корню каталог с этим
    именем (web/ раньше src/web/), в нём каталог с манифестом сборки раньше каталога только
    с Dockerfile объекта (own). Два разных каталога с именем на одной глубине —
    неоднозначно, None."""
    extra: dict[str, list[_NamedDir]] = {}
    for folder in own or []:
        entry = _named_entry(folder, scope, False)
        if entry is not None:
            extra.setdefault(entry[0], []).append(entry[1])
    for name in names:
        found = sorted([*index.get(_flat(name), []), *extra.get(_flat(name), [])])
        if not found:
            continue
        top = {item[4] for item in found if item[0] == found[0][0]}
        return found[0][3] if len(top) == 1 else None
    return None


def _named_candidate(obj: Obj) -> list[str]:
    """Имена для поиска каталога кода объекта (С5а): имя сервиса и последний сегмент образа.
    Только объекты манифестов развёртывания (compose, k8s, Helm), не базы и брокеры по
    образу и не варианты Dockerfile (они каталогом кода не владеют, ТЗ §5.1)."""
    if not any(u.parser in _NAMED_PARSERS for u in obj.units):
        return []
    if any(u.parser == "dockerfile" and u.build_dir is None for u in obj.units):
        return []
    images = [u.image for u in obj.units if u.image]
    if any(vocab.image_kind(image) is not None for image in images):
        return []
    return [obj.name, *(vocab.image_name(image) for image in images)]


def _image_org(image: str) -> str:
    """Реестр и организация образа без имени, тега и дайджеста: springcommunity/x:1 →
    springcommunity."""
    return image.strip().split("@", 1)[0].rpartition("/")[0].lower()


def _shared_builds(
    units: list[Unit], named: dict[str, list[_NamedDir]],
) -> dict[str, list[str]]:
    """Сервисы compose только с образом, чей код в каталоге репозитория (С5а): организация
    образа → имена сервисов, если сервисов таких хотя бы два. Общий Dockerfile без своего
    сервиса собирает их образы (docker/Dockerfile Petclinic с ARG ARTIFACT_NAME)."""
    by_org: dict[str, list[str]] = {}
    for u in units:
        if u.parser != "compose" or not u.image or u.build_dir is not None or u.dockerfile:
            continue
        org = _image_org(u.image)
        if org and _named_dir([u.name, vocab.image_name(u.image)], named) is not None:
            by_org.setdefault(org, []).append(u.name)
    return {org: sorted(set(names)) for org, names in by_org.items() if len(set(names)) >= 2}


def _package_home(folder: str, packages: set[str], scope: str) -> str | None:
    """Ближайший предок каталога folder (в области обхода) с манифестом сборки."""
    current = folder
    for _ in range(64):
        if current == scope or not paths.under(current, scope):
            break
        current = paths.parent(current)
        if current in packages:
            return current
    return None


def _dockerfile_units(
    units: list[Unit], findings: Findings, root_names: list[str], model: Model,
    stage2: bool = False, scope: str = "",
) -> list[Unit]:
    """Dockerfile, на который не ссылается ни один манифест, сам задаёт контейнер; если его
    образ (skaffold, имя образа сервиса, сборка в файле для разработки) работает в сервисе
    манифеста, это Dockerfile того сервиса. Вариант для разработки рядом с основным
    Dockerfile — тот же контейнер (hints.merged). Dockerfile служебной сборки
    (walk.service_sign, ТЗ §15 п. 12 С3), образ которого не запускает ни один сервис, идёт
    по политике разработки: на ступени 1 в hints.profiles, на ступени 2 (stage2, боевых
    манифестов нет) объектом с признаком (Unit.dev), пометку ставит _dev_objects.

    Dockerfile без своего манифеста сборки рядом (ТЗ §15 п. 12 С5б): общий Dockerfile сборки
    образов сервисов compose (_shared_builds) уходит в hints.unassigned, а Dockerfile,
    который копирует весь контекст («COPY . ./»), берёт каталог кода у ближайшего предка с
    манифестом сборки (scripts/docker/Dockerfile Monica — корень с composer.json) и имя по
    этому каталогу.

    Варианты и подкаталоги (ТЗ §15 п. 12 С8): Dockerfile.<суффикс> и <префикс>.Dockerfile
    рядом с основным Dockerfile одного контейнера (не в корне репозитория) — вариант при
    любом суффиксе; Dockerfile в подкаталоге каталога кода одного контейнера без своего
    манифеста сборки — тоже его вариант; Dockerfile мобильного приложения
    (walk.mobile_dir) уходит в hints.unassigned."""
    root_name = root_names[-1]
    package_dirs = {p.dir for p in findings.packages}
    shared = _shared_builds(units, _named_dirs(findings, scope))
    used = {u.dockerfile for u in units if u.dockerfile}
    claimed = {u.build_dir for u in units if u.build_dir is not None}
    # Сборка в файле разработки привязывает Dockerfile к сервису боевого манифеста любого
    # вида (compose, k8s, Procfile) по имени.
    names = {u.name for u in units}
    builds: dict[str, list[ImageBuild]] = {}
    for build in findings.image_builds:
        builds.setdefault(build.dockerfile, []).append(build)
    owner_of: dict[str, list[str]] = {}
    for u in units:
        if u.dockerfile:
            owner_of.setdefault(u.dockerfile, []).append(u.name)
        elif u.build_dir is not None:
            owner_of.setdefault(paths.join(u.build_dir, "Dockerfile") or "", []).append(u.name)
    by_path = {d.path: d for d in findings.dockerfiles}
    out: list[Unit] = []
    own: list[Unit] = []
    later: list[Dockerfile] = []
    for d in sorted(findings.dockerfiles, key=lambda x: x.path):
        if d.path in used:
            continue
        variant = _variant(d.path)
        dev_refs = [b for b in builds.get(d.path, []) if b.unit is not None]
        # Dockerfile окружения разработки в .devcontainer/ к боевому объекту не привязывается
        # никогда, даже если сервис с тем же именем есть в боевом манифесте (ТЗ §15 п. 12 С6г:
        # .devcontainer/Dockerfile n8n давал каталог кода боевому объекту n8n).
        devcontainer = any(seg.lower() == _DEVCONTAINER for seg in d.path.split("/")[:-1])
        prod_refs = [] if devcontainer else [b.unit for b in dev_refs if b.unit in names]
        mobile = mobile_dir(d.path)
        if mobile is not None and not prod_refs:
            # Мобильное приложение контейнером не считается (ТЗ §15 п. 12 С8).
            model.hint("unassigned", {
                "kind": "dockerfile", "name": d.path, "reason": texts.REASON_MOBILE_APP,
                "source": str(d.from_loc),
            })
            continue
        # Вариант с точкой (Dockerfile.cross, android.Dockerfile) рядом с основным
        # Dockerfile в каталоге контейнера — тот же контейнер при любом суффиксе (ТЗ §15
        # п. 12 С8). В корне репозитория суффикс по-прежнему называет отдельный образ
        # (Dockerfile.llm-analytics и Dockerfile.dagster-ml PostHog, ok вердикта).
        sibling = variant is not None and d.dir != scope and _dot_variant(d.path) and (
            (paths.join(d.dir, "Dockerfile") or "Dockerfile") in by_path
        )
        if variant is not None and not dev_refs and (variant.lower() in _DEV_VARIANTS or sibling):
            later.append(d)
            continue
        sign = dev_sign(d.path) or next(
            (texts.dev_sign_built(str(b.loc)) for b in dev_refs if b.unit not in names), None,
        )
        if sign is not None and not prod_refs:
            # Dockerfile для разработки или образ сервиса только для разработки.
            model.hint("profiles", {
                "kind": "dockerfile", "name": d.path, "reason": texts.dev_manifest(sign),
                "source": str(d.from_loc), "profiles": [],
            })
            continue
        if prod_refs and variant is not None:
            # Вариант с суффиксом собирает образ сервиса основных файлов (Dockerfile.node
            # PostHog для plugins): отдельного процесса нет, а каталогом кода вариант не
            # владеет (ТЗ §5.1), поэтому сервису он ничего не добавляет.
            model.hint("merged", {
                "kind": "dockerfile", "name": d.path, "object": prod_refs[0],
                "reason": texts.REASON_DOCKERFILE_IMAGE,
                "source": [str(d.from_loc), *(str(b.loc) for b in dev_refs if b.unit in names)],
            })
            continue
        kind = vocab.image_kind(d.images[-1])
        shape = kind.shape if kind and kind.shape != SERVICE else None
        targets = prod_refs or _image_targets(d, units, builds, root_names)
        if targets:
            # Dockerfile собирает образ сервисов манифеста: их каталог кода — каталог
            # сборки (контекст skaffold или compose, иначе каталог Dockerfile).
            ref = next((b for b in builds.get(d.path, [])), None)
            folder = ref.build_dir if ref is not None else d.dir
            for name in dict.fromkeys(targets):
                out.append(Unit(
                    name=name, parser="dockerfile", loc=d.from_loc, build_dir=folder,
                    dockerfile=d.path, command=d.command, command_loc=d.command_loc,
                    shape=shape,
                ))
            owner_of[d.path] = list(dict.fromkeys(targets))
            continue
        service = service_sign(d.path)
        if service is not None and not stage2:
            model.hint("profiles", {
                "kind": "dockerfile", "name": d.path, "reason": texts.dev_manifest(service),
                "source": str(d.from_loc), "profiles": [],
            })
            continue
        # Служебный каталог: имени не даёт (docker/, build/) или служебная сборка (scripts/).
        unnamed = _own_name(d, None, root_name) == root_name
        if variant is None and d.dir not in package_dirs and (unnamed or service is not None):
            if shared and unnamed:
                model.hint("unassigned", {
                    "kind": "dockerfile", "name": d.path, "reason": texts.REASON_SHARED_DOCKERFILE,
                    "source": str(d.from_loc),
                    "containers": sorted({n for names in shared.values() for n in names}),
                })
                continue
            home = _package_home(d.dir, package_dirs, scope) if d.copies_context else None
            if home is not None and home not in claimed:
                name = _dir_name(home[len(scope):].lstrip("/"), root_name)
                out.append(Unit(
                    name=name, parser="dockerfile", loc=d.from_loc, build_dir=home,
                    dockerfile=d.path, command=d.command, command_loc=d.command_loc,
                    shape=shape, dev=service,
                ))
                owner_of.setdefault(d.path, []).append(name)
                claimed.add(home)
                continue
        if variant is None and d.dir in claimed:
            continue
        # Dockerfile с суффиксом (Dockerfile-postgresql, worker.Dockerfile) каталогом кода
        # не владеет (ТЗ §5.1): вид и технология только по FROM, стек и repo/path каталога
        # ему не достаются.
        own.append(Unit(
            name=_own_name(d, variant, root_name), parser="dockerfile", loc=d.from_loc,
            build_dir=None if variant else d.dir,
            dockerfile=d.path, command=d.command, command_loc=d.command_loc,
            shape=shape, dev=service,
        ))
    # Каталоги кода контейнеров (не корень): Dockerfile без своего сервиса в подкаталоге
    # каталога кода одного контейнера — его вариант (ТЗ §15 п. 12 С8: genproto/ у сервисов
    # OpenTelemetry Demo, operator/scripts/ Keycloak). Ближайшие к корню решаются первыми.
    # Кандидат разработки на ступени 1 объектом не станет и каталогом не владеет.
    homes: dict[str, list[str]] = {}
    for u in [*units, *out]:
        if u.dev is not None and not stage2:
            continue
        home = u.build_dir
        if home in (None, scope) and u.dockerfile:
            # Сборка из корня с Dockerfile в каталоге с именем сервиса (src/checkout/Dockerfile
            # у checkout OpenTelemetry Demo): этот каталог и есть каталог кода (С5а).
            folder = paths.parent(u.dockerfile)
            home = folder if folder and _flat(paths.name(folder)) == _flat(u.name) else None
        if home is None or home == scope:
            continue
        if u.name not in homes.get(home, []):
            homes.setdefault(home, []).append(u.name)

    def place(u: Unit, d: Dockerfile) -> None:
        owner = _home_owner(d.dir, homes, scope)
        # Свой манифест сборки в каталоге Dockerfile — свой код, не вариант.
        if owner is not None and d.dir not in package_dirs:
            model.hint("merged", {
                "kind": "dockerfile", "name": d.path, "object": owner,
                "reason": texts.REASON_DOCKERFILE_SUBDIR, "source": [str(d.from_loc)],
            })
            return
        out.append(u)
        owner_of.setdefault(d.path, []).append(u.name)
        if u.build_dir is not None and u.build_dir != scope:
            homes.setdefault(u.build_dir, []).append(u.name)

    for u in sorted(own, key=lambda x: (x.loc.path.count("/"), x.loc.path)):
        place(u, by_path[u.dockerfile or ""])
    for d in later:
        main = paths.join(d.dir, "Dockerfile") or "Dockerfile"
        owners_of_main = list(dict.fromkeys(owner_of.get(main, []))) if main in by_path else []
        variant = _variant(d.path) or ""
        # Основной Dockerfile общий у нескольких сервисов (rust/Dockerfile PostHog собирает
        # capture, cymbal и другие): суффикс не для разработки называет отдельный образ
        # (rust/Dockerfile.sqlx-migrate, ok вердикта), вариантом одного контейнера он не стал.
        if len(owners_of_main) > 1 and variant.lower() not in _DEV_VARIANTS:
            owners_of_main = []
        if owners_of_main:
            model.hint("merged", {
                "kind": "dockerfile", "name": d.path, "object": owners_of_main[0],
                "reason": texts.REASON_DOCKERFILE_VARIANT if variant.lower() in _DEV_VARIANTS
                else texts.REASON_DOCKERFILE_SIBLING,
                "source": [str(d.from_loc)],
            })
        elif variant.lower() in _DEV_VARIANTS:
            sign = dev_sign(d.path) or texts.dev_sign_file(paths.name(d.path))
            model.hint("profiles", {
                "kind": "dockerfile", "name": d.path, "reason": texts.dev_manifest(sign),
                "source": str(d.from_loc), "profiles": [],
            })
        else:
            # У основного Dockerfile нет контейнера: вариант с другим суффиксом идёт по
            # прежним правилам (признак разработки или служебной сборки, иначе свой объект).
            sign = dev_sign(d.path) or (None if stage2 else service_sign(d.path))
            if sign is not None:
                model.hint("profiles", {
                    "kind": "dockerfile", "name": d.path, "reason": texts.dev_manifest(sign),
                    "source": str(d.from_loc), "profiles": [],
                })
                continue
            kind = vocab.image_kind(d.images[-1])
            place(Unit(
                name=variant, parser="dockerfile", loc=d.from_loc, dockerfile=d.path,
                command=d.command, command_loc=d.command_loc,
                shape=kind.shape if kind and kind.shape != SERVICE else None,
                dev=service_sign(d.path),
            ), d)
    return out


def _dot_variant(rel: str) -> bool:
    """Вариант Dockerfile с точкой: Dockerfile.<суффикс> или <префикс>.Dockerfile. Форма с
    дефисом (Dockerfile-fpm Monica) правилом варианта рядом с основным не считается."""
    low = paths.name(rel).lower()
    return low.startswith("dockerfile.") or low.endswith(".dockerfile")


def _home_owner(folder: str, homes: dict[str, list[str]], scope: str) -> str | None:
    """Контейнер ближайшего каталога кода, строго содержащего folder (предок, не корень):
    имя, если владелец один, иначе None (каталог у нескольких контейнеров). Свой каталог не
    в счёт: Dockerfile-fpm рядом с основным Dockerfile остаётся своим объектом."""
    current = folder
    while current and current != scope:
        current = paths.parent(current)
        if not current or current == scope:
            return None
        names = homes.get(current)
        if names is not None:
            return names[0] if len(names) == 1 else None
    return None


def _procfile_web(units: list[Unit]) -> None:
    """Procfile «web» в каталоге кода другого контейнера — это сам контейнер. Если каталог
    у нескольких контейнеров, имя остаётся «web» (у Mastodon корень собирают web и
    sidekiq, и Procfile web склеится с web по имени)."""
    homes: dict[str, list[str]] = {}
    for u in units:
        if u.parser != "procfile" and u.build_dir is not None and u.name not in homes.get(
            u.build_dir, [],
        ):
            homes.setdefault(u.build_dir, []).append(u.name)
    for u in units:
        if u.parser == "procfile" and u.name == "web" and u.home_dir is not None:
            names = homes.get(u.home_dir, [])
            if len(names) == 1:
                u.name = names[0]


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


def _classify(
    obj: Obj, packages: list[Package], free: list[Package] | None = None,
    root_stack: str | None = None,
) -> None:
    """Вид, технология и роль объекта по кандидатам, Dockerfile и манифестам сборки.
    free — манифесты свободных подкаталогов корня (_free_packages): у корневого контейнера
    без манифестов в корне или только со служебным package.json (_service_root) язык
    берётся из них по stack_of среди манифестов не Node.js (ТЗ §15 п. 12 С7а: в корне eShop
    package.json с одними devDependencies, а код .NET лежит в src/*/*.csproj). Только когда
    эти манифесты одного языка: несколько языков значат чужие манифесты (утилиты, тесты,
    мобильное приложение). Язык, названный базовым образом Dockerfile, они не меняют.
    root_stack — стек маркера сборки корня у контейнера с корневым каталогом кода (ТЗ §15
    п. 12 С12): Cargo.toml и go.mod тогда SDK, язык не задают, а без языка контейнер
    получает сам стек маркера (CI-матрица Envoy — «C++ (Bazel)», а не Rust)."""
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
    elif obj.dockerfile is not None and (shape_hint is not None or not _code_packages(obj, packages)):
        # Вид по образу итоговой стадии Dockerfile: у кандидата с видом и у контейнера без
        # своих манифестов сборки (src/kafka/Dockerfile OpenTelemetry Demo на apache/kafka,
        # путь из закоммиченного .env, ТЗ §15 п. 12 С13), как у Dockerfile без манифеста.
        kind = vocab.image_kind(obj.dockerfile.images[-1])
        if kind is not None and (shape_hint is not None or kind.shape != SERVICE):
            obj.shape, obj.technology, obj.role = kind.shape, kind.technology, kind.role
    if obj.shape != SERVICE:
        return
    pkgs = [
        p for p in _code_packages(obj, packages)
        if (obj.language is None or p.language == obj.language)
        and not (root_stack and p.kind in vocab.SDK_MANIFESTS)
    ]
    if root_stack and free:
        free = [p for p in free if p.kind not in vocab.SDK_MANIFESTS]
    language, server, front = stack_of(pkgs)
    base_language = _dockerfile_language(obj.dockerfile) if obj.dockerfile else None
    if language is None:
        language = base_language
    # Язык, названный базовым образом Dockerfile, свободными манифестами не меняется.
    if server is None and base_language is None and free and _service_root(pkgs):
        backend = [
            p for p in free
            if p.language != "Node.js" and (obj.language is None or p.language == obj.language)
        ]
        # Языков несколько — свободные манифесты чужие (утилиты, тесты), язык не угадывается.
        lang, backend_server, _front = (
            stack_of(backend) if len({p.language for p in backend}) == 1 else (None, None, None)
        )
        if lang is not None:
            language, server = lang, backend_server
            lead = next(p for p in backend if p.language == lang)
            obj.locs.add(lead.name_loc or Loc(lead.path, 1))
    if language is None:
        language = next((u.language for u in units if u.language), None)
    if language is None:
        language = root_stack
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


def _service_root(pkgs: list[Package]) -> bool:
    """Манифесты корня не задают язык кода: их нет или это package.json без зависимостей
    и workspaces (только devDependencies и scripts: линтер, тесты e2e)."""
    return all(
        p.kind == "package.json" and not p.deps and not p.workspaces for p in pkgs
    )


def _dockerfile_language(d: Dockerfile) -> str | None:
    """Язык по базовому образу итоговой стадии (ТЗ §15 п. 12 С4): стадии сборки язык не
    задают (Dockerfile-fpm Monica: node:22 собирает ресурсы, образ php:8.3-fpm). Итоговая
    стадия без языка (scratch, alpine, distroless) берёт его у ближайшей предыдущей стадии
    с языком: Go-бинарь, собранный в golang."""
    return next((lang for img in reversed(d.images) if (lang := vocab.image_language(img))), None)


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


def _stands(units: list[Unit], findings: Findings, root_names: list[str]) -> None:
    """Compose-файл в каталоге кода (не в корне) контейнера из другого боевого файла — стенд
    разработки этого компонента (ТЗ §15 п. 10 Б1, решение исполнителя): livestream/ и
    rust/ PostHog собираются сервисами основного compose, а их свои compose поднимают
    локальные Redis, Redpanda и кластер для интеграционных тестов. Каталог кода — контекст
    сборки сервиса или каталог Dockerfile, чей образ запускает сервис (_image_targets).
    Сервисы такого файла получают признак разработки."""
    homes: dict[str, tuple[str, set[str]]] = {}
    for u in units:
        if u.build_dir:
            homes.setdefault(u.build_dir, (u.name, set()))[1].add(u.loc.path)
    builds: dict[str, list[ImageBuild]] = {}
    for build in findings.image_builds:
        builds.setdefault(build.dockerfile, []).append(build)
    used = {u.dockerfile for u in units if u.dockerfile}
    by_name = {u.name: u for u in units}
    for d in findings.dockerfiles:
        if not d.dir or d.path in used:
            continue
        own = d.dir.rsplit("/", 1)[-1]
        # Каталог Dockerfile с именем сервиса склеивается с ним по имени (_objects).
        targets = [own] if own in by_name else _image_targets(d, units, builds, root_names)
        for name in targets:
            homes.setdefault(d.dir, (name, set()))[1].add(by_name[name].loc.path)
    for u in units:
        if u.parser != "compose":
            continue
        for folder, (name, files) in sorted(homes.items()):
            if paths.under(u.loc.path, folder) and u.loc.path not in files:
                u.dev = texts.dev_sign_stand(name, folder)
                break


_HINT_KIND = {SERVICE: "container", DATABASE: "database", BROKER: "broker"}


def _dev_objects(model: Model) -> None:
    """Ступень 2 (ТЗ §15 п. 10 Б3): объект из манифеста разработки получает запись в
    hints.dev_manifest_objects (имя, источник, признак), а покрытие и сводка говорят, что
    объекты собраны из манифестов разработки и боевых манифестов в репозитории нет."""
    for obj in model.objects:
        dev = [u for u in obj.units if u.dev is not None]
        if not dev:
            continue
        first = min(dev, key=lambda u: u.loc)
        model.dev_objects.add(obj.name)
        model.hint("dev_manifest_objects", {
            "kind": _HINT_KIND.get(obj.shape, "container"), "name": obj.name,
            "reason": texts.dev_manifest(first.dev or ""), "source": str(first.loc),
        })


def _dev_units(
    units: list[Unit], findings: Findings, model: Model, root_names: list[str],
) -> list[Unit]:
    """Кандидаты манифестов разработки: признак ставит разборщик (compose, Procfile) или
    путь манифеста (supervisor, systemd, k8s, Helm, walk.dev_sign).

    Ступень 1 (ТЗ §15 п. 10 Б2): боевые манифесты есть. Кандидат разработки объектом не
    становится, а уходит в hints.profiles с причиной «манифест разработки: <признак>»;
    сервис, который есть и в боевом манифесте (то же имя), остаётся по боевому, и подсказки
    о нём нет. Кодом кандидат разработки не владеет: объекта у него нет.

    Ступень 2 (Б3): боевых манифестов нет (Sentry devservices). Кандидаты разработки
    становятся объектами вместе с подсказками своего разбора, а пометку «из манифеста
    разработки» ставит _dev_objects."""
    for u in units:
        if u.dev is None and u.parser in _DEV_MANIFESTS:
            sign = dev_sign if u.parser in _NO_SERVICE_SIGN else manifest_sign
            u.dev = sign(u.loc.path)
    _stands([u for u in units if u.dev is None], findings, root_names)
    kept = [u for u in units if u.dev is None]
    if not any(u.parser in _MANIFEST_PARSERS for u in kept):
        for u in units:
            for hint in u.dev_hints:
                model.hint(hint.section, hint.data)
            model.dev_notes += [n for n in u.dev_notes if n not in model.dev_notes]
        return units
    names = {u.name for u in kept}
    for u in units:
        if u.dev is not None and u.name not in names:
            model.hint("profiles", {
                "kind": "container", "name": u.name, "reason": texts.dev_manifest(u.dev),
                "source": str(u.loc), "profiles": [],
            })
    return kept


def _objects(
    units: list[Unit], findings: Findings, model: Model, ctx: Context
) -> list[Obj]:
    root_names = [ctx.root.name, model.system.rsplit("/", 1)[-1], model.system]
    units = _dev_units(units, findings, model, root_names)
    stage2 = not any(u.parser in _MANIFEST_PARSERS and u.dev is None for u in units)
    units = units + _dockerfile_units(units, findings, root_names, model, stage2, ctx.scope)
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
    named = _named_dirs(findings, ctx.scope)
    go_binaries = frozenset(
        _go_module_name(p.name) for p in findings.packages if p.kind == "go.mod" and p.name
    )
    for obj in by_name.values():
        if obj.code_dir is None:
            obj.code_dir = _workspace_dir(obj, spaces)
        if obj.code_dir in (None, ctx.scope):
            # Корневой контекст сборки каталогом кода не считается, если есть каталог с
            # именем сервиса или образа (ТЗ §15 п. 12 С5а).
            own = [
                folder for u in obj.units
                for folder in (u.build_dir, paths.parent(u.dockerfile) if u.dockerfile else None)
                if folder
            ]
            obj.code_dir = _named_dir(
                _named_candidate(obj), named, own, ctx.scope,
            ) or obj.code_dir
        _attach_dockerfile(obj, by_path)
        _process_stack(obj, findings.packages, ctx, go_binaries)
    objs = list(by_name.values())
    # Второй проход: свободные пакеты корневого контейнера считаются, когда каталоги кода
    # всех объектов уже известны (ТЗ §15 п. 12 С7а).
    for obj in objs:
        _classify(
            obj, findings.packages, _free_packages(obj, objs, findings.packages, ctx.scope),
            findings.root_stack if obj.code_dir == ctx.scope else None,
        )
    return objs


def _free_packages(
    obj: Obj, objs: list[Obj], packages: list[Package], scope: str,
) -> list[Package]:
    """Манифесты сборки в подкаталогах корня, не занятых каталогом кода другого объекта:
    у контейнера с каталогом кода, равным корню, из них берётся язык, когда манифест корня
    служебный (ТЗ §15 п. 12 С7а). Манифесты служебной сборки и разработки (manifest_sign:
    утилиты Go internal/tools/ otel-demo) и мобильного приложения (walk.mobile_dir, С8) не
    считаются. Контейнер, чей Dockerfile объявлен
    в подкаталоге, собирается из корня только ради контекста (telemetry-docs otel-demo:
    src/telemetry-docs/Dockerfile), его код не в корне: у него, как и у остальных
    контейнеров, пусто."""
    if obj.code_dir != scope:
        return []
    if any(u.dockerfile and paths.parent(u.dockerfile) != scope for u in obj.units):
        return []
    taken = [o.code_dir for o in objs if o is not obj and o.code_dir not in (None, scope)]
    return sorted(
        (
            p for p in packages
            if p.dir != scope and paths.under(p.dir, scope) and manifest_sign(p.path) is None
            and mobile_dir(p.path) is None
            and not any(paths.under(p.dir, folder) for folder in taken)
        ),
        key=lambda p: p.path,
    )


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


def _build_objects(findings: Findings) -> list[Obj]:
    """Контейнеры по файлам сборки (ТЗ §13.4): программы autotools и cmd/<имя>/ Go, когда
    манифестов нет. Одно имя в нескольких местах — один объект с каталогом первого."""
    by_name: dict[str, Obj] = {}
    for u in sorted(findings.build_units, key=lambda x: (x.loc, x.name)):
        obj = by_name.setdefault(u.name, Obj(name=u.name, code_dir=u.build_dir))
        obj.units.append(u)
        obj.locs.add(u.loc)
        if u.parser not in obj.parsers:
            obj.parsers.append(u.parser)
    for obj in by_name.values():
        _classify(obj, findings.packages)
    return list(by_name.values())


def _programs(obj: Obj) -> dict[str, Loc]:
    """Программы, которые запускают команды контейнера: имя → место команды."""
    out: dict[str, Loc] = {}
    for u in obj.units:
        program = vocab.command_program(u.command)
        loc = u.command_loc or u.loc
        if program is not None and (program not in out or loc < out[program]):
            out[program] = loc
    return out


def _duplicate(
    objs: list[Obj], programs: dict[int, dict[str, Loc]],
) -> tuple[Obj, Obj, Loc] | None:
    """Пара дублей (ТЗ §13.5): контейнеры разных манифестов с одним каталогом кода, команда
    первого запускает программу с именем второго. Возвращает их и место этой команды."""
    for runner in objs:
        for named in objs:
            if runner is named or not (runner.is_container and named.is_container):
                continue
            if runner.code_dir is None or runner.code_dir != named.code_dir:
                continue
            if set(runner.parsers) & set(named.parsers):
                continue
            command = programs[id(runner)].get(named.name)
            if command is not None:
                return runner, named, command
    return None


def _absorb(kept: Obj, gone: Obj) -> None:
    """Источники, разборщики и окружение второго контейнера переходят первому; имя,
    технология и роль остаются его."""
    kept.units = sorted(kept.units + gone.units, key=lambda u: (PRIORITY.get(u.parser, 99), u.loc))
    kept.locs |= gone.locs
    kept.parsers.extend(p for p in gone.parsers if p not in kept.parsers)
    kept.env.extend(gone.env)
    kept.package_locs.extend(loc for loc in gone.package_locs if loc not in kept.package_locs)
    kept.host = kept.host or gone.host
    kept.dockerfile = kept.dockerfile or gone.dockerfile
    kept.technology = kept.technology or gone.technology
    kept.language = kept.language or gone.language


def _merge_duplicates(model: Model) -> None:
    """Один процесс, описанный двумя манифестами, даёт один контейнер (ТЗ §13.5). Grafana:
    корневой Dockerfile даёт grafana, а systemd запускает /usr/share/grafana/bin/grafana
    под именем grafana-server. Остаётся контейнер из Dockerfile, иначе с более коротким
    именем; склейка записана в hints.merged с источниками обоих."""
    programs = {id(o): _programs(o) for o in model.objects}
    while (pair := _duplicate(model.objects, programs)) is not None:
        runner, named, command = pair
        kept, gone = sorted(
            (runner, named), key=lambda o: (o.dockerfile is None, len(o.name), o.name),
        )
        _absorb(kept, gone)
        programs[id(kept)] = _programs(kept)
        model.objects.remove(gone)
        model.hint("merged", {
            "kind": "container", "name": gone.name, "object": kept.name,
            "reason": texts.REASON_MERGED,
            "source": [str(loc) for loc in sorted({min(u.loc for u in named.units), command})],
        })


def _implicit(model: Model, findings: Findings, ctx: Context) -> Obj | None:
    """Репозиторий без манифестов контейнеров: один контейнер с именем корня (ТЗ §7). При
    маркере сборки в корне Cargo.toml и go.mod — SDK и утилиты, контейнера не дают (ТЗ §15
    п. 12 С12)."""
    roots = [
        p for p in findings.packages if p.dir == ctx.scope
        and not (findings.root_stack and p.kind in vocab.SDK_MANIFESTS)
    ]
    if not roots:
        return None
    obj = Obj(name=model.system, code_dir=ctx.scope, parsers=["implicit"])
    obj.units.append(Unit(name=model.system, parser="implicit", loc=roots[0].name_loc
                          or Loc(roots[0].path, 1)))
    _classify(
        obj, findings.packages, _free_packages(obj, [obj], findings.packages, ctx.scope),
        findings.root_stack,
    )
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


def _build_packages(obj: Obj, packages: list[Package]) -> list[Package]:
    """Манифесты сборки контейнера: каталога кода и каталога его Dockerfile внутри него.
    Монорепозиторий собирает сервис из корня, а манифест сервиса лежит рядом с Dockerfile
    (immich: контекст «../», server/Dockerfile и server/package.json)."""
    out = _code_packages(obj, packages)
    if obj.code_dir is None or obj.dockerfile is None:
        return out
    home, code = obj.dockerfile.dir, obj.code_dir
    if home != code and (code == "" or home.startswith(code + "/")):
        out = out + [p for p in packages if p.dir == home]
    return out


def _queue_brokers(model: Model, packages: list[Package]) -> None:
    """Redis — брокер, если к нему идёт контейнер с библиотекой очередей задач в
    манифестах своей сборки (_build_packages, vocab.REDIS_QUEUE_DEPS, ТЗ §15 п. 10 А13).
    Только когда Redis у контейнера один и брокер по адресу (_redis_brokers) ему ещё не
    назначен: у PostHog redis7 уже брокер по CELERY_BROKER_URL, второй Redis остаётся
    кэшем."""
    changed = False
    for obj in model.objects:
        if not obj.is_container:
            continue
        deps = {d for p in _build_packages(obj, packages) for d in p.deps}
        if not deps & vocab.REDIS_QUEUE_DEPS:
            continue
        targets = {lk.dst.name: lk.dst for lk in model.links
                   if lk.src is obj and lk.dst.technology == "Redis"}
        if len(targets) != 1 or any(t.shape == BROKER for t in targets.values()):
            continue
        (redis,) = targets.values()
        redis.shape, redis.role = BROKER, vocab.ROLE_BROKER
        changed = True
    if changed:
        model.objects.sort(key=lambda o: (SHAPE_ORDER[o.shape], o.name))


def _add_link(
    links: dict[tuple[str, str], Link], src: Obj, dst: Obj, tech: str | None, loc: Loc,
    parser: str,
) -> None:
    key = (src.name, dst.name)
    link = links.get(key)
    if link is None:
        link = links[key] = Link(src=src, dst=dst, label=texts.LABEL_USES, technology=tech)
    if link.technology is None and tech:
        link.technology = tech
    link.locs.add(loc)
    link.parsers.add(parser)


def _links(model: Model, env_of: dict[str, list[tuple[EnvVar, str]]]) -> list[Link]:
    by_host = {o.host.lower(): o for o in model.objects if o.host}
    by_name = {o.name: o for o in model.objects}
    links: dict[tuple[str, str], Link] = {}
    for src in model.objects:
        if src.shape == DATABASE:
            # База, которая сама читает брокер (ClickHouse с движком Kafka у PostHog):
            # depends_on к брокеру — связь (ТЗ §15 п. 10 А13, без неё clickhouse→kafka
            # пропала бы, когда clickhouse-posthog стал базой).
            for unit in src.units:
                for dep, loc in unit.depends_on:
                    dst = by_name.get(dep)
                    if dst is not None and dst.shape == BROKER:
                        _add_link(links, src, dst, dst.technology, loc, unit.parser)
            continue
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
                        "kind": "edge", "name": f"{src.name}→{dst.name}",
                        "reason": texts.REASON_DEPENDS_ON, "source": str(loc),
                        "from": src.name, "to": dst.name,
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
        shown = paths.show_dir(folder)
        model.hint("shared_code", {
            "kind": "directory", "name": shown, "reason": texts.REASON_SHARED_CODE,
            "source": str(min(u.loc for o in objs for u in o.units)),
            "containers": sorted(o.name for o in objs),
        })


def assemble(findings: Findings, ctx: Context) -> Model:
    # Имя системы по Cargo.toml или go.mod SDK не берётся (ТЗ §15 п. 12 С12).
    named = [
        p for p in findings.packages
        if not (findings.root_stack and p.kind in vocab.SDK_MANIFESTS)
    ]
    system, system_locs = system_name(ctx, named)
    model = Model(
        system=system, system_locs=system_locs, objects=[], links=[],
        root_stack=findings.root_stack,
    )
    for hint in findings.hints:
        model.hint(hint.section, hint.data)
    model.objects = _objects(list(findings.units), findings, model, ctx)
    _tasks(model)
    _merge_duplicates(model)
    _dev_objects(model)
    if not any(o.is_container for o in model.objects):
        # Манифестов нет: процессы по файлам сборки (ТЗ §13.4), иначе единственный неявный
        # контейнер корня (ТЗ §7).
        built = _build_objects(findings)
        implicit = None if built else _implicit(model, findings, ctx)
        if built:
            model.objects.extend(built)
            model.by_buildfiles = True
            model.build_unsupported = list(findings.build_unsupported)
        elif implicit is not None:
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
    _queue_brokers(model, findings.packages)
    _sources(model, ctx)
    _entrypoints(model)
    _params(model, findings, env_of)
    _clients(model, findings)
    _tables(model, findings, env_of)
    _openapi(model, findings)
    codefacts.attach(model, findings, env_of)
    return model


def _openapi(model: Model, findings: Findings) -> None:
    """Файлы OpenAPI — подсказка агенту с контейнером-владельцем, если он один (ТЗ §6.1)."""
    containers = [o for o in model.objects if o.is_container]
    for spec in sorted(findings.openapi, key=lambda s: s.path):
        data: dict[str, object] = {"kind": "openapi", "name": spec.path}
        found = owners.code_owners(spec.path, containers)
        if len(found) == 1:
            data["object"] = found[0].name
        if spec.operations is None:
            data["reason"] = spec.reason or texts.REASON_OPENAPI_TOO_LARGE
        else:
            data["reason"] = texts.REASON_OPENAPI_DOCS if spec.in_docs else texts.REASON_OPENAPI_FILE
        data["source"] = spec.path
        if spec.operations is not None:
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
        if ts.data_migrations:
            stats.skipped["data_migrations"] = (
                stats.skipped.get("data_migrations", 0) + ts.data_migrations
            )
        for loc, text in ts.skipped_examples:
            model.hint("unassigned", {
                "kind": ts.parser, "name": text, "reason": texts.REASON_SKIPPED_STATEMENT,
                "source": str(loc),
            })
        for loc, text in ts.queried:
            model.hint("unassigned", {
                "kind": ts.parser, "name": text, "reason": texts.REASON_COLUMNS_FROM_QUERY,
                "source": str(loc),
            })
        db, why = owners.database_for(
            ts.dir, containers, databases, plain, _MIGRATION_LANGUAGE.get(ts.parser),
        )
        if db is None and why == "no_database" and ts.tables:
            db = _migration_database(model, ts, containers)
        elif db is not None and ts.dialect == SQLITE and db.technology != SQLITE:
            # ENGINE sqlite3 при базе другого вида из манифестов (ТЗ §15 п. 12 С9): таблицы
            # у базы манифеста, sqlite — значение по умолчанию настроек.
            _sqlite_default_hint(model, ts)
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


def _sqlite_default_hint(model: Model, ts: TableSet) -> None:
    """Подсказка «sqlite как значение по умолчанию настроек», одна на основание ENGINE."""
    source = str(ts.dialect_loc) if ts.dialect_loc else ts.dir or "."
    if any(
        h.get("reason") == texts.REASON_SQLITE_DEFAULT and h.get("source") == source
        for h in model.hints.get("unassigned", [])
    ):
        return
    model.hint("unassigned", {
        "kind": "database", "name": SQLITE, "reason": texts.REASON_SQLITE_DEFAULT,
        "source": source,
    })


def _migration_database(model: Model, ts: TableSet, containers: list[Obj]) -> Obj:
    """Базы в манифестах нет, а миграции есть (Sentry, Zulip): объект-база по признакам
    миграций (ТЗ §7, пункт 3). Имя — имя диалекта, диалект не опознан — «База данных» без
    технологии; source нет. Контейнер-владелец каталога миграций, если он определён,
    получает связь «использует». SQLite как значение по умолчанию настроек
    (TableSet.dialect_default, ТЗ §15 п. 12 С9) вида базы не даёт: «База данных» и
    подсказка."""
    kind = ts.dialect
    if kind == SQLITE and ts.dialect_default:
        _sqlite_default_hint(model, ts)
        kind = None
    name = kind or texts.UNKNOWN_DATABASE
    db = model.obj(name)
    if db is None:
        db = Obj(name=name, shape=DATABASE, role=vocab.ROLE_DB, technology=kind)
        model.objects.append(db)
        model.objects.sort(key=lambda o: (SHAPE_ORDER[o.shape], o.name))
        model.db_by_migrations = True
    if ts.parser not in db.parsers:
        db.parsers.append(ts.parser)
    first = min(loc for table in ts.tables for loc in table.locs)
    db.locs.add((ts.dialect_loc if kind else None) or first)
    found = owners.file_owners(ts.dir or ".", containers, _MIGRATION_LANGUAGE.get(ts.parser))
    owner = owners.primary(found, vocab.ROLE_SERVICE)
    if owner is not None:
        links = {(lk.src.name, lk.dst.name): lk for lk in model.links}
        link = links.get((owner.name, db.name))
        if link is None:
            link = Link(src=owner, dst=db, label=texts.LABEL_USES, technology=db.technology)
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
            if vocab.is_os_variable(var.name):
                # PYTHONUNBUFFERED и TZ в environment — окружение процесса, а не параметр
                # продукта (ТЗ §13.1): в подсказки, адрес из значения связи всё равно даёт.
                model.os_vars.setdefault(var.name, set()).add(var.loc)
                continue
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
            if vocab.is_os_variable(var.name):
                model.os_vars.setdefault(var.name, set()).add(var.loc)
                continue
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
                    "kind": "library", "name": lib, "object": obj.name,
                    "reason": texts.REASON_CLIENT_LIBRARY,
                    "source": str(pkg.name_loc or Loc(pkg.path, 1)), "technology": kind,
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
