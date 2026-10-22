"""Нормализация текстов для сравнения и вывода — общая для импорта, синка и процессов.

Эти функции жили дословными копиями в нескольких модулях (аудит Q-21): правка одной копии
молча разводила правила сравнения имён между, например, импортом и синком.
"""

import re

_SEPARATORS = str.maketrans("", "", "_-. ")
_WS = re.compile(r"\s+")


def identity_name(name: str) -> str:
    """Имя для сравнения идентичности: без регистра, пробелы схлопнуты
    («Сервис  Оплаты» и «сервис оплаты» — одно имя)."""
    return " ".join(name.split()).casefold()


def loose_name(s: str) -> str:
    """Имя без регистра и разделителей «_-. » — «то же имя, записанное иначе»
    (подсказки «вы имели в виду»)."""
    return s.lower().translate(_SEPARATORS)


def sequence_text(text: str | None) -> str:
    """Текст для строки sequence-диаграммы: одна строка, «;» → «,» (mermaid режет
    сообщение по «;»)."""
    if not text:
        return ""
    return _WS.sub(" ", text).replace(";", ",").strip()


def plural_word(n: int, one: str, few: str, many: str) -> str:
    """Счётное слово по-русски для числа n: «параметр», «параметра», «параметров».
    (Приватные копии того же правила живут в unified_import и docs_prompt.)"""
    n10, n100 = n % 10, n % 100
    if n10 == 1 and n100 != 11:
        return one
    if 2 <= n10 <= 4 and not 12 <= n100 <= 14:
        return few
    return many


def plural(n: int, one: str, few: str, many: str) -> str:
    """Число со счётным словом: «1 параметр», «3 параметра», «11 параметров»."""
    return f"{n} {plural_word(n, one, few, many)}"
