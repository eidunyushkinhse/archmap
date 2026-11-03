"""Чтение YAML чужого репозитория: только безопасный загрузчик, номера строк, пределы.

Отображения и списки приходят с номерами строк ключей и элементов (LineDict, LineList):
из них строятся основания «файл:строка». Пределы защищают от враждебного входа (ТЗ §9):
размер документа, число ссылок-псевдонимов и объём, добавленный ключами слияния «<<»
(«бомба» из вложенных слияний растёт экспоненциально). Используется чистая Python-часть
PyYAML, как в собранном файле, поэтому поведение у разработчика и у пользователя одно.
"""

from __future__ import annotations

from typing import Any

import yaml

# Предел размера YAML для разбора: чистый Python-разборщик проходит около 200 КБ в
# секунду на плотном входе, а манифесты развёртывания много меньше этого предела.
MAX_YAML_BYTES = 256 * 1024
MAX_ALIASES = 1000
MAX_MERGED = 100_000
# Вложенность [ и { в стиле потока: разборщик PyYAML тратит на неё квадратичное время, а в
# манифестах глубже нескольких уровней она не встречается.
MAX_FLOW_DEPTH = 64


class YamlTooLarge(Exception):
    """Документ больше предела разбора."""


class BadYaml(Exception):
    """Документ не разбирается или превышает пределы ссылок и слияний."""


class LineDict(dict[Any, Any]):
    """Отображение YAML с номерами строк: line — строка начала, key_lines — строки ключей."""

    line: int = 0

    def __init__(self) -> None:
        super().__init__()
        self.key_lines: dict[Any, int] = {}

    def line_of(self, key: Any) -> int:
        return self.key_lines.get(key, self.line)


class LineList(list[Any]):
    """Список YAML с номерами строк элементов."""

    line: int = 0

    def __init__(self) -> None:
        super().__init__()
        self.item_lines: list[int] = []

    def line_at(self, index: int) -> int:
        return self.item_lines[index] if 0 <= index < len(self.item_lines) else self.line


class _Limited(Exception):
    pass


class _Loader(yaml.SafeLoader):  # type: ignore[misc]
    def __init__(self, stream: str) -> None:
        super().__init__(stream)
        self._aliases = 0
        self._merged = 0

    def compose_node(self, parent: Any, index: Any) -> Any:
        if self.check_event(yaml.AliasEvent):
            self._aliases += 1
            if self._aliases > MAX_ALIASES:
                raise _Limited
        return super().compose_node(parent, index)

    def flatten_mapping(self, node: Any) -> None:
        before = len(node.value)
        super().flatten_mapping(node)
        self._merged += max(len(node.value) - before, 0)
        if self._merged > MAX_MERGED:
            raise _Limited


def _construct_map(loader: _Loader, node: Any) -> Any:
    data = LineDict()
    data.line = node.start_mark.line + 1
    yield data
    loader.flatten_mapping(node)
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=False)
        try:
            hash(key)
        except TypeError as exc:
            raise yaml.constructor.ConstructorError(
                None, None, "unhashable key", key_node.start_mark
            ) from exc
        data[key] = loader.construct_object(value_node, deep=False)
        data.key_lines[key] = key_node.start_mark.line + 1


def _construct_seq(loader: _Loader, node: Any) -> Any:
    data = LineList()
    data.line = node.start_mark.line + 1
    yield data
    for child in node.value:
        data.append(loader.construct_object(child, deep=False))
        data.item_lines.append(child.start_mark.line + 1)


_Loader.add_constructor("tag:yaml.org,2002:map", _construct_map)
_Loader.add_constructor("tag:yaml.org,2002:seq", _construct_seq)


def _flow_too_deep(text: str) -> bool:
    """Грубая проверка вложенности скобок потока вне кавычек (линейный проход)."""
    depth = 0
    quote = ""
    for ch in text:
        if ch == "\n" and depth == 0:
            # Апостроф в простом значении («it's») не открывает строку на весь файл.
            quote = ""
        elif quote:
            if ch == quote:
                quote = ""
        elif ch in "\"'":
            quote = ch
        elif ch in "[{":
            depth += 1
            if depth > MAX_FLOW_DEPTH:
                return True
        elif ch in "]}" and depth:
            depth -= 1
    return False


def load_all(text: str) -> list[Any]:
    """Все документы YAML. YamlTooLarge — больше предела, BadYaml — не разобрался."""
    if len(text.encode("utf-8", "replace")) > MAX_YAML_BYTES:
        raise YamlTooLarge
    if _flow_too_deep(text):
        raise BadYaml
    try:
        return list(yaml.load_all(text, Loader=_Loader))
    except (yaml.YAMLError, _Limited, RecursionError, ValueError, TypeError) as exc:
        raise BadYaml from exc


def load(text: str) -> Any:
    """Первый документ YAML (или None для пустого)."""
    docs = load_all(text)
    return docs[0] if docs else None
