"""Отнесение записей к владельцу (ТЗ §7).

Контейнер файла — контейнер с самым длинным каталогом кода, содержащим файл; если таких
несколько (собраны из одного каталога), владельцев несколько. Файл вне каталогов всех
контейнеров — общий код, его записи уходят в подсказки; но единственный контейнер со своим
кодом владеет и кодом вне своего каталога, если язык файла совпадает с его языком или
его язык не определён (Sentry: контейнер self-hosted один, а код продукта лежит в src/).
База для миграций: база по адресу в окружении контейнера-владельца каталога миграций, иначе
единственная реляционная база в манифестах, иначе владелец не определим.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING

from archmap_scan import paths, texts, vocab
from archmap_scan.links import hosts_in

if TYPE_CHECKING:
    from archmap_scan.model import EnvVar
    from archmap_scan.objects import Obj


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
    ".rb": "Ruby", ".php": "PHP", ".java": "Java", ".kt": "Java", ".rs": "Rust",
    ".ex": "Elixir", ".exs": "Elixir", ".cs": ".NET",
}


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
    if sole.language is None or sole.language == language:
        return [sole]
    return []


def file_owners(rel: str, containers: Sequence[Obj], language: str | None = None) -> list[Obj]:
    """Контейнеры файла кода: code_owners, а среди них — те, чей язык совпадает с языком
    файла. Контейнер другого языка файлом не владеет (ТЗ §15 п. 10 А5: браузерный код
    Mastodon не параметр процессов Ruby); контейнер без опознанного языка владеет любым.
    Файл вне каталогов всех контейнеров — единственному контейнеру по sole_owner. Одно
    место для маршрутов, параметров, каналов, расписаний и владельца миграций; причину
    пустого ответа даёт missing_reason."""
    found = code_owners(rel, containers)
    lang = language or file_language(rel)
    if not found:
        return sole_owner(containers, lang)
    if lang is None:
        return found
    same = [o for o in found if o.language == lang]
    if same:
        return same
    return [o for o in found if o.language is None]


def missing_reason(rel: str, containers: Sequence[Obj]) -> str:
    """Причина, по которой file_owners пуст: файл в каталоге контейнеров другого языка или
    вне каталогов кода всех контейнеров."""
    if code_owners(rel, containers):
        return texts.REASON_OTHER_LANGUAGE
    return texts.REASON_SHARED_LIB


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
    for owner in file_owners(folder, containers, language):
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
