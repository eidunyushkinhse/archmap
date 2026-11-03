"""Отнесение находок яруса кода к владельцам (ТЗ §6.2, §7).

Файл кода принадлежит контейнеру по owners.file_owners: самый длинный каталог кода, а
среди контейнеров одного каталога — того же языка. Файл вне каталогов всех контейнеров —
общий код: его записи уходят в hints.unassigned. Маршрут HTTP получает один контейнер:
среди нескольких владельцев — тот, что запускает веб-сервер (uwsgi, gunicorn, uvicorn и
подобные), иначе единственный с ролью «сервис».
"""

from __future__ import annotations

import re
from collections.abc import Sequence

from archmap_scan import owners, texts, vocab
from archmap_scan.model import Findings, Loc
from archmap_scan.objects import HttpEntry, Model, Obj

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


def attach(model: Model, findings: Findings) -> None:
    """Записи яруса кода — владельцам модели; без владельца — в подсказки."""
    containers = [o for o in model.objects if o.is_container]
    _routes(model, findings, containers)
