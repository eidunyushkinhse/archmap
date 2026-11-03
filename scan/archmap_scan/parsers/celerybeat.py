"""Расписания Celery beat в коде Python (ТЗ §6.2): словари beat_schedule,
CELERYBEAT_SCHEDULE и CELERY_BEAT_SCHEDULE (присваиванием или в app.conf.update),
@periodic_task(run_every=…) и app.add_periodic_task(расписание, задача, name=…).
Имя — ключ словаря, имя функции или name=, а без него имя задачи; расписание — выражение
из кода без толкования («crontab(hour=0, minute=5)», «30.0»; кавычки и пробелы в нём
приводятся к виду ast.unparse); задача — строка task, имя функции или подписи задачи.
Ключ словаря не строкой уходит в hints.dynamic_names."""

from __future__ import annotations

import ast

from archmap_scan import codebase, pyast, pycode, texts
from archmap_scan.context import Context
from archmap_scan.model import CodeSchedule, Findings, Hint, Loc
from archmap_scan.walk import Files

NAME = "celery-beat"
WANTED = frozenset({"celery"})
_NEEDLES = ("beat_schedule", "BEAT_SCHEDULE", "CELERYBEAT_SCHEDULE", "periodic_task")
_SCHEDULES = frozenset({"beat_schedule", "celerybeat_schedule", "celery_beat_schedule"})


def _task(node: ast.AST) -> str:
    """Задача add_periodic_task: report.s() и report.si(1) → «report», signature("a.b") →
    «a.b», иное — выражение как в коде."""
    if isinstance(node, ast.Call):
        func = node.func
        if isinstance(func, ast.Attribute) and func.attr in ("s", "si", "signature"):
            name = pycode.dotted(func.value)
            if name:
                return name
        if pyast.last_name(node) in ("signature", "Signature"):
            name = pycode.string(pycode.arg(node, 0, "varies"))
            if name:
                return name
    return pycode.short(node)


def _dict(rel: str, value: ast.AST, found: Findings) -> None:
    if not isinstance(value, ast.Dict):
        return
    for key, item in zip(value.keys, value.values, strict=False):
        if key is None or not isinstance(item, ast.Dict):
            continue  # **другой_словарь и записи не словарём
        name = pycode.string(key)
        if name is None:
            found.hints.append(Hint("dynamic_names", {
                "kind": "schedule", "name": pycode.short(key),
                "reason": texts.REASON_DYNAMIC_SCHEDULE, "source": str(Loc(rel, key.lineno)),
            }))
            continue
        fields = {pycode.string(k): v for k, v in zip(item.keys, item.values, strict=False)}
        schedule = fields.get("schedule")
        if schedule is None:
            continue
        task = fields.get("task")
        found.schedules.append(CodeSchedule(
            name=name, schedule=pycode.short(schedule),
            task=pycode.string(task) or (pycode.short(task) if task is not None else None),
            loc=Loc(rel, key.lineno), parser=NAME,
        ))


def _scan(rel: str, tree: ast.Module, found: Findings) -> None:
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                target_name = (pycode.dotted(target) or "").rsplit(".", 1)[-1].lower()
                if target_name in _SCHEDULES:
                    _dict(rel, node.value, found)
        elif isinstance(node, ast.Call):
            last = pyast.last_name(node)
            if last == "update" and isinstance(node.func, ast.Attribute):
                for kw in node.keywords:
                    if kw.arg and kw.arg.lower() in _SCHEDULES:
                        _dict(rel, kw.value, found)
            elif last == "add_periodic_task" and len(node.args) >= 2:
                name = pycode.string(pycode.kwarg(node, "name"))
                task = _task(node.args[1])
                found.schedules.append(CodeSchedule(
                    name=name or task, schedule=pycode.short(node.args[0]), task=task,
                    loc=Loc(rel, node.lineno), parser=NAME,
                ))
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for dec in node.decorator_list:
                if isinstance(dec, ast.Call) and pyast.last_name(dec) == "periodic_task":
                    every = pycode.arg(dec, 0, "run_every")
                    if every is not None:
                        found.schedules.append(CodeSchedule(
                            name=node.name, schedule=pycode.short(every), task=node.name,
                            loc=Loc(rel, dec.lineno), parser=NAME,
                        ))


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not codebase.stack_present(files, ctx, codebase.PYTHON, WANTED):
        return found
    found.applied.add(NAME)
    for rel, text in codebase.sources(files, ctx, codebase.PYTHON, WANTED, _NEEDLES):
        tree = pyast.parse(text)
        if tree is not None:
            _scan(rel, tree, found)
    return found
