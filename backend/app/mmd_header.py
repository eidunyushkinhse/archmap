"""Шапка .mmd-файла: метаданные схемы логики внутри самой диаграммы.

Пакет «Доки от агента» переезжает с YAML-манифеста на набор самодостаточных
.mmd-файлов (docs/plan-docs-mmd.md). Всё, что раньше несла запись манифеста —
имя схемы, вид, привязка к операции, адрес узла, — теперь едет ВНУТРИ файла
ведущими строками-комментариями::

    %% archmap-name: Приём заказа
    %% archmap-kind: operation
    %% archmap-operation: POST /orders
    graph TD
      A["Приём запроса"] --> B["Валидация корзины"]

Почему внутри, а не в имени файла: так метаданные едут вместе с содержимым, и
вставка текста из буфера работает наравне с перетаскиванием файла. Mermaid
строки на «%%» игнорирует, поэтому файл остаётся валидной диаграммой и
рендерится где угодно.

Все поля НЕОБЯЗАТЕЛЬНЫ: слабая модель шапку забудет, и это не должно ломать
импорт. Чем заменять пропуски (имя файла, вид «обзор», узел окна) — решает
вызывающий, здесь только разбор.
"""

from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field

# Порядок полей в примере для промпта; он же — порядок вывода render_header.
KEYS = ("name", "kind", "operation", "node")
# Виды схем логики (NodeDoc.kind). Латиницей — как в остальном контракте агента.
KINDS = ("overview", "operation", "worker")

_PREFIX = "archmap-"


@dataclass
class MmdHeader:
    """Разобранная шапка. Ничего не подставляет: пропуск — это None."""

    name: str | None = None
    kind: str | None = None
    operation: str | None = None
    node: str | None = None
    # Строки «%% archmap-…», которые понять не удалось: опечатка в ключе, пустое
    # значение, неизвестный вид. Вызывающий показывает их пользователем — иначе
    # схема тихо приедет не с тем именем, и виноватой будет выглядеть ArchMap.
    problems: list[str] = field(default_factory=list)

    @property
    def is_empty(self) -> bool:
        """Шапки не было вовсе (не путать с шапкой, которую не разобрали)."""
        return not any((self.name, self.kind, self.operation, self.node)) and not self.problems


def _leading_comments(text: str) -> Iterator[str]:
    """Комментарии ДО первой строки диаграммы, без ведущих «%%».

    Читаем только начало файла: комментарий посреди диаграммы — часть схемы, а не
    её паспорт. Пустые строки и чужие комментарии пропускаем, но сканирование не
    прерываем: «%%{init: …}%%» — это ДИРЕКТИВА mermaid, она законно стоит перед
    диаграммой и не должна прятать шапку, идущую следом.
    """
    lines = text.lstrip("﻿").splitlines()
    i = 0
    # Frontmatter mermaid («--- title: … ---») тоже пропускаем: он допустим в
    # начале файла, и шапка может идти после него.
    if i < len(lines) and lines[i].strip() == "---":
        i += 1
        while i < len(lines) and lines[i].strip() != "---":
            i += 1
        i += 1
    for line in lines[i:]:
        stripped = line.strip()
        if not stripped:
            continue
        if not stripped.startswith("%%"):
            return  # началась диаграмма
        yield stripped[2:].strip()


def parse_mmd_header(text: str) -> MmdHeader:
    """Разобрать ведущие «%% archmap-*» строки. Чистая функция, ошибок не кидает."""
    header = MmdHeader()
    for comment in _leading_comments(text):
        if not comment.lower().startswith(_PREFIX):
            continue  # чужой комментарий или директива — не наше дело
        body = comment[len(_PREFIX) :]
        key, sep, value = body.partition(":")
        key = key.strip().lower()
        # Значение режем по ПЕРВОМУ двоеточию: и в имени схемы («Крон: выставление
        # счетов»), и в операции («POST /orders») двоеточия законны.
        value = value.strip()
        if not sep or not value:
            header.problems.append(f"строка «%% {comment}» — не понял, что после «{key or '?'}»")
            continue
        if key not in KEYS:
            header.problems.append(f"неизвестное поле «{key}» в строке «%% {comment}»")
            continue
        if key == "kind" and value.lower() not in KINDS:
            header.problems.append(
                f"неизвестный вид схемы «{value}» — бывают: {', '.join(KINDS)}"
            )
            continue
        setattr(header, key, value.lower() if key == "kind" else value)
    return header


def render_header(fields: Mapping[str, str]) -> str:
    """Собрать шапку из полей (порядок KEYS). Используется примером для промпта."""
    return "".join(f"%% {_PREFIX}{k}: {fields[k]}\n" for k in KEYS if fields.get(k))


# ── Встроенный пример (данные, не текст) ─────────────────────────────────────
# Тот же приём, что держал пример манифеста в docs_prompt: пример хранится
# данными, дампается в текст и ПАРСИТСЯ ОБРАТНО тестом. Поэтому промпт физически
# не может разойтись с парсером — а разъезд здесь означал бы, что агент пишет
# шапку, которую мы молча не читаем.
_EXAMPLE_FIELDS = {
    "name": "Приём заказа",
    "kind": "operation",
    "operation": "POST /orders",
}
_EXAMPLE_BODY = (
    "graph TD\n"
    '  A["Приём запроса"] --> B["Валидация корзины"]\n'
    '  B --> C{"Товары в наличии?"}\n'
    '  C -- да --> D["Создать заказ в orders-db"]\n'
    '  C -- нет --> E["409: конфликт наличия"]\n'
)


def example_mmd() -> str:
    """Образец файла для промпта: шапка + диаграмма."""
    return render_header(_EXAMPLE_FIELDS) + _EXAMPLE_BODY
