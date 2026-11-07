"""Помощники разборщиков кода Python (ТЗ §6.2): имена вызовов с учётом импортов, строковые
литералы, короткий текст выражения для подсказок. Только чтение дерева ast: код
репозитория не выполняется и не импортируется (инвариант 1)."""

from __future__ import annotations

import ast
from dataclasses import dataclass

from archmap_scan import texts

# Длина текста выражения в подсказке о динамическом имени.
_SHORT = 80


@dataclass(frozen=True)
class Imported:
    """Откуда пришло имя модуля: «import m» (attr None) или «from m import attr»."""

    module: str
    attr: str | None = None
    level: int = 0  # точки относительного импорта

    @property
    def target(self) -> str:
        """Полное имя: «os.getenv», «orders.api.routes.router»."""
        if not self.attr:
            return "." * self.level + self.module
        base = f"{self.module}.{self.attr}" if self.module else self.attr
        return "." * self.level + base


def imports(tree: ast.Module) -> dict[str, Imported]:
    """Имя в модуле → откуда оно импортировано (импорты в функциях тоже)."""
    out: dict[str, Imported] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.asname:
                    out[alias.asname] = Imported(alias.name)
                else:
                    head = alias.name.split(".", 1)[0]
                    out.setdefault(head, Imported(head))
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name != "*":
                    out[alias.asname or alias.name] = Imported(
                        node.module or "", alias.name, node.level or 0,
                    )
    return out


def imports_any(imps: dict[str, Imported], prefixes: tuple[str, ...]) -> bool:
    """Модуль импортирует что-то из пакетов prefixes («kafka», «confluent_kafka»)."""
    for imp in imps.values():
        if imp.level:
            continue
        root = imp.module.split(".", 1)[0]
        if root in prefixes:
            return True
    return False


def dotted(node: ast.AST | None) -> str | None:
    """«a.b.c» для цепочки имён и атрибутов, иначе None."""
    parts: list[str] = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    return None


def qualname(node: ast.AST | None, imps: dict[str, Imported]) -> str | None:
    """Полное имя вызываемого с учётом импортов: getenv → os.getenv, environ.get →
    os.environ.get, decouple.config → decouple.config."""
    name = dotted(node)
    if name is None:
        return None
    head, _, rest = name.partition(".")
    imp = imps.get(head)
    if imp is None:
        return name
    return imp.target + ("." + rest if rest else "")


def string(node: ast.AST | None) -> str | None:
    """Значение строкового литерала или None."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def joined(node: ast.AST | None) -> bool:
    """Склейка строк «"a" + b» (и «"/a" + "/b"»): имя собрано из частей, ТЗ §15 п. 10 А."""
    return isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add)


def dynamic_reason(node: ast.AST | None, dynamic: str) -> str:
    """Причина подсказки о динамическом имени: склейка или иное выражение."""
    return texts.REASON_JOINED_NAME if joined(node) else dynamic


def strings(node: ast.AST | None) -> list[str] | None:
    """Строка или список/кортеж строк литералами; None — что-то не литерал."""
    one = string(node)
    if one is not None:
        return [one]
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        out = [string(e) for e in node.elts]
        if all(s is not None for s in out):
            return [s for s in out if s is not None]
    return None


def text_of(value: object) -> str | None:
    """Литерал дефолта как текст: True → «true», 4 → «4»; None и прочее — None."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return value
    return None


def literal_default(node: ast.AST | None) -> tuple[bool, str | None]:
    """(дефолт есть, его текст). Нет выражения или «...» (обязательное поле pydantic):
    дефолта нет. None и нелитерал: дефолт есть, но текста у него нет."""
    if node is None:
        return False, None
    if isinstance(node, ast.Constant):
        if node.value is Ellipsis:
            return False, None
        return True, text_of(node.value)
    return True, None


def arg(call: ast.Call, index: int, name: str | None = None) -> ast.expr | None:
    """Аргумент вызова по позиции или имени."""
    if index < len(call.args) and not isinstance(call.args[index], ast.Starred):
        return call.args[index]
    if name is not None:
        for kw in call.keywords:
            if kw.arg == name:
                return kw.value
    return None


def kwarg(call: ast.Call, name: str) -> ast.expr | None:
    for kw in call.keywords:
        if kw.arg == name:
            return kw.value
    return None


def short(node: ast.AST) -> str:
    """Короткий текст выражения для подсказки: одна строка, не длиннее _SHORT (хвост
    отрезается; место в коде всё равно названо основанием)."""
    try:
        text = ast.unparse(node)
    except (ValueError, RecursionError):  # дерево из чужого кода: на всякий случай
        return "?"
    text = " ".join(text.split())
    return text[:_SHORT]
