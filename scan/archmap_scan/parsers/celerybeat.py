"""Расписания Celery beat в коде Python (ТЗ §6.2): словари beat_schedule,
CELERYBEAT_SCHEDULE и CELERY_BEAT_SCHEDULE (присваиванием или в app.conf.update),
@periodic_task(run_every=…) и app.add_periodic_task(расписание, задача, name=…).
Имя — ключ словаря, имя функции или name=, а без него имя задачи; расписание — выражение
из кода без толкования («crontab(hour=0, minute=5)», «30.0»; кавычки и пробелы в нём
приводятся к виду ast.unparse); задача — строка task, имя функции или подписи задачи.
Ключ словаря не строкой уходит в hints.dynamic_names.

Обёртка над add_periodic_task (ТЗ §15 п. 15 Л1: add_periodic_task_with_expiry у PostHog):
функция уровня модуля, в теле которой add_periodic_task получает её параметр на месте
расписания (и, если есть, на месте задачи и name=). Сам этот вызов внутри обёртки
расписанием не считается. Вызов обёртки в файлах того же пакета (каталога) с параметрами
по позициям и по именам даёт расписание: литерал (crontab(…), timedelta(…), число) как
написан, задача по аргументу на месте подписи, имя из name= или имя задачи; расписание
переменной или полем настроек (settings.X) — подсказка с именем переменной. Обёртка с
одним определением в пакете, глубина одна: обёртка обёртки не ищется; обёрток за запуск не
больше 100 (первые по порядку файлов), вызов add_periodic_task в теле остальных расписанием
тоже не считается."""

from __future__ import annotations

import ast
from dataclasses import dataclass

from archmap_scan import codebase, paths, pyast, pycode, texts
from archmap_scan.context import Context
from archmap_scan.model import CodeSchedule, Findings, Hint, Loc
from archmap_scan.walk import Files

NAME = "celery-beat"
WANTED = frozenset({"celery"})
_NEEDLES = ("beat_schedule", "BEAT_SCHEDULE", "CELERYBEAT_SCHEDULE", "periodic_task")
_SCHEDULES = frozenset({"beat_schedule", "celerybeat_schedule", "celery_beat_schedule"})
# Обёрток за запуск не больше _MAX_WRAPPERS: имя каждой — строка поиска по всем файлам
# Python пакета, и тысячи определений во враждебном файле дали бы тысячи проходов.
_MAX_WRAPPERS = 100


@dataclass(frozen=True)
class _Wrapper:
    """Обёртка над add_periodic_task: позиционные параметры по порядку и имена
    параметров на месте расписания, задачи и name= (None — там не параметр)."""

    name: str
    params: tuple[str, ...]
    schedule: str
    task: str | None
    label: str | None
    inner: int  # id вызова add_periodic_task в теле: расписанием не считается


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


def _wrapper(stmt: ast.FunctionDef | ast.AsyncFunctionDef) -> _Wrapper | None:
    """Обёртка, если в теле функции add_periodic_task получает параметр на месте расписания."""
    args = stmt.args
    positional = tuple(a.arg for a in (*args.posonlyargs, *args.args))
    names = {*positional, *(a.arg for a in args.kwonlyargs)}

    def param(node: ast.AST | None) -> str | None:
        return node.id if isinstance(node, ast.Name) and node.id in names else None

    for node in ast.walk(stmt):
        if isinstance(node, ast.Call) and pyast.last_name(node) == "add_periodic_task":
            schedule = param(pycode.arg(node, 0, "schedule"))
            if schedule is not None:
                return _Wrapper(
                    stmt.name, positional, schedule, param(pycode.arg(node, 1, "sig")),
                    param(pycode.kwarg(node, "name")), id(node),
                )
    return None


def _wrappers(tree: ast.Module) -> list[_Wrapper]:
    return [
        w for stmt in tree.body
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef))
        and (w := _wrapper(stmt)) is not None
    ]


def _wrapper_call(rel: str, wrapper: _Wrapper, call: ast.Call, found: Findings) -> None:
    """Вызов обёртки: аргументы по позициям и по именам на места её параметров."""
    bound: dict[str, ast.expr] = {}
    for i, value in enumerate(call.args):
        if isinstance(value, ast.Starred) or i >= len(wrapper.params):
            break
        bound[wrapper.params[i]] = value
    for kw in call.keywords:
        if kw.arg:
            bound[kw.arg] = kw.value
    schedule = bound.get(wrapper.schedule)
    if schedule is None:
        return
    sig = bound.get(wrapper.task) if wrapper.task else None
    task = _task(sig) if sig is not None else None
    label = pycode.string(bound.get(wrapper.label)) if wrapper.label else None
    if isinstance(schedule, (ast.Name, ast.Attribute)):
        found.hints.append(Hint("dynamic_names", {
            "kind": "schedule", "name": pycode.short(schedule),
            "reason": texts.REASON_SCHEDULE_VARIABLE, "source": str(Loc(rel, call.lineno)),
        }))
        return
    name = label or task
    if name is None:
        return
    found.schedules.append(CodeSchedule(
        name=name, schedule=pycode.short(schedule), task=task, loc=Loc(rel, call.lineno),
        parser=NAME,
    ))


def _scan(
    rel: str, tree: ast.Module, found: Findings,
    wrappers: dict[str, _Wrapper] | None = None, inner: frozenset[int] = frozenset(),
) -> None:
    wrappers = wrappers or {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and id(node) in inner:
            continue  # add_periodic_task в теле обёртки: расписание у вызовов обёртки
        if isinstance(node, ast.Call) and wrappers:
            wrapper = wrappers.get(pyast.last_name(node) or "")
            if wrapper is not None:
                _wrapper_call(rel, wrapper, node, found)
                continue
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
    trees: dict[str, ast.Module] = {}
    # Обёртки по каталогу пакета: имя → обёртка; None — определений больше одного.
    by_dir: dict[str, dict[str, _Wrapper | None]] = {}
    inner: set[int] = set()
    taken = 0
    for rel, text in codebase.sources(files, ctx, codebase.PYTHON, WANTED, _NEEDLES):
        tree = pyast.parse(text)
        if tree is None:
            continue
        trees[rel] = tree
        for w in _wrappers(tree):
            inner.add(w.inner)
            own = by_dir.setdefault(paths.parent(rel), {})
            if w.name in own:
                own[w.name] = None
            elif taken < _MAX_WRAPPERS:
                own[w.name] = w
                taken += 1
    skip = frozenset(inner)
    names = sorted({name for own in by_dir.values() for name in own})
    if names:
        # Вызовы обёрток в файлах того же пакета без слов beat_schedule и periodic_task.
        needles = tuple(f"{name}(" for name in names)
        for rel, text in codebase.sources(files, ctx, codebase.PYTHON, WANTED, needles):
            if rel not in trees and paths.parent(rel) in by_dir:
                tree = pyast.parse(text)
                if tree is not None:
                    trees[rel] = tree
    for rel, tree in trees.items():
        own = by_dir.get(paths.parent(rel), {})
        wrappers = {name: w for name, w in own.items() if w is not None}
        _scan(rel, tree, found, wrappers, skip)
    return found
