"""Procfile, supervisor, systemd: процессы как контейнеры, роли и очереди воркеров."""

from __future__ import annotations

from pathlib import Path

from archmap_scan import vocab
from archmap_scan.parsers import procfile, supervisor, systemd
from tests.helpers import FIXTURES, files_of, model_of, tree


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


def test_process_technology_by_command(tmp_path: Path) -> None:
    """Находка фазы 1а на Zulip: программы supervisor без технологии. Команда рантайма
    языка даёт стек корневого пакета этого языка и владение корнем; программа вне
    репозитория — технологию по словарю образов."""
    tree(tmp_path, {
        "pyproject.toml": (
            '[project]\nname = "zulip-server"\n[dependency-groups]\nprod = ["django"]\n'
        ),
        "package.json": '{"name": "zulip", "dependencies": {"koa": "3"}}',
        "go.mod": "module github.com/org/relay/v2\n",
        "puppet/supervisor/zulip.conf.template.erb": (
            "[program:zulip-django]\ncommand=nice -n5 uv run --no-sync uwsgi --ini /etc/u.ini\n"
            "[program:zulip-tornado]\n"
            "command=/home/zulip/deployments/current/manage.py runtornado 127.0.0.1:9800\n"
            "[program:katex]\n"
            "command=/usr/local/bin/secret-env-wrapper S=x /srv/node/bin/node katex.js\n"
            "[program:nginx]\ncommand=/usr/sbin/nginx -g 'daemon off;'\n"
            "[program:cron]\ncommand = /usr/sbin/cron -f -L 15\n"
            "[program:exporter]\ncommand=<%= @bin %> --web.listen-address=127.0.0.1:9121\n"
            "[program:relay]\ncommand=/usr/local/bin/relay --port 1\n"
        ),
        "puppet/files/tool.service": "[Service]\nExecStart=/usr/bin/java -jar /opt/tool.jar\n",
    })
    model = model_of(tmp_path, system=None)
    got = {
        o.name: (o.shape, o.technology, o.role, o.code_dir)
        for o in model.objects
    }
    assert got == {
        "zulip-django": ("service", "Python + Django", "сервис", ""),
        "zulip-tornado": ("service", "Python + Django", "сервис", ""),
        "katex": ("service", "Node.js + Koa", "сервис", ""),
        "nginx": ("service", "nginx", "прокси", None),
        "cron": ("service", "cron", "планировщик", None),
        "exporter": ("service", None, "сервис", None),
        "relay": ("service", "Go", "сервис", ""),
        # Корневого манифеста Java нет: только язык, каталога кода нет.
        "tool": ("service", "Java", "сервис", None),
    }
    katex = model.obj("katex")
    assert katex is not None and katex.language == "Node.js"
    # Основания — манифест своего языка, не все манифесты корня.
    assert {loc.path for loc in katex.locs} == {
        "package.json", "puppet/supervisor/zulip.conf.template.erb",
    }
    # Имя корня — из package.json, первого по старшинству манифеста сборки.
    assert model.system == "zulip"


def test_command_language_and_program() -> None:
    go = frozenset({"grafana"})
    cases = {
        "/usr/share/grafana/bin/grafana server --config x": "Go",
        "python3.12 -m app": "Python",
        "bash -c 'exec /opt/app/run.py'": "Python",
        "bundle exec puma -C config/puma.rb": "Ruby",
        "php artisan queue:work": "PHP",
        "npx tsx server.ts": "Node.js",
        "/usr/sbin/nginx": None,
        "<%= @python %> app.py": "Python",
        "": None,
    }
    for command, lang in cases.items():
        assert vocab.command_language(command, go) == lang, command
    assert vocab.command_program("nice -n 5 FOO=bar /usr/sbin/cron -f") == "cron"
    assert vocab.command_program("<%= @bin %> --x") is None
    assert vocab.command_program("-- 10") is None
    assert vocab.command_program(None) is None
