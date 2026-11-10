"""Отнесение записей к владельцу (ТЗ §7).

Контейнер файла — контейнер с самым длинным каталогом кода, содержащим файл; если таких
несколько (собраны из одного каталога), владельцев несколько. Файл вне каталогов всех
контейнеров — общий код, его записи уходят в подсказки; но единственный контейнер со своим
кодом владеет и кодом вне своего каталога, если язык файла совпадает с его языком или
его язык не определён (Sentry: контейнер self-hosted один, а код продукта лежит в src/).
Файл Go под «<каталог кода>/cmd/<имя>/» при двух и более таких программах в каталоге, из
которых хотя бы одной соответствует контейнер, принадлежит только контейнеру этой программы
(имя или программа команды равны <имя>); программа без контейнера общим кодом не считается
(ТЗ §15 п. 14 Ф1: шесть контейнеров Argo CD из одного корня).
База для миграций: база по адресу в окружении контейнера-владельца каталога миграций, иначе
единственная реляционная база в манифестах, иначе владелец не определим.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING

from archmap_scan import paths, texts, vocab
from archmap_scan.links import hosts_in

if TYPE_CHECKING:
    from archmap_scan.model import EnvVar, Unit
    from archmap_scan.objects import Obj


def unit_commands(unit: Unit, units: Sequence[Unit]) -> list[str]:
    """Команды единицы объекта с единицами units: своя команда и простые команды скриптов
    репозитория, которые она запускает (ТЗ §15 п. 16 П1: ./bin/docker-worker-celery у
    PostHog запускает celery beat через ./bin/docker-worker-beat). CMD Dockerfile — команда
    по умолчанию: её заменяет command манифеста развёртывания, поэтому скрипты CMD не
    раскрываются, если у другой единицы объекта своя команда (у PostHog CMD ./bin/docker
    запускает и воркер, и сервер, а web в compose запускает только сервер). По командам
    выбирается владелец записей кода и роль."""
    out = [unit.command] if unit.command else []
    if unit.parser == "dockerfile" and any(u.command for u in units if u.parser != "dockerfile"):
        return out
    return out + unit.script_commands


def code_owners(rel: str, containers: Sequence[Obj]) -> list[Obj]:
    """Контейнеры, которым принадлежит файл или каталог rel (пусто — общий код)."""
    best = -1
    owners: list[Obj] = []
    for obj in containers:
        folder = obj.code_dir
        if folder is None or not paths.under(rel, folder):
            continue
        size = len(folder)
        if size > best:
            best, owners = size, [obj]
        elif size == best:
            owners.append(obj)
    return owners


# Расширение файла → язык кода: им отбираются владельцы среди контейнеров одного каталога
# (корень Zulip — и процессы Python, и процесс Node.js).
_EXT_LANGUAGE = {
    ".py": "Python", ".js": "Node.js", ".mjs": "Node.js", ".cjs": "Node.js", ".ts": "Node.js",
    ".mts": "Node.js", ".cts": "Node.js", ".jsx": "Node.js", ".tsx": "Node.js", ".go": "Go",
    ".rb": "Ruby", ".php": "PHP", ".java": "Java", ".kt": "Kotlin", ".kts": "Kotlin",
    ".rs": "Rust", ".ex": "Elixir", ".exs": "Elixir", ".cs": ".NET",
}
# Языки, кодом которых контейнер владеет кроме своего (ТЗ §15 п. 13 Д6): Gradle с плагином
# Kotlin (язык контейнера Kotlin) собирает и исходники Java того же модуля, это смешанный
# проект; Gradle без плагина Kotlin файлы .kt не компилирует, контейнер на Java ими не владеет.
_ALSO_OWNS = {"Kotlin": frozenset({"Java"})}


def _same_language(container: str | None, language: str | None) -> bool:
    """Язык файла совпадает с языком контейнера или входит в _ALSO_OWNS для него."""
    return container == language or (
        container is not None and language in _ALSO_OWNS.get(container, frozenset())
    )


def file_language(rel: str) -> str | None:
    name = paths.name(rel)
    dot = name.rfind(".")
    return _EXT_LANGUAGE.get(name[dot:].lower()) if dot > 0 else None


def sole_owner(containers: Sequence[Obj], language: str | None) -> list[Obj]:
    """Единственный контейнер со своим кодом для кода вне его каталога (ТЗ §7): язык файла
    совпадает с языком контейнера или язык контейнера не определён. Контейнер без своего
    каталога кода (только образ) чужой код не забирает и единственность не нарушает: у
    Sentry рядом с self-hosted семь сервисов на образах из devservices/config.yml (compose
    по содержимому, ТЗ §13.3), а код src/ по-прежнему его. При двух и более контейнерах со
    своим кодом общий код остаётся без владельца."""
    own = [c for c in containers if c.code_dir is not None]
    if len(own) != 1:
        return []
    sole = own[0]
    if sole.language is None or _same_language(sole.language, language):
        return [sole]
    return []


def _by_language(found: list[Obj], lang: str | None) -> list[Obj]:
    if lang is None:
        return found
    same = [o for o in found if o.language == lang]
    if same:
        return same
    mixed = [o for o in found if _same_language(o.language, lang)]
    if mixed:
        return mixed
    return [o for o in found if o.language is None]


# Хвосты программы команды, при которых она совпадает с cmd/<имя> без хвоста, если имя
# контейнера кончается тем же хвостом (ТЗ §15 п. 15 Н3).
_PROGRAM_TAILS = ("-controller", "-server")


def _same_program(obj: Obj, name: str, command: str | None) -> bool:
    """Программа команды command — это cmd/<name>: равны, отличаются только конечной «s» у
    одного из них (argocd-notification и argocd-notifications) или command = name-controller
    либо name-server при имени контейнера с тем же хвостом (ТЗ §15 п. 15 Н3). Нечёткое
    совпадение не действует, если у каталога кода есть своя программа cmd/<command>."""
    if command is None:
        return False
    if command == name:
        return True
    if command in obj.go_programs:
        return False
    if command == name + "s" or name == command + "s":
        return True
    return any(command == name + tail and obj.name.endswith(tail) for tail in _PROGRAM_TAILS)


def _runs_program(obj: Obj, name: str) -> bool:
    """Контейнер программы name: имя контейнера или программа команды одного из его
    манифестов (/usr/local/bin/argocd-server → argocd-server, с правилом близких имён Н3)."""
    return obj.name == name or any(
        _same_program(obj, name, vocab.command_program(u.command)) for u in obj.units
    )


def _program(rel: str, owners: Sequence[Obj]) -> str | None:
    """Имя программы файла Go под <каталог кода владельцев>/cmd/<имя>/, если правило
    программ действует (ТЗ §15 п. 14 Ф1): в каталоге две и более программы cmd/ и хотя бы
    одной из них соответствует контейнер среди владельцев. Иначе None."""
    if not owners or not rel.endswith(".go"):
        return None
    folder = owners[0].code_dir
    programs = owners[0].go_programs
    if folder is None or len(programs) < 2:
        return None
    parts = (rel[len(folder) + 1:] if folder else rel).split("/")
    if len(parts) < 3 or parts[0] != "cmd" or parts[1] not in programs:
        return None
    if not any(_runs_program(o, p) for o in owners for p in programs):
        return None
    return parts[1]


def file_owners(rel: str, containers: Sequence[Obj], language: str | None = None) -> list[Obj]:
    """Контейнеры файла кода: code_owners, а среди них — те, чей язык совпадает с языком
    файла. Контейнер другого языка файлом не владеет (ТЗ §15 п. 10 А5: браузерный код
    Mastodon не параметр процессов Ruby); контейнер без опознанного языка владеет любым,
    контейнер на Kotlin ещё и файлами Java, если контейнера на Java среди них нет (Д6).
    Файл Go под cmd/<имя>/ — только контейнеру этой программы (_program, Ф1).
    Файл вне каталогов всех контейнеров — единственному контейнеру по sole_owner. Одно
    место для маршрутов, параметров, каналов, расписаний и владельца миграций; причину
    пустого ответа даёт missing_reason."""
    found = code_owners(rel, containers)
    lang = language or file_language(rel)
    if not found:
        return sole_owner(containers, lang)
    owners = _by_language(found, lang)
    program = _program(rel, owners)
    if program is not None:
        return [o for o in owners if _runs_program(o, program)]
    return owners


def missing_reason(rel: str, containers: Sequence[Obj]) -> str:
    """Причина, по которой file_owners пуст: программа cmd/ без контейнера, файл в каталоге
    контейнеров другого языка или вне каталогов кода всех контейнеров."""
    found = code_owners(rel, containers)
    if not found:
        return texts.REASON_SHARED_LIB
    owners = _by_language(found, file_language(rel))
    program = _program(rel, owners)
    if program is not None:
        folder = owners[0].code_dir
        return texts.no_program_container(f"{folder}/cmd/{program}" if folder else f"cmd/{program}")
    return texts.REASON_OTHER_LANGUAGE


def primary(owners: Sequence[Obj], prefer: str | None = None) -> Obj | None:
    """Единственный владелец или единственный с ролью prefer среди нескольких; None —
    владелец не определим (контейнеры собраны из одного каталога)."""
    if len(owners) == 1:
        return owners[0]
    if prefer is not None:
        picked = [o for o in owners if o.role == prefer]
        if len(picked) == 1:
            return picked[0]
    return None


def database_for(
    folder: str, containers: Sequence[Obj], databases: Sequence[Obj],
    env_of: dict[str, list[EnvVar]], language: str | None = None,
) -> tuple[Obj | None, str | None]:
    """База для набора миграций в каталоге folder и причина, если владелец не определим.
    language — язык миграций (Alembic и Django — Python): по нему владелец каталога
    выбирается так же, как у файла кода (file_owners)."""
    relational = [d for d in databases if d.technology in vocab.RELATIONAL]
    by_host = {d.host: d for d in relational if d.host}
    pointed: list[Obj] = []
    found = file_owners(folder, containers, language)
    for owner in found:
        for var in env_of.get(owner.name, []):
            if var.dynamic or var.value is None:
                continue
            for host, _scheme in hosts_in(var.name, var.value):
                db = by_host.get(host)
                if db is not None and db not in pointed:
                    pointed.append(db)
    if len(pointed) == 1:
        return pointed[0], None
    if not pointed:
        near = _manifest_database(found, relational)
        if near is not None:
            return near, None
    if len(relational) == 1:
        return relational[0], None
    if not relational:
        return None, "no_database"
    return None, "many_databases"


# Манифесты, у которых «свой файл» — каталог: объекты k8s и Helm одного развёртывания
# лежат в нескольких файлах одного каталога (ТЗ §15 п. 15 Н2).
_DIR_MANIFESTS = frozenset({"k8s", "helm"})


def _manifest_keys(obj: Obj) -> set[str]:
    """Файлы манифестов объекта: файл compose, у k8s и Helm — каталог манифестов."""
    out: set[str] = set()
    for unit in obj.units:
        for loc in (unit.loc, *unit.extra_locs):
            out.add(paths.parent(loc.path) if unit.parser in _DIR_MANIFESTS else loc.path)
    return out


def _manifest_database(found: Sequence[Obj], relational: Sequence[Obj]) -> Obj | None:
    """Шаг между (1) и (2) цепочки «База для миграций» (ТЗ §7, §15 п. 15 Н2): владелец
    каталога миграций есть, адреса базы в его окружении нет, а в файлах его манифестов (тот
    же файл compose, тот же каталог манифестов k8s) ровно одна реляционная база. Владельцы
    в двух файлах с разными базами — None (дальше прежняя цепочка)."""
    keys = {key for owner in found for key in _manifest_keys(owner)}
    if not keys:
        return None
    near = [d for d in relational if _manifest_keys(d) & keys]
    return near[0] if len(near) == 1 else None
