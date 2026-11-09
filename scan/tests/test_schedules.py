"""Расписания из кода и файлов crontab (ТЗ §6.2): Celery beat и crontab по фикстурам,
владелец расписания, покрытие семьи и враждебный вход."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from archmap_scan import texts
from archmap_scan.parsers import celerybeat, crontab, gocron
from tests.helpers import FIXTURES, files_of, model_of, time_limit, tree

Row = tuple[str, str, str | None, str]


def _rows(parser: object, root: Path) -> tuple[list[Row], list[tuple[object, object]]]:
    ctx, files = files_of(root)
    found = parser.parse(files, ctx)  # type: ignore[attr-defined]
    rows = [(s.name, s.schedule, s.task, str(s.loc)) for s in found.schedules]
    return rows, [(h.data["name"], h.data["source"]) for h in found.hints]


def test_celery_beat_fixture() -> None:
    rows, hints = _rows(celerybeat, FIXTURES / "celery-beat")
    assert rows == [
        ("nightly-report", "crontab(hour=3, minute=0)", "proj.tasks.report", "proj/celery_app.py:9"),
        ("ping", "30.0", "proj.tasks.ping", "proj/celery_app.py:10"),
        ("weekly", "crontab(day_of_week='mon')", "proj.tasks.weekly", "proj/celery_app.py:16"),
        ("cleanup", "3600", "proj.tasks.cleanup", "proj/settings.py:2"),
        ("refresh", "crontab(minute='*/15')", "refresh", "proj/tasks.py:7"),
        ("ping-every-minute", "60.0", "ping", "proj/tasks.py:14"),
        ("report", "crontab(hour=7)", "report", "proj/tasks.py:15"),
    ]
    # Ключ выражением — подсказка; строка в комментарии, запись без schedule и файл в
    # tests/ расписаний не дали.
    assert hints == [("PREFIX + '-sync'", "proj/celery_app.py:12")]


def test_celery_wrapper_fixture() -> None:
    """Обёртка над add_periodic_task (ТЗ §15 п. 15 Л1): вызовы с аргументами по позициям и
    по именам дают расписания, расписание полем настроек — подсказку; вызов внутри самой
    обёртки расписанием не считается, прямой вызов рядом не задваивается."""
    rows, hints = _rows(celerybeat, FIXTURES / "celery-wrapper")
    assert rows == [
        ("expire unused datasets", "crontab(minute='37')", "cleanup", "app/celery.py:19"),
        ("ping every 30 seconds", "30.0", "ping", "app/celery.py:20"),
        ("hourly report", "timedelta(hours=1)", "report", "app/celery.py:21"),
        ("morning digest", "crontab(hour=6)", "digest", "app/celery.py:22"),
        ("direct ping", "60", "ping", "app/celery.py:25"),
    ]
    assert hints == [("settings.SYNC_SCHEDULE", "app/celery.py:23")]
    ctx, files = files_of(FIXTURES / "celery-wrapper")
    found = celerybeat.parse(files, ctx)
    assert found.hints[0].data["reason"] == texts.REASON_SCHEDULE_VARIABLE


def test_celery_wrapper_package(tmp_path: Path) -> None:
    """Вызов обёртки читается в файлах того же каталога и без слов beat_schedule и
    periodic_task; в другом каталоге и при двух определениях обёртки в пакете вызов
    расписанием не считается (глубина одна, одно определение)."""
    tree(tmp_path, {
        "requirements.txt": "celery\n",
        "pkg/util.py": "def every(sender, spec, job):\n    sender.add_periodic_task(spec, job)\n",
        "pkg/jobs.py": "def setup(sender):\n    every(sender, crontab(minute=5), report.s())\n",
        "other/jobs.py": "def setup(sender):\n    every(sender, crontab(minute=6), report.s())\n",
        "dup/a.py": "def every(sender, spec, job):\n    sender.add_periodic_task(spec, job)\n",
        "dup/b.py": "def every(sender, spec, job):\n    sender.add_periodic_task(spec, job)\n"
        "def setup(sender):\n    every(sender, crontab(minute=7), report.s())\n",
    })
    rows, hints = _rows(celerybeat, tmp_path)
    assert rows == [("report", "crontab(minute=5)", "report", "pkg/jobs.py:2")]
    assert hints == []


def test_celery_wrapper_cap(tmp_path: Path) -> None:
    """Обёрток за запуск не больше _MAX_WRAPPERS: вызовы остальных не читаются, а вызов
    add_periodic_task в их теле всё равно не расписание."""
    count = celerybeat._MAX_WRAPPERS + 5
    tree(tmp_path, {
        "requirements.txt": "celery\n",
        "pkg/util.py": "".join(
            f"def w{i:03}(s, spec, job):\n    s.add_periodic_task(spec, job)\n" for i in range(count)
        ),
        "pkg/jobs.py": "".join(f"w{i:03}(s, crontab(minute=5), report.s())\n" for i in range(count)),
    })
    rows, hints = _rows(celerybeat, tmp_path)
    assert len(rows) == celerybeat._MAX_WRAPPERS
    assert rows[-1][3] == f"pkg/jobs.py:{celerybeat._MAX_WRAPPERS}"
    assert hints == []


def test_go_cron_fixture() -> None:
    """robfig/cron (ТЗ §15 п. 15 Л2): литерал и константа файла раскрываются, выражение
    пишется текстом, у литеральной функции имя — место вызова; переменная без значения —
    подсказка, комментарий и файл _test.go не читаются."""
    rows, hints = _rows(gocron, FIXTURES / "go-cron")
    assert rows == [
        ("refresh", "@every 10m", "refresh", "main.go:16"),
        ("s.cleanup", "0 3 * * *", "s.cleanup", "main.go:17"),
        ("reportJob", "0 0 * * *", "reportJob", "main.go:19"),
        ("reportJob", "cron.Every(time.Hour)", "reportJob", "main.go:20"),
        ("main.go:21", 'fmt.Sprintf("@every %s", interval)', "main.go:21", "main.go:21"),
    ]
    assert hints == [("spec", "main.go:18")]
    ctx, files = files_of(FIXTURES / "go-cron")
    assert gocron.parse(files, ctx).hints[0].data["reason"] == texts.REASON_SCHEDULE_VARIABLE


def test_go_cron_needs_import(tmp_path: Path) -> None:
    """Файл без импорта robfig/cron не читается (AddFunc другой библиотеки), модуль без
    зависимости — тоже."""
    body = 'package x\nfunc f() {\n\tc.AddFunc("@daily", job)\n}\n'
    tree(tmp_path / "a", {
        "go.mod": "module a\n\nrequire github.com/robfig/cron/v3 v3.0.1\n", "x.go": body,
    })
    tree(tmp_path / "b", {
        "go.mod": "module b\n", "x.go": 'package x\nimport "github.com/robfig/cron/v3"\n' + body,
    })
    assert _rows(gocron, tmp_path / "a") == ([], [])
    ctx, files = files_of(tmp_path / "b")
    assert gocron.NAME not in gocron.parse(files, ctx).applied


def test_celery_beat_needs_celery(tmp_path: Path) -> None:
    tree(tmp_path, {
        "requirements.txt": "flask\n",
        "app.py": 'beat_schedule = {"a": {"task": "t", "schedule": 1}}\n',
    })
    ctx, files = files_of(tmp_path)
    found = celerybeat.parse(files, ctx)
    assert found.schedules == [] and found.applied == set()


def test_crontab_fixture() -> None:
    rows, hints = _rows(crontab, FIXTURES / "crontab")
    assert rows == [
        ("crontab-1", "0 2 * * *", "/usr/local/bin/backup.sh --full", "deploy/crontab:5"),
        ("crontab-2", "*/10 * * * *", "/usr/local/bin/rotate-logs", "deploy/crontab:6"),
        ("crontab-3", "@daily", "python -m app.cleanup", "deploy/crontab:7"),
        ("reports", "30 6 * * mon-fri", "/opt/app/bin/report weekday", "etc/cron.d/reports:2"),
        ("sync", "15 * * * *", "curl -fsS http://api:8080/sync", "jobs/sync.cron:1"),
    ]
    assert hints == []


@pytest.mark.parametrize(("line", "system", "want"), [
    ("0 2 * * /usr/local/bin/x arg", False, None),  # четыре поля: путь не поле
    ("MAILTO=root", False, None),
    ("# 0 2 * * * echo", False, None),
    ("0 2 * * *", False, None),  # без команды
    ("@reboot", False, None),
    ("@hourly root", True, None),  # только пользователь
    ("0 0 1 jan * echo year", False, ("0 0 1 jan *", "echo year")),
    ("0 0 * * * root", False, ("0 0 * * *", "root")),  # root без команды — это команда
    ("5 4 * * sun nobody /bin/x", True, ("5 4 * * sun", "/bin/x")),
    ("0 0 1 january * echo", False, None),  # имя месяца длиннее трёх букв
])
def test_crontab_lines(line: str, system: bool, want: tuple[str, str] | None) -> None:
    assert crontab._entry(line, system) == want


def _compose(beat: str) -> str:
    return (
        "services:\n  web:\n    build: ./app\n    command: gunicorn proj.wsgi\n"
        f"  beat:\n    build: ./app\n    command: {beat}\n"
    )


BEAT_APP = (
    "from celery import Celery\n"
    'app = Celery("proj")\n'
    'app.conf.beat_schedule = {"close-day": {"task": "proj.close", "schedule": 300}}\n'
)


def test_schedule_owner_prefers_scheduler(tmp_path: Path) -> None:
    tree(tmp_path, {
        "docker-compose.yml": _compose("celery -A proj beat"),
        "app/requirements.txt": "celery\n",
        "app/proj/celery_app.py": BEAT_APP,
        "app/crontab": "0 1 * * * python -m proj.vacuum\n",
        "ops/cron.d/backup": "0 3 * * * root /usr/local/bin/backup\n",
    })
    model = model_of(tmp_path)
    assert {k: [(s.name, s.parser) for s in v] for k, v in model.schedules.items()} == {
        "beat": [("crontab", "crontab"), ("close-day", "celery-beat")],
    }
    # Файл вне каталогов кода всех контейнеров — общий код.
    assert [(h["kind"], h["name"], h["reason"]) for h in model.hints["unassigned"]] == [
        ("schedule", "backup", texts.REASON_SHARED_LIB),
    ]


def test_schedule_many_owners(tmp_path: Path) -> None:
    tree(tmp_path, {
        "docker-compose.yml": _compose("celery -A proj worker"),
        "app/requirements.txt": "celery\n",
        "app/proj/celery_app.py": BEAT_APP,
    })
    model = model_of(tmp_path)
    assert model.schedules == {}
    assert [(h["name"], h["reason"]) for h in model.hints["unassigned"]] == [
        ("close-day", texts.REASON_MANY_OWNERS),
    ]


def test_schedules_coverage(tmp_path: Path) -> None:
    from archmap_scan.scan import Options, run

    tree(tmp_path / "beat", {
        "docker-compose.yml": _compose("celery -A proj beat"),
        "app/requirements.txt": "celery\n",
        "app/proj/celery_app.py": BEAT_APP,
    })
    result = run(Options(path=str(tmp_path / "beat"), out=str(tmp_path / "o1"), use_git=False))
    stat = result.coverage.families["schedules"]
    assert stat.status == "covered" and stat.found == 1
    assert stat.contributed == ["celery-beat"] and stat.from_code
    entry = (tmp_path / "o1" / "agent" / "entrypoints.yaml").read_text(encoding="utf-8")
    assert "name: close-day" in entry and "source: app/proj/celery_app.py:3" in entry
    # Планировщик в коде без разборщика назван стеком; crontab искал и не нашёл.
    tree(tmp_path / "cron", {
        "package.json": '{"dependencies": {"node-cron": "3"}}\n', "index.js": "x\n",
    })
    result = run(Options(path=str(tmp_path / "cron"), out=str(tmp_path / "o2"), use_git=False))
    stat = result.coverage.families["schedules"]
    assert stat.status == "unsupported" and stat.unsupported == ["node-cron"]
    assert stat.ran == ["k8s", "crontab"]


@pytest.mark.parametrize("kind", ["line", "lines", "system", "fields"])
def test_crontab_hostile(tmp_path: Path, kind: str) -> None:
    payload = {
        "line": "* " * 1_000_000,
        "lines": "1 2 3 4 5 /bin/x\n" * 120_000,
        "system": "1 2 3 4 5 /bin/x\n" * 120_000,
        "fields": ("*/" * 400 + " ") * 5 + "x\n" * 1,
    }[kind] * (2000 if kind == "fields" else 1)
    # Строки «пять полей и команда» в cron.d отвергаются после разбора всех полей (там
    # шестое слово — пользователь), а в файле .cron дают записи до предела.
    tree(tmp_path, {"jobs/big.cron" if kind == "lines" else "cron.d/job": payload})
    ctx, files = files_of(tmp_path)
    started = time.perf_counter()
    found = crontab.parse(files, ctx)
    assert time.perf_counter() - started < time_limit()
    if kind == "lines":
        # Сто двадцать тысяч записей — не crontab: файл непрочитан, записей нет.
        assert found.schedules == [] and files.too_large == {"jobs/big.cron"}
