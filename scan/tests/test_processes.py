"""Procfile, supervisor, systemd: процессы как контейнеры, роли и очереди воркеров."""

from __future__ import annotations

from archmap_scan import vocab
from archmap_scan.parsers import procfile, supervisor, systemd
from tests.helpers import FIXTURES, files_of, model_of


def test_procfile_units() -> None:
    ctx, files = files_of(FIXTURES / "procfile")
    found = procfile.parse(files, ctx)
    roles = {u.name: (u.role, u.home_dir) for u in found.units}
    assert roles == {
        "web": ("сервис", "services/orders"),
        "worker": ("воркер", "services/orders"),
        "beat": ("планировщик", "services/orders"),
    }
    assert [h.data["name"] for h in found.hints] == ["release"]


def test_procfile_web_joins_compose_container() -> None:
    model = model_of(FIXTURES / "procfile")
    names = sorted(o.name for o in model.objects)
    # web — это сам orders: тот же каталог кода.
    assert names == ["beat", "orders", "worker"]
    orders = model.obj("orders")
    assert orders is not None and orders.parsers == ["compose", "procfile"]
    # Три процесса из одного каталога: путь к коду не ставится никому.
    assert model.hints["shared_code"][0]["containers"] == ["beat", "orders", "worker"]
    assert [w.queues for w in model.workers["worker"]] == [["orders", "emails"]]
    assert model.workers["beat"][0].command == "celery -A orders beat"


def test_supervisor_programs() -> None:
    ctx, files = files_of(FIXTURES / "supervisor")
    found = supervisor.parse(files, ctx)
    units = {u.name: u for u in found.units}
    assert set(units) == {"zulip-django", "zulip-workers", "smokescreen"}
    django = units["zulip-django"]
    assert django.command == "/home/zulip/deployments/current/manage.py runserver --noreload"
    assert django.replicas == 2 and str(django.loc) == "conf.d/zulip.conf:2"
    dynamic = [h.data for h in found.hints if h.section == "dynamic_names"]
    assert [d["name"] for d in dynamic] == ["zulip_events_<%= queue %>"]
    model = model_of(FIXTURES / "supervisor")
    assert model.workers == {}
    assert vocab.queues_in(units["zulip-workers"].command) == ["deferred_work"]


def test_systemd_units() -> None:
    ctx, files = files_of(FIXTURES / "systemd")
    found = systemd.parse(files, ctx)
    units = {u.name: u for u in found.units}
    assert set(units) == {"orders-consumer", "report"}
    consumer = units["orders-consumer"]
    assert consumer.command == "/usr/bin/python3 -m orders.consumer"
    assert consumer.role == "воркер" and str(consumer.command_loc) == "orders-consumer.service:5"


def test_queues_in_forms() -> None:
    assert vocab.queues_in("celery -A x worker -Qa,b") == ["a", "b"]
    assert vocab.queues_in("celery worker -Q 'a,b' --queues=c") == ["a", "b", "c"]
    assert vocab.queues_in("rq worker high default --burst") == ["high", "default"]
    assert vocab.queues_in("x --queue_name=<%= q %>") == []
    assert vocab.queues_in(None) == []
