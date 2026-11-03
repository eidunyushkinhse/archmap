"""Отнесение записей к владельцу (ТЗ §7).

Контейнер файла — контейнер с самым длинным каталогом кода, содержащим файл; если таких
несколько (собраны из одного каталога), владельцев несколько. Файл вне каталогов всех
контейнеров — общий код, его записи уходят в подсказки. База для миграций: база по адресу в
окружении контейнера-владельца каталога миграций, иначе единственная реляционная база в
манифестах, иначе владелец не определим.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING

from archmap_scan import paths, vocab
from archmap_scan.links import hosts_in

if TYPE_CHECKING:
    from archmap_scan.assemble import Obj
    from archmap_scan.model import EnvVar


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


def database_for(
    folder: str, containers: Sequence[Obj], databases: Sequence[Obj],
    env_of: dict[str, list[EnvVar]],
) -> tuple[Obj | None, str | None]:
    """База для набора миграций в каталоге folder и причина, если владелец не определим."""
    relational = [d for d in databases if d.technology in vocab.RELATIONAL]
    by_host = {d.host: d for d in relational if d.host}
    pointed: list[Obj] = []
    for owner in code_owners(folder, containers):
        for var in env_of.get(owner.name, []):
            if var.dynamic or var.value is None:
                continue
            for host, _scheme in hosts_in(var.name, var.value):
                db = by_host.get(host)
                if db is not None and db not in pointed:
                    pointed.append(db)
    if len(pointed) == 1:
        return pointed[0], None
    if len(relational) == 1:
        return relational[0], None
    if not relational:
        return None, "no_database"
    return None, "many_databases"
