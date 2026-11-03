"""Чтение Python через ast для миграций Alembic и Django: только литералы, ничего не
выполняется и не импортируется (инвариант 1)."""

from __future__ import annotations

import ast
from typing import Any

# Сколько исходника допустимо для ast.parse: миграции короче, а разбор враждебного файла
# (глубокая вложенность) не должен ронять процесс.
MAX_SOURCE = 2 * 1024 * 1024


class _NotLiteral(Exception):
    pass


def parse(text: str) -> ast.Module | None:
    """Модуль или None, если файл не разбирается (синтаксис, глубина, размер)."""
    if len(text) > MAX_SOURCE:
        return None
    try:
        return ast.parse(text)
    except (SyntaxError, ValueError, RecursionError, MemoryError):
        return None


def literal(node: ast.AST | None) -> Any:
    """Значение литерала (строка, число, bool, None, кортеж и список литералов) или
    исключение _NotLiteral, обёрнутое в None-результат через is_literal."""
    if node is None:
        raise _NotLiteral
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, (ast.Tuple, ast.List)):
        return [literal(e) for e in node.elts]
    raise _NotLiteral


def value(node: ast.AST | None, default: Any = None) -> Any:
    """Значение литерала или default, если это не литерал."""
    try:
        return literal(node)
    except _NotLiteral:
        return default


def kwargs(call: ast.Call) -> dict[str, ast.expr]:
    return {kw.arg: kw.value for kw in call.keywords if kw.arg}


def last_name(node: ast.AST) -> str | None:
    """Последнее имя вызываемого: sa.Column → Column, models.CharField → CharField."""
    target = node.func if isinstance(node, ast.Call) else node
    if isinstance(target, ast.Attribute):
        return target.attr
    if isinstance(target, ast.Name):
        return target.id
    return None


def module_assign(tree: ast.Module, name: str) -> ast.expr | None:
    """Правая часть присваивания имени на уровне модуля (в том числе с аннотацией)."""
    for stmt in tree.body:
        if isinstance(stmt, ast.Assign):
            for target in stmt.targets:
                if isinstance(target, ast.Name) and target.id == name:
                    return stmt.value
        elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
            if stmt.target.id == name:
                return stmt.value
    return None

