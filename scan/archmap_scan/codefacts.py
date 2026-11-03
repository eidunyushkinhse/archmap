"""Отнесение находок яруса кода к владельцам (ТЗ §6.2, §7).

Файл кода принадлежит контейнеру по owners.file_owners: самый длинный каталог кода, а
среди контейнеров одного каталога — того же языка. Файл вне каталогов всех контейнеров —
общий код: его записи уходят в hints.unassigned. Маршрут HTTP получает один контейнер:
среди нескольких владельцев — тот, что запускает веб-сервер (uwsgi, gunicorn, uvicorn и
подобные), иначе единственный с ролью «сервис». Параметр конфигурации получает каждый
контейнер файла (правило продукта: одинаковый параметр у двух контейнеров — две записи),
как и параметры из примера окружения.

Канал принадлежит брокеру (ТЗ §7): брокер по адресу литералом в том же файле или в
окружении контейнера файла, иначе единственный брокер этого вида, иначе канал уходит в
hints.unassigned. Направление даёт связь: публикация — контейнер → брокер «публикует»,
потребление — брокер → контейнер «потребляет», с channel и sync: false; одна связь на
пару, направление и канал. Связь «использует» той же пары из манифестов при этом не
рисуется: связь с каналом сильнее.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

from archmap_scan import owners, secrets, texts, vocab
from archmap_scan.links import hosts_in
from archmap_scan.model import ChannelUse, CodeParam, EnvVar, Findings, Loc
from archmap_scan.objects import (
    BROKER,
    Channel,
    Consumer,
    HttpEntry,
    Link,
    Model,
    Obj,
    Param,
)

EnvOf = dict[str, list[tuple[EnvVar, str]]]
# Вид клиента → технологии брокера, который его обслуживает.
_CLIENT_TECH = {
    "Kafka": frozenset({"Kafka", "Redpanda"}), "RabbitMQ": frozenset({"RabbitMQ"}),
    "NATS": frozenset({"NATS"}), "Celery": frozenset({"Redis", "RabbitMQ"}),
}
_LABEL = {"publish": "публикует", "consume": "потребляет"}
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
        model.code_parsers.setdefault("http_routes", set()).add(route.parser)
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
        model.code_parsers.setdefault("config", set()).add(read.parser)
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


def _broker(
    model: Model, use: ChannelUse, file_owners: Sequence[Obj], env_of: EnvOf,
) -> tuple[Obj | None, str | None]:
    """Брокер-владелец канала или причина, почему его нет."""
    techs = _CLIENT_TECH.get(use.client, frozenset())
    by_host = {o.host.lower(): o for o in model.objects if o.host and o.technology in techs}
    pointed: list[Obj] = []
    if use.broker_host and use.broker_host.lower() in by_host:
        pointed.append(by_host[use.broker_host.lower()])
    else:
        for owner in file_owners:
            for var, _parser in env_of.get(owner.name, []):
                if var.dynamic or var.value is None:
                    continue
                for host, _scheme in hosts_in(var.name, var.value):
                    obj = by_host.get(host)
                    if obj is not None and obj not in pointed:
                        pointed.append(obj)
    if len(pointed) == 1:
        broker = pointed[0]
        if broker.shape != BROKER:
            # Redis по адресу брокера Celery считается брокером, а не кэшем.
            broker.shape, broker.role = BROKER, vocab.ROLE_BROKER
        return broker, None
    brokers = [o for o in model.objects if o.shape == BROKER and o.technology in techs]
    if len(brokers) == 1:
        return brokers[0], None
    return None, texts.REASON_MANY_BROKERS if brokers else texts.REASON_NO_BROKER


def _worker_queues(model: Model) -> list[tuple[ChannelUse, Obj]]:
    """Очереди из «-Q» в командах воркеров Celery: потребление этим контейнером."""
    out: list[tuple[ChannelUse, Obj]] = []
    for obj in model.objects:
        for worker in model.workers.get(obj.name, []):
            if "celery" not in _WORDS.findall(worker.command.lower()):
                continue
            for queue in worker.queues:
                out.append((ChannelUse(
                    name=queue, kind="queue", client="Celery", direction="consume",
                    loc=worker.loc, parser=worker.parser,
                ), obj))
    return out


def _link(
    model: Model, index: dict[tuple[str, str, str, str], Link], container: Obj, broker: Obj,
    use: ChannelUse,
) -> None:
    src, dst = (container, broker) if use.direction == "publish" else (broker, container)
    label = _LABEL[use.direction or ""]
    key = (src.name, dst.name, label, use.name)
    link = index.get(key)
    if link is None:
        link = index[key] = Link(
            src=src, dst=dst, label=label, technology=broker.technology, channel=use.name,
            sync=False,
        )
        model.links.append(link)
    link.locs.add(use.loc)
    link.parsers.add(use.parser)


def _channels(model: Model, findings: Findings, containers: Sequence[Obj], env_of: EnvOf) -> None:
    index: dict[tuple[str, str, str, str], Link] = {}
    uses = [(u, None) for u in findings.channels] + _worker_queues(model)
    for use, worker in sorted(uses, key=lambda item: (item[0].loc, item[0].name)):
        model.code_parsers.setdefault("channels", set()).add(use.parser)
        file_owners = [worker] if worker else owners.file_owners(use.loc.path, containers)
        broker, why = _broker(model, use, file_owners, env_of)
        if broker is None:
            _unassigned(model, "channel", use.name, why or "", use.loc)
            continue
        table = model.channels.setdefault(broker.name, {})
        channel = table.setdefault(use.name, Channel(name=use.name, kind=use.kind))
        channel.locs.add(use.loc)
        channel.parsers.add(use.parser)
        if use.direction is None:
            continue
        prefer = vocab.ROLE_WORKER if use.direction == "consume" else vocab.ROLE_SERVICE
        container = owners.primary(file_owners, prefer)
        if container is None:
            continue
        _link(model, index, container, broker, use)
        if use.direction == "consume":
            model.consumers.setdefault(container.name, []).append(Consumer(
                channel=use.name, kind=use.kind, broker=broker.name, loc=use.loc,
                parser=use.parser,
            ))
    # Связь с каналом сильнее «использует» той же пары объектов из манифестов.
    paired = {frozenset((lk.src.name, lk.dst.name)) for lk in model.links if lk.channel}
    model.links = sorted(
        (lk for lk in model.links
         if lk.channel or frozenset((lk.src.name, lk.dst.name)) not in paired),
        key=lambda lk: (lk.src.name, lk.dst.name, lk.label, lk.channel or ""),
    )
    for items in model.consumers.values():
        items.sort(key=lambda c: (c.channel, c.loc))


def attach(model: Model, findings: Findings, env_of: EnvOf) -> None:
    """Записи яруса кода — владельцам модели; без владельца — в подсказки."""
    containers = [o for o in model.objects if o.is_container]
    _routes(model, findings, containers)
    _params(model, findings, containers)
    _channels(model, findings, containers, env_of)
