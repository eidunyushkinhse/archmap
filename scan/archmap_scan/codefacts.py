"""Отнесение находок яруса кода к владельцам (ТЗ §6.2, §7).

Файл кода принадлежит контейнеру по owners.file_owners: самый длинный каталог кода, а
среди контейнеров одного каталога — того же языка. Файл вне каталогов всех контейнеров —
общий код: его записи уходят в hints.unassigned. Маршрут HTTP получает один контейнер:
среди нескольких владельцев — тот, что запускает веб-сервер (uwsgi, gunicorn, uvicorn и
подобные), иначе единственный с ролью «сервис». Параметр конфигурации получает каждый
контейнер файла (правило продукта: одинаковый параметр у двух контейнеров — две записи),
как и параметры из примера окружения.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

from archmap_scan import owners, secrets, texts, vocab
from archmap_scan.model import CodeParam, Findings, Loc
from archmap_scan.objects import HttpEntry, Model, Obj, Param

# Слова команды запуска, по которым контейнер считается веб-сервером своего кода.
_WEB_WORDS = frozenset({
    "uwsgi", "gunicorn", "uvicorn", "hypercorn", "daphne", "granian", "runserver",
    "waitress-serve",
})
_WORDS = re.compile(r"[a-z][a-z-]*")


def _serves_http(obj: Obj) -> bool:
    return any(
        u.command and _WEB_WORDS & set(_WORDS.findall(u.command.lower())) for u in obj.units
    )


def route_owner(path: str, containers: Sequence[Obj]) -> tuple[Obj | None, str | None]:
    """Контейнер маршрута из файла path или причина, почему его нет."""
    found = owners.file_owners(path, containers)
    if len(found) == 1:
        return found[0], None
    if not found:
        return None, texts.REASON_SHARED_LIB
    web = [o for o in found if _serves_http(o)]
    if len(web) == 1:
        return web[0], None
    picked = owners.primary(web or found, vocab.ROLE_SERVICE)
    if picked is not None:
        return picked, None
    return None, texts.REASON_MANY_OWNERS


def _unassigned(model: Model, kind: str, name: str, reason: str, loc: Loc) -> None:
    model.hint("unassigned", {"kind": kind, "name": name, "reason": reason, "source": str(loc)})


def _routes(model: Model, findings: Findings, containers: Sequence[Obj]) -> None:
    for route in sorted(findings.routes, key=lambda r: (r.loc, r.path, r.method)):
        owner, why = route_owner(route.loc.path, containers)
        if owner is None:
            _unassigned(model, "route", f"{route.method} {route.path}", why or "", route.loc)
            continue
        model.http.setdefault(owner.name, []).append(HttpEntry(
            method=route.method, path=route.path, framework=route.framework, loc=route.loc,
            parser=route.parser, prefix_unresolved=route.prefix_unresolved,
        ))
    for entries in model.http.values():
        entries.sort(key=lambda e: (e.path, e.method, e.loc))


def _merge(param: Param, reads: list[CodeParam]) -> None:
    """Чтения параметра в коде дополняют запись из манифестов: места в основания, дефолт
    и тип — если их ещё нет (дефолт по правилу секретов), required — если ни одно
    чтение не даёт дефолта, а хотя бы одно без значения не обходится."""
    reads = sorted(reads, key=lambda r: r.loc)
    for read in reads:
        param.locs.add(read.loc)
        param.parsers.add(read.parser)
    if param.default is None:
        for read in reads:
            safe = secrets.safe_default(param.name, read.default)
            if safe is not None:
                param.default = safe
                break
    if param.type is None:
        param.type = next((r.type for r in reads if r.type), None)
    if not any(r.has_default for r in reads) and any(r.required for r in reads):
        param.required = True


def _params(model: Model, findings: Findings, containers: Sequence[Obj]) -> None:
    by_owner: dict[str, dict[str, list[CodeParam]]] = {}
    shared: dict[str, list[CodeParam]] = {}
    for read in findings.code_params:
        found = owners.file_owners(read.loc.path, containers)
        if not found:
            shared.setdefault(read.name, []).append(read)
        for obj in found:
            by_owner.setdefault(obj.name, {}).setdefault(read.name, []).append(read)
    for owner, reads_of in by_owner.items():
        table = model.params.setdefault(owner, {})
        for name, reads in reads_of.items():
            _merge(table.setdefault(name, Param(name=name)), reads)
    for name, reads in sorted(shared.items()):
        _unassigned(model, "config", name, texts.REASON_SHARED_LIB, min(r.loc for r in reads))


def attach(model: Model, findings: Findings) -> None:
    """Записи яруса кода — владельцам модели; без владельца — в подсказки."""
    containers = [o for o in model.objects if o.is_container]
    _routes(model, findings, containers)
    _params(model, findings, containers)
