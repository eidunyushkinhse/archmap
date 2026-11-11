"""Команды скриптов репозитория, которые запускает единица (ТЗ §15 п. 16 П1): простые команды
скрипта, владелец расписаний Celery beat и маршрутов по ним, роль и враждебный вход."""

from __future__ import annotations

import shutil
from functools import partial
from pathlib import Path

import pytest

from archmap_scan import registry, scripts, texts
from archmap_scan.walk import Files, list_files
from tests.helpers import FIXTURES, ctx_of, model_of, time_limit, timed, tree


def test_simple_commands() -> None:
    text = (
        "#!/bin/bash\n"
        "set -e  # не команда\n"
        "# celery -A app beat в комментарии\n"
        "help () {\n  echo 'worker: справка'\n}\n"
        "case \"$1\" in\n  -h|--help) help ;;\n  *) shift ;;\nesac\n"
        "if [ -n \"$X\" ]; then ./bin/a & fi\n"
        "X=1\nY=\"a b\" Z=(1 2) celery -A app worker -Q a,b 2>&1 | tee log\n"
        "exec gunicorn app:app\n"
        "cat <<EOF\nworker внутри heredoc\nEOF\n"
        "for x in a b; do run-$x; done\n"
        "echo \"a; b && c\" && python manage.py migrate \\\n  --check\n"
        "export Q=$(cd x && pwd)\n"
    )
    # help — вызов функции скрипта (команда), её определение и шаблоны case командами не
    # считаются; run-$x — программа подстановкой.
    assert scripts.simple_commands(text) == [
        "help", "./bin/a", "celery -A app worker -Q a,b 2>&1", "exec gunicorn app:app",
        "python manage.py migrate --check",
    ]


def test_fixture_owners_and_roles() -> None:
    """Фикстура command-script: веб-сервер виден через скрипт (маршрут у web), планировщик
    Celery запускают двое (worker через два скрипта и beat прямо) — подсказка «несколько»;
    команда вне репозитория и bundle install ничего не дают, свой файл второй раз не читается."""
    model = model_of(FIXTURES / "command-script")
    units = {o.name: [c for u in o.units for c in u.script_commands] for o in model.objects}
    assert units == {
        "beat": [], "bundler": [], "tool": [],
        "web": ["exec gunicorn app.web:web"],
        "worker": ["./bin/run-beat", "celery -A app worker", "./bin/run-worker", "celery -A app beat"],
    }
    roles = {o.name: o.role for o in model.objects}
    assert roles == {
        "beat": "планировщик", "bundler": "сервис", "tool": "сервис", "web": "сервис",
        "worker": "воркер",
    }
    assert {k: [(e.method, e.path, str(e.loc)) for e in v] for k, v in model.http.items()} == {
        "web": [("GET", "/health", "app/web.py:6")],
    }
    assert model.schedules == {}
    assert [(h["name"], h["reason"], h["source"]) for h in model.hints["unassigned"]] == [
        ("nightly", texts.REASON_MANY_OWNERS, "app/beat.py:6"),
    ]


