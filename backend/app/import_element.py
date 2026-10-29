"""Элемент архитектуры во ввозе: санитизация разобранного дерева (docs/plan-c4-elements.md,
Р5, Р6, Р29).

Правка узла через API отказывает в недопустимом элементе (app/element_rules, 422), а ввоз
файлом из-за этого не отвергается: агент мог ошибиться в одном узле, и терять из-за этого
весь документ — хуже, чем снять одно значение с замечанием. Инвариант хранимых данных тот
же, что держит API: элемент задаётся только у сервиса; внутри контейнера нет ни базы, ни
брокера, ни другого контейнера, а у компонентов элемента нет вовсе.

Одна функция на все ввозы: разбор одного файла (parse_import), слияние нескольких
(_Merger.finish — по слитому дереву, где база и контейнер могли прийти из разных файлов) и
применение ответов на вопросы (выбранный «Контейнер» мог стать недопустимым). Правила
идут по порядку, обход — «родители раньше детей» (так строит дерево и разбор, и слияние):
1. элемент у не-сервиса снимается — значение пропущено;
2. у контейнера, внутри которого база или брокер, значение снимается — узел читается
   системой; виновник — первый в обходе в глубину с детьми по имени, тот же, что
   назвал бы отказ API (Elements над теми же записями ElementRow);
3. у потомков действующего контейнера заданный элемент снимается — они его компоненты.
   Так разрешается и «контейнер внутри контейнера»: внутренний становится составным
   компонентом, наружный остаётся контейнером.
У листа-сервиса значение — намерение (Р3) и не замечание.

Тексты замечаний не содержат маркеров классов остатка (app/unified_remarks,
_REMARK_CLASSES и _REMARK_TAILS узнают класс подстрокой): строка без маркера едет в
свёртку «Придется подправить вручную» как есть.
"""

import uuid
from collections.abc import Sequence
from typing import Protocol

from app.domain_types import NodeElement
from app.element import CONTAINER
from app.element_marks import ElementRow, build_elements

ONLY_SERVICE_NOTE = "{path}: элемент архитектуры задаётся только у сервиса — значение пропущено"
# Текст владельца (раздел 0а плана) с родом формы — как у отказа API (STORE_INSIDE).
STORE_INSIDE_NOTE = {
    "database": (
        "{path}: внутри лежит база данных «{name}», она не может входить в состав "
        "контейнера — объект оставлен системой"
    ),
    "broker": (
        "{path}: внутри лежит брокер «{name}», он не может входить в состав "
        "контейнера — объект оставлен системой"
    ),
}
COMPONENT_NOTE = (
    "{path}: объект лежит внутри контейнера «{container}» и считается его компонентом — "
    "элемент архитектуры пропущен"
)


class ElementNode(Protocol):
    """Узел разобранного дерева, как его видит санитизация (_ImpNode ввоза)."""

    @property
    def name(self) -> str: ...

    @property
    def shape(self) -> str: ...

    @property
    def parent_idx(self) -> int | None: ...

    element: NodeElement | None


def _key(idx: int) -> uuid.UUID:
    """Индекс узла документа как ключ записи ElementRow. Порядок строк таких ключей —
    порядок индексов (нули слева), поэтому тёзки идут в порядке документа."""
    return uuid.UUID(int=idx)


def _rows(nodes: Sequence[ElementNode]) -> list[ElementRow]:
    return [
        ElementRow(
            _key(i), None if n.parent_idx is None else _key(n.parent_idx), n.shape, n.element,
            n.name,
        )
        for i, n in enumerate(nodes)
    ]


def sanitize_elements(nodes: Sequence[ElementNode], paths: Sequence[str]) -> list[str]:
    """Снять недопустимые элементы архитектуры (правила — в шапке модуля). Мутирует
    element узлов и возвращает замечания; paths — путь каждого узла для текста.
    Узлы обязаны идти «родители раньше детей»."""
    if all(n.element is None for n in nodes):
        return []
    notes: list[str] = []
    for i, n in enumerate(nodes):
        if n.element is not None and n.shape != "service":
            n.element = None
            notes.append(ONLY_SERVICE_NOTE.format(path=paths[i]))
    if all(n.element != CONTAINER for n in nodes):
        return notes

    elements = build_elements(_rows(nodes))
    for i, n in enumerate(nodes):
        # Контейнер внутри контейнера — дело правила 3: наружный уже решён (родители
        # раньше), и внутренний — его компонент.
        if n.element != CONTAINER or elements.effective(_key(i)) != "container":
            continue
        for member in elements.members_of(_key(i)):
            culprit = nodes[member.int]
            template = STORE_INSIDE_NOTE.get(culprit.shape)
            if template is None:
                continue
            n.element = None
            notes.append(template.format(path=paths[i], name=culprit.name))
            # Снятое значение меняет действующие элементы потомков — пересборка.
            elements = build_elements(_rows(nodes))
            break

    # Снятие элемента у компонента действующих элементов не меняет (компонентом его
    # делает предок-контейнер, а не своё значение), поэтому один проход по одной сборке.
    for i, n in enumerate(nodes):
        if n.element is None or elements.effective(_key(i)) != "component":
            continue
        container = elements.container_of(_key(i))
        n.element = None
        notes.append(COMPONENT_NOTE.format(
            path=paths[i], container=nodes[container.int].name if container is not None else "",
        ))
    return notes


def as_clause(refusal: str) -> str:
    """Текст отказа правила (app/element_rules) хвостом строки отчёта после тире: с
    маленькой буквы, как продолжение фразы."""
    return refusal[:1].lower() + refusal[1:]
