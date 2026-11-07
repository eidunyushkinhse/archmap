"""Отнесение находок яруса кода к владельцам (ТЗ §6.2, §7).

Файл кода принадлежит контейнеру по owners.file_owners: самый длинный каталог кода, а
среди контейнеров одного каталога — того же языка. Файл вне каталогов всех контейнеров —
общий код: его записи уходят в hints.unassigned, если контейнер в репозитории не один
(единственный контейнер владеет и общим кодом своего языка, owners.sole_owner). Маршрут HTTP получает один контейнер:
среди нескольких владельцев — тот, что запускает веб-сервер (uwsgi, gunicorn, uvicorn и
подобные), иначе единственный с ролью «сервис». Параметр конфигурации получает каждый
контейнер файла (правило продукта: одинаковый параметр у двух контейнеров — две записи),
как и параметры из примера окружения.

Канал принадлежит брокеру (ТЗ §7): брокер по адресу литералом в том же файле или в
окружении контейнера файла, иначе единственный брокер этого вида, иначе канал уходит в
hints.unassigned. Брокера этого вида в манифестах нет вовсе, а клиент в зависимостях и
каналы в коде есть (Sentry: Kafka, Zulip: RabbitMQ) — объект-брокер по клиенту с именем
технологии, без host, по образцу базы по миграциям (ТЗ §13.2); у Celery технологию называет
схема адреса брокера (redis://, amqp://), без неё брокер не создаётся. Направление даёт
связь: публикация — контейнер → брокер «публикует», потребление — брокер → контейнер
«доставляет» (подпись называет действие источника связи), с channel и sync: false; одна
связь на пару, направление и канал. Связь «использует» той же пары из манифестов (адрес в
окружении, depends_on) остаётся рядом: это другой факт со своим основанием, и связи кода
его не вытесняют (ТЗ §15 п. 13 В1: иначе sidekiq → redis Mastodon и web → kafka PostHog,
верные связи корнер-кейсов, пропали бы). Связь, контейнер которой не определим, уходит в
hints.unassigned, а канал при этом пишется.

Расписание из кода Celery beat или файла crontab получает контейнер файла, среди
нескольких — единственный с ролью «планировщик»; иначе оно уходит в hints.unassigned.
Воркеров из кода сборщик не заводит: только из манифестов. Запись с программой-исполнителем
(runner: классы воркеров и расписание Sidekiq) получает среди контейнеров файла тот, чья
команда запускает эту программу (bundle exec sidekiq), а не контейнер по роли (ТЗ §15 п. 13
В3: у Mastodon web и sidekiq собраны из одного каталога).

Записи разборщиков кода из служебных каталогов и конфигов инструментов
(codebase.tooling_reason) и переменные операционной системы или CI (vocab.is_os_variable)
фактами не считаются (ТЗ §13.1): они уходят в hints.unassigned со своей причиной, в
facts/ и entrypoints их нет, а файлы служебных каталогов считаются в покрытии.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

from archmap_scan import codebase, owners, registry, secrets, texts, vocab
from archmap_scan.links import hosts_in
from archmap_scan.model import ChannelUse, CodeParam, EnvVar, Findings, Loc
from archmap_scan.objects import (
    BROKER,
    SHAPE_ORDER,
    Channel,
    Consumer,
    HttpEntry,
    Link,
    Model,
    Obj,
    Param,
    Schedule,
)
from archmap_scan.parsers import celery

EnvOf = dict[str, list[tuple[EnvVar, str]]]
# Вид клиента → технологии брокера, который его обслуживает.
_CLIENT_TECH = {
    "Kafka": frozenset({"Kafka", "Redpanda"}), "RabbitMQ": frozenset({"RabbitMQ"}),
    "NATS": frozenset({"NATS"}), "Celery": frozenset({"Redis", "RabbitMQ"}),
    "BullMQ": frozenset({"Redis"}), "Sidekiq": frozenset({"Redis"}),
}
# Клиент → технология брокера по клиенту в порядке создания: Celery последним, его брокер
# бывает тот же RabbitMQ.
_CLIENT_BROKER = {"Kafka": "Kafka", "RabbitMQ": "RabbitMQ", "NATS": "NATS"}
_CLIENT_ORDER = ("Kafka", "RabbitMQ", "NATS", "Celery")
_LABEL = {"publish": texts.LABEL_PUBLISHES, "consume": texts.LABEL_DELIVERS}
# Слова команды запуска, по которым контейнер считается веб-сервером своего кода.
_WEB_WORDS = frozenset({
    "uwsgi", "gunicorn", "uvicorn", "hypercorn", "daphne", "granian", "runserver",
    "waitress-serve",
})
_WORDS = re.compile(r"[a-z][a-z-]*")
# Разборщики яруса кода: только их записи бывают из служебных каталогов (файл crontab и
# команды воркеров из манифестов — не код).
_CODE_PARSERS = frozenset(p.name for p in registry.PARSERS if p.code)


def _runs(obj: Obj, program: str) -> bool:
    """Команда одного из манифестов объекта запускает программу (bundle exec sidekiq)."""
    return any(vocab.command_program(u.command) == program for u in obj.units)


def _runner(
    rel: str, program: str, file_owners: Sequence[Obj], containers: Sequence[Obj],
) -> tuple[Obj | None, str]:
    """Владелец записи процесса program среди контейнеров файла (ТЗ §15 п. 13 В3) или
    причина, почему его нет."""
    runners = [o for o in file_owners if _runs(o, program)]
    if len(runners) == 1:
        return runners[0], ""
    if runners:
        return None, texts.REASON_MANY_OWNERS
    if file_owners:
        return None, texts.REASON_NO_RUNNER.format(program=program)
    return None, owners.missing_reason(rel, containers)


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
        return None, owners.missing_reason(path, containers)
    web = [o for o in found if _serves_http(o)]
    if len(web) == 1:
        return web[0], None
    picked = owners.primary(web or found, vocab.ROLE_SERVICE)
    if picked is not None:
        return picked, None
    return None, texts.REASON_MANY_OWNERS


def _unassigned(model: Model, kind: str, name: str, reason: str, loc: Loc) -> None:
    model.hint("unassigned", {"kind": kind, "name": name, "reason": reason, "source": str(loc)})


def _tooling(model: Model, family: str, parser: str, loc: Loc) -> str | None:
    """Причина, если запись разборщика кода из служебного каталога или конфига инструмента
    (файл тогда считается в покрытии семьи), иначе None."""
    if parser not in _CODE_PARSERS:
        return None
    reason = codebase.tooling_reason(loc.path)
    if reason is not None:
        model.tooling_files.setdefault(family, set()).add(loc.path)
    return reason


def _routes(model: Model, findings: Findings, containers: Sequence[Obj]) -> None:
    """Маршруты владельцам. Одинаковые записи (метод, путь, фреймворк, префикс, источник)
    пишутся один раз (ТЗ §5.3): Zulip подключает i18n_urls дважды, маршрут от этого не
    удваивается; счёт в покрытии идёт по записанному."""
    seen: set[tuple[str, str, str, bool, Loc]] = set()
    for route in sorted(findings.routes, key=lambda r: (r.loc, r.path, r.method)):
        model.code_parsers.setdefault("http_routes", set()).add(route.parser)
        key = (route.method, route.path, route.framework, route.prefix_unresolved, route.loc)
        if key in seen:
            continue
        seen.add(key)
        aside = _tooling(model, "http_routes", route.parser, route.loc)
        if aside is not None:
            _unassigned(model, "route", f"{route.method} {route.path}", aside, route.loc)
            continue
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
    shared: dict[tuple[str, str], list[CodeParam]] = {}
    aside: dict[tuple[str, str], list[Loc]] = {}
    for read in findings.code_params:
        model.code_parsers.setdefault("config", set()).add(read.parser)
        if vocab.is_os_variable(read.name):
            model.os_vars.setdefault(read.name, set()).add(read.loc)
            continue
        why = _tooling(model, "config", read.parser, read.loc)
        if why is not None:
            aside.setdefault((read.name, why), []).append(read.loc)
            continue
        found = owners.file_owners(read.loc.path, containers)
        if not found:
            why = owners.missing_reason(read.loc.path, containers)
            shared.setdefault((read.name, why), []).append(read)
        for obj in found:
            by_owner.setdefault(obj.name, {}).setdefault(read.name, []).append(read)
    for owner, reads_of in by_owner.items():
        table = model.params.setdefault(owner, {})
        for name, reads in reads_of.items():
            _merge(table.setdefault(name, Param(name=name)), reads)
    for (name, why), reads in sorted(shared.items()):
        _unassigned(model, "config", name, why, min(r.loc for r in reads))
    for (name, why), locs in sorted(aside.items()):
        _unassigned(model, "config", name, why, min(locs))


def _os_variables(model: Model) -> None:
    """Переменные операционной системы или CI из манифестов и кода: одна подсказка на имя
    с первым местом (ТЗ §13.1)."""
    for name, locs in sorted(model.os_vars.items()):
        _unassigned(model, "config", name, texts.REASON_OS_VARIABLE, min(locs))


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


def _client_tech(
    uses: Sequence[ChannelUse], containers: Sequence[Obj], env_of: EnvOf,
) -> str | None:
    """Технология брокера для каналов одного клиента: Kafka, RabbitMQ, NATS по клиенту, у
    Celery — по схеме адреса брокера литералом в коде или в окружении контейнера файла."""
    client = uses[0].client
    if client in _CLIENT_BROKER:
        return _CLIENT_BROKER[client]
    for use in uses:
        if use.broker_tech:
            return use.broker_tech
    for use in uses:
        for owner in owners.file_owners(use.loc.path, containers):
            for var, _parser in env_of.get(owner.name, []):
                if var.dynamic or var.value is None:
                    continue
                if var.name.upper() not in vocab.REDIS_BROKER_VARS:
                    continue
                for _host, scheme in hosts_in(var.name, var.value):
                    tech = celery.SCHEMES.get(scheme or "")
                    if tech:
                        return tech
    return None


def _client_brokers(
    model: Model, uses: Sequence[ChannelUse], containers: Sequence[Obj], env_of: EnvOf,
) -> None:
    """Объекты-брокеры по клиенту (ТЗ §13.2): брокера этого вида в манифестах нет, а клиент в
    зависимостях (иначе разборщик не читал бы файл) и каналы строкой в коде есть. Объект с
    той же технологией другого вида (Redis-кэш) брокером по клиенту не подменяется: тогда
    каналы остаются без владельца, как раньше."""
    by_client: dict[str, list[ChannelUse]] = {}
    for use in uses:
        if use.parser in _CODE_PARSERS:
            by_client.setdefault(use.client, []).append(use)
    for client in _CLIENT_ORDER:
        found = sorted(by_client.get(client, []), key=lambda u: (u.loc, u.name))
        techs = _CLIENT_TECH.get(client, frozenset())
        if not found or any(o.technology in techs for o in model.objects if o.shape == BROKER):
            continue
        tech = _client_tech(found, containers, env_of)
        if tech is None or any(o.technology == tech or o.name == tech for o in model.objects):
            continue
        broker = Obj(name=tech, shape=BROKER, role=vocab.ROLE_BROKER, technology=tech)
        broker.parsers.append(found[0].parser)
        broker.locs.add(found[0].loc)
        model.objects.append(broker)
        model.objects.sort(key=lambda o: (SHAPE_ORDER[o.shape], o.name))
        model.broker_by_client = True


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
    _client_brokers(model, [
        u for u, _w in uses if codebase.tooling_reason(u.loc.path) is None
    ], containers, env_of)
    for use, worker in sorted(uses, key=lambda item: (item[0].loc, item[0].name)):
        model.code_parsers.setdefault("channels", set()).add(use.parser)
        aside = _tooling(model, "channels", use.parser, use.loc)
        if aside is not None:
            _unassigned(model, "channel", use.name, aside, use.loc)
            continue
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
        if use.runner:
            container, reason = _runner(use.loc.path, use.runner, file_owners, containers)
        else:
            container = owners.primary(file_owners, prefer)
            reason = texts.REASON_MANY_OWNERS if file_owners else owners.missing_reason(
                use.loc.path, containers,
            )
        if container is None:
            # Канал записан брокеру, а чья это публикация или подписка, не известно.
            model.code_parsers.setdefault("edges", set()).add(use.parser)
            model.hint("unassigned", {
                "kind": "edge", "name": use.name, "object": broker.name, "reason": reason,
                "source": str(use.loc),
            })
            continue
        _link(model, index, container, broker, use)
        if use.direction == "consume":
            model.consumers.setdefault(container.name, []).append(Consumer(
                channel=use.name, kind=use.kind, broker=broker.name, loc=use.loc,
                parser=use.parser,
            ))
    # Связи кода не вытесняют «использует» той же пары из манифестов: оба факта остаются.
    model.links.sort(key=lambda lk: (lk.src.name, lk.dst.name, lk.label, lk.channel or ""))
    for items in model.consumers.values():
        items.sort(key=lambda c: (c.channel, c.loc))


def _schedules(model: Model, findings: Findings, containers: Sequence[Obj]) -> None:
    for sch in sorted(findings.schedules, key=lambda s: (s.loc, s.name)):
        model.code_parsers.setdefault("schedules", set()).add(sch.parser)
        aside = _tooling(model, "schedules", sch.parser, sch.loc)
        if aside is not None:
            _unassigned(model, "schedule", sch.name, aside, sch.loc)
            continue
        found = owners.file_owners(sch.loc.path, containers)
        if sch.runner:
            owner, why = _runner(sch.loc.path, sch.runner, found, containers)
        else:
            owner = owners.primary(found, vocab.ROLE_SCHEDULER)
            why = texts.REASON_MANY_OWNERS if found else owners.missing_reason(
                sch.loc.path, containers,
            )
        if owner is None:
            _unassigned(model, "schedule", sch.name, why, sch.loc)
            continue
        model.schedules.setdefault(owner.name, []).append(Schedule(
            name=sch.name, schedule=sch.schedule, task=sch.task, loc=sch.loc, parser=sch.parser,
        ))


def attach(model: Model, findings: Findings, env_of: EnvOf) -> None:
    """Записи яруса кода — владельцам модели; без владельца — в подсказки."""
    containers = [o for o in model.objects if o.is_container]
    _routes(model, findings, containers)
    _params(model, findings, containers)
    _os_variables(model)
    _channels(model, findings, containers, env_of)
    _schedules(model, findings, containers)