def _copy(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    shutil.copytree(FIXTURES / "command-script", root)
    return root


def test_single_beat_runner_owns_schedules(tmp_path: Path) -> None:
    """Без сервиса beat планировщик один (worker через ./bin/run-beat): расписание у него.
    Скрипт больше 64 КБ читается первыми 64 КБ (beat за ними не виден), двоичный файл по
    пути и цепочка глубже двух скриптов не раскрываются."""
    root = _copy(tmp_path)
    compose = (root / "compose.yaml").read_text(encoding="utf-8")
    compose = compose.replace(
        "  beat:\n    build: .\n    command: celery -A app beat\n",
        "  big:\n    build: .\n    command: ./bin/big.sh\n"
        "  blob:\n    build: .\n    command: ./bin/blob\n"
        "  deep:\n    build: .\n    command: ./bin/d1\n"
        "  pyscript:\n    build: .\n    command: ./bin/tool.py\n",
    )
    tree(root, {
        "compose.yaml": compose,
        "bin/big.sh": "#!/bin/sh\n" + "# заполнитель\n" * 6000 + "celery -A app beat\n",
        "bin/blob": b"\x7fELF\0\0celery -A app beat\n",
        "bin/d1": "./bin/d2\n",
        "bin/d2": "./bin/d3\n",
        "bin/d3": "celery -A app beat\n",
        "bin/tool.py": "#!/usr/bin/env python3\nprint('celery -A app beat')\n",
    })
    assert (root / "bin/big.sh").stat().st_size > scripts.MAX_SCRIPT_BYTES
    model = model_of(root)
    units = {o.name: [c for u in o.units for c in u.script_commands] for o in model.objects}
    assert units["big"] == [] and units["blob"] == [] and units["pyscript"] == []
    # Глубина два: d1 → d2 читаются, d3 нет.
    assert units["deep"] == ["./bin/d2", "./bin/d3"]
    assert [(s.name, s.schedule, str(s.loc)) for s in model.schedules["worker"]] == [
        ("nightly", "crontab(hour=3, minute=0)", "app/beat.py:6"),
    ]
    assert not [h for h in model.hints.get("unassigned", []) if h["kind"] == "schedule"]


def test_with_scheduler_flag_is_not_evidence(tmp_path: Path) -> None:
    """Флаг --with-scheduler без celery beat в скрипте свидетельством не считается: владелец
    по прежнему правилу (единственный планировщик по роли)."""
    root = _copy(tmp_path)
    tree(root, {"bin/run-beat": "#!/bin/sh\necho beat\n"})
    compose = (root / "compose.yaml").read_text(encoding="utf-8")
    tree(root, {"compose.yaml": compose.replace("command: celery -A app beat", "command: beat-tool")})
    model = model_of(root)
    roles = {o.name: o.role for o in model.objects}
    assert roles["beat"] == "планировщик"
    assert [s.name for s in model.schedules["beat"]] == ["nightly"]


def test_script_paths_from_bases(tmp_path: Path) -> None:
    """Путь скрипта ищется от контекста сборки, от каталога манифеста и от корня: первый
    существующий. Скрипт Procfile в подкаталоге и CMD Dockerfile тоже раскрываются."""
    root = tree(tmp_path, {
        "requirements.txt": "celery\n",
        "deploy/compose.yaml": "services:\n  a:\n    build: ../svc\n    command: ./serve\n"
        "  b:\n    image: x/b\n    command: bin/b\n",
        "svc/Dockerfile": "FROM python:3.12\nCMD [\"./entry.sh\"]\n",
        "svc/serve": "celery -A a worker\n",
        "svc/entry.sh": "#!/usr/bin/env bash\nexec uvicorn a:app\n",
        "bin/b": "#!/bin/sh\ncelery -A b beat\n",
        "deploy/bin/b": "#!/bin/sh\ncelery -A deploy beat\n",
    })
    ctx = ctx_of(root)
    listing = list_files(ctx)
    files = Files(ctx.root, listing.files, listing.docs)
    findings, errors = registry.collect(files, ctx)
    assert errors == {}
    got = {u.name: u.script_commands for u in findings.units}
    assert got["a"] == ["celery -A a worker"]
    # Каталог манифеста раньше корня.
    assert got["b"] == ["celery -A deploy beat"]
    assert [d.script_commands for d in findings.dockerfiles] == [["exec uvicorn a:app"]]


HOSTILE = {
    "semis": ";" * 2_000_000,
    "subs": "$(" * 1_000_000,
    "quote": "\"" + "a" * 2_000_000,
    "heredocs": "cat <<E;" * 250_000,
    "fdef": "a() " * 500_000,
    "assign": "A=\"" + "\\" * 2_000_000,
    "dollar": "x $" * 700_000,
    "chain": "./bin/s\n" * 250_000,
}


@pytest.mark.parametrize("kind", sorted(HOSTILE))
def test_hostile_script(tmp_path: Path, kind: str) -> None:
    """Враждебный скрипт на 2 МБ у сорока единиц: читаются первые 64 КБ один раз за запуск,
    команд у единицы не больше предела."""
    services = "".join(f"  s{i}:\n    image: x/s{i}\n    command: ./bin/s --x\n" for i in range(40))
    root = tree(tmp_path, {"compose.yaml": "services:\n" + services, "bin/s": HOSTILE[kind]})
    ctx = ctx_of(root)
    listing = list_files(ctx)
    files = Files(ctx.root, listing.files, listing.docs)
    findings, _errors = registry.collect(files, ctx)
    # Повтор в timed по тому же пределу, что проверяется (ТЗ §15 п. 18 П3).
    limit = time_limit() * 0.7
    _none, took = timed(partial(scripts.attach, findings, files), limit)
    assert took < limit, f"{kind}: {took:.2f} с"
    assert all(len(u.script_commands) <= scripts.MAX_UNIT_COMMANDS for u in findings.units)

