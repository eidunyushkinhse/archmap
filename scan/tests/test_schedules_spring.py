"""Расписания Spring @Scheduled в коде Java и Kotlin (ТЗ §15 п. 17 Л1): cron как написан,
fixedRate и fixedDelay формой «every N единица», подстановки и константы, @Schedules."""

from __future__ import annotations

from pathlib import Path

from archmap_scan import registry, stats, texts
from archmap_scan.parsers import springsched
from tests.helpers import FIXTURES, files_of, model_of, tree

ROOT = FIXTURES / "spring-scheduled"
JOBS = "jobs/src/main/java/shop/jobs/Jobs.java"
KT = "ktjobs/src/main/kotlin/shop/KtJobs.kt"
BOOT_POM = (
    "<project><artifactId>x</artifactId><dependencies><dependency>"
    "<artifactId>spring-boot-starter</artifactId></dependency></dependencies></project>\n"
)


def _parse(root: Path) -> tuple[list[tuple[str, str, str, str | None]], list[tuple[str, str, str]]]:
    ctx, files = files_of(root)
    found = springsched.parse(files, ctx)
    schedules = sorted((str(s.loc), s.name, s.schedule, s.task) for s in found.schedules)
    hints = sorted(
        (str(h.data["source"]), str(h.data["reason"]), str(h.data.get("schedule", "")))
        for h in found.hints
    )
    return schedules, hints


def test_fixture_schedules() -> None:
    """cron литералом и константой класса Java, fixedRate и fixedDelay числом (30_000L),
    timeUnit, fixedRateString и fixedDelayString с подстановкой (дефолт числом и
    длительностью), две записи @Schedules, cron константой Kotlin const val (с части 6, ТЗ §15
    п. 18 Е1); cron «-» (выключено), одноразовый initialDelay, комментарий и каталог тестов
    записей не дают."""
    schedules, _hints = _parse(ROOT)
    assert schedules == [
        (f"{JOBS}:10", "hourly", "0 0 * * * *", "hourly"),
        (f"{JOBS}:14", "ping", "every 5000 ms", "ping"),
        (f"{JOBS}:18", "cleanup", "every 30000 ms after completion", "cleanup"),
        (f"{JOBS}:22", "report", "every 10 min", "report"),
        (f"{JOBS}:26", "sync", "every 60000 ms", "sync"),
        (f"{JOBS}:34", "nightly", "0 0 3 * * *", "nightly"),
        (f"{JOBS}:43", "twice", "0 0 9 * * MON", "twice"),
        (f"{JOBS}:44", "twice", "0 0 9 * * FRI", "twice"),
        (f"{KT}:10", "delayed", "every PT10S after completion", "delayed"),
        (f"{KT}:14", "fromConst", "0 0 2 * * *", "fromConst"),
        (f"{KT}:18", "twoHours", "every 2 h", "twoHours"),
        (f"{KT}:6", "every5", "0 */5 * * * *", "every5"),
    ]


def test_fixture_hints() -> None:
    """Подстановка без дефолта и с дефолтом «-» — расписание из конфигурации с выражением;
    вызов — расписание задано переменной. Константа Kotlin до части 6 тоже давала подсказку,
    теперь раскрывается (ТЗ §15 п. 18 Е1)."""
    _schedules, hints = _parse(ROOT)
    assert hints == [
        (f"{JOBS}:30", texts.REASON_SCHEDULE_CONFIG, "${jobs.export.cron}"),
        (f"{JOBS}:38", texts.REASON_SCHEDULE_VARIABLE, "Settings.cron()"),
        (f"{JOBS}:53", texts.REASON_SCHEDULE_CONFIG, "${jobs.maybe:-}"),
    ]


def test_fixture_owner_and_coverage() -> None:
    """Расписания у контейнеров модулей; Java и Kotlin у пакетов со Spring Boot в
    непрочитанных расписаниях не названы."""
    model = model_of(ROOT)
    assert {k: len(v) for k, v in model.schedules.items()} == {"jobs": 8, "ktjobs": 4}
    ctx, files = files_of(ROOT)
    found, errors = registry.collect(files, ctx)
    assert errors == {}
    assert stats.code_unsupported(found).get("schedules", []) == []


def test_without_spring_boot(tmp_path: Path) -> None:
    """Пакет Java без Spring Boot не читается (аннотация чужая); Quartz у пакета со Spring
    Boot назван сам «Java: Quartz», и язык тогда отдельно не называется (правило А12)."""
    tree(tmp_path, {
        "a/pom.xml": "<project><artifactId>a</artifactId></project>\n",
        "a/src/main/java/A.java": 'class A { @Scheduled(cron = "0 0 * * * *") void a() {} }\n',
        "b/pom.xml": BOOT_POM.replace(
            "</dependencies>", "<dependency><artifactId>quartz</artifactId></dependency></dependencies>",
        ),
        "b/src/main/java/B.java": 'class B { @Scheduled(cron = "0 0 * * * *") void b() {} }\n',
    })
    schedules, _hints = _parse(tmp_path)
    assert schedules == [("b/src/main/java/B.java:1", "b", "0 0 * * * *", "b")]
    ctx, files = files_of(tmp_path)
    found, errors = registry.collect(files, ctx)
    assert errors == {}
    assert stats.code_unsupported(found).get("schedules", []) == ["Java: Quartz"]
    ctx, files = files_of(tmp_path / "a")
    alone, _errors = registry.collect(files, ctx)
    assert stats.code_unsupported(alone).get("schedules", []) == ["Java"]


def test_budget(tmp_path: Path) -> None:
    """Больше 2000 расписаний и подсказок в файле (враждебный вход): файл непрочитан."""
    many = "".join(f'  @Scheduled(cron = "0 0 * * * *")\n  void f{i}() {{}}\n' for i in range(2001))
    tree(tmp_path, {
        "a/pom.xml": BOOT_POM,
        "a/src/main/java/A.java": "class A {\n" + many + "}\n",
        "a/src/main/java/B.java": 'class B { @Scheduled(fixedRate = 1) void b() {} }\n',
    })
    ctx, files = files_of(tmp_path)
    found = springsched.parse(files, ctx)
    assert [s.name for s in found.schedules] == ["b"]
    assert "a/src/main/java/A.java" in files.too_large
