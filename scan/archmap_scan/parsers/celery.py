"""Очереди Celery в коде Python (ТЗ §6.2): @app.task(queue="q"), @shared_task(queue=) и
обёртки проекта над ними (декоратор, имя которого кончается на task),
task_routes (значение {"queue": "q"} или строка), kombu Queue("q"), task_default_queue и
CELERY_DEFAULT_QUEUE — объявления очередей; apply_async(queue=) и send_task(…, queue=) —
публикация. Адрес брокера литералом в том же файле (Celery(broker=…), broker_url) помогает
найти брокер-владелец. Очереди из «-Q» в командах воркеров собирает сборка из
entrypoints (codefacts.py). Имя очереди не строкой уходит в hints.dynamic_names.
"""

from __future__ import annotations

import ast

from archmap_scan import codebase, pyast, pycode, texts
from archmap_scan.context import Context
from archmap_scan.links import hosts_in
from archmap_scan.model import ChannelUse, Findings, Hint, Loc
from archmap_scan.walk import Files

NAME = "celery"
CLIENT = "Celery"
WANTED = frozenset({"celery"})
_NEEDLES = (
    "queue=", "task_routes", "Queue(", "default_queue", "DEFAULT_QUEUE", "CELERY_ROUTES",
    "TASK_ROUTES",
)
_PUBLISH = frozenset({"apply_async", "send_task"})
_ROUTES = frozenset({"task_routes", "celery_routes", "celery_task_routes"})
_DEFAULT_QUEUE = frozenset({
    "task_default_queue", "celery_default_queue", "celery_task_default_queue",
})
_BROKER = frozenset({"broker_url", "celery_broker_url", "broker"})


class _File:
    def __init__(self, rel: str, tree: ast.Module, found: Findings) -> None:
        self.rel = rel
        self.tree = tree
        self.found = found
        self.imps = pycode.imports(tree)
        self.uses: list[ChannelUse] = []
        self.host: str | None = None

    def queue(self, node: ast.AST | None, at: ast.AST, direction: str | None) -> None:
        if node is None:
            return
        name = pycode.string(node)
        if name is None:
            self.found.hints.append(Hint("dynamic_names", {
                "kind": "channel", "name": pycode.short(node),
                "reason": texts.REASON_DYNAMIC_CHANNEL,
                "source": str(Loc(self.rel, getattr(at, "lineno", 1))),
            }))
            return
        if name:
            self.uses.append(ChannelUse(
                name=name, kind="queue", client=CLIENT, direction=direction,
                loc=Loc(self.rel, getattr(at, "lineno", 1)), parser=NAME,
            ))

    def broker(self, node: ast.AST | None) -> None:
        value = pycode.string(node)
        if value and self.host is None:
            hosts = hosts_in("CELERY_BROKER_URL", value)
            if hosts:
                self.host = hosts[0][0]


def _routes(f: _File, value: ast.AST, at: ast.AST) -> None:
    """task_routes: {"задача": {"queue": "q"}} или {"задача": "q"}."""
    if not isinstance(value, ast.Dict):
        return
    for item in value.values:
        if isinstance(item, ast.Dict):
            for key, sub in zip(item.keys, item.values, strict=False):
                if pycode.string(key) == "queue":
                    f.queue(sub, at, None)
        elif item is not None:
            f.queue(item, at, None)


def _assign(f: _File, target: ast.AST, value: ast.AST, at: ast.AST) -> None:
    name = (pycode.dotted(target) or "").rsplit(".", 1)[-1].lower()
    if name in _ROUTES:
        _routes(f, value, at)
    elif name in _DEFAULT_QUEUE:
        f.queue(value, at, None)
    elif name in _BROKER:
        f.broker(value)


def _scan(f: _File) -> None:
    for node in ast.walk(f.tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for dec in node.decorator_list:
                # @app.task, @shared_task и обёртки проекта над ними (@instrumented_task):
                # декоратор, имя которого кончается на task.
                if isinstance(dec, ast.Call) and (pyast.last_name(dec) or "").endswith("task"):
                    f.queue(pycode.kwarg(dec, "queue"), dec, None)
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                _assign(f, target, node.value, node)
        elif isinstance(node, ast.Call):
            last = pyast.last_name(node)
            if last in _PUBLISH:
                f.queue(pycode.kwarg(node, "queue"), node, "publish")
            elif last == "Queue":
                qual = pycode.qualname(node.func, f.imps) or ""
                if qual.startswith("kombu"):
                    f.queue(pycode.arg(node, 0, "name"), node, None)
            elif last == "Celery":
                f.broker(pycode.kwarg(node, "broker"))
            elif last == "update" and isinstance(node.func, ast.Attribute):
                for kw in node.keywords:
                    if kw.arg:
                        _assign(f, ast.Name(id=kw.arg), kw.value, node)
    for use in f.uses:
        use.broker_host = f.host
    f.found.channels.extend(f.uses)


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not codebase.stack_present(files, ctx, codebase.PYTHON, WANTED):
        return found
    found.applied.add(NAME)
    for rel, text in codebase.sources(files, ctx, codebase.PYTHON, WANTED, _NEEDLES):
        tree = pyast.parse(text)
        if tree is not None:
            _scan(_File(rel, tree, found))
    return found
