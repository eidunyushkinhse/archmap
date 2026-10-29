"""Где элемент архитектуры задавать можно, а где нет (docs/plan-c4-elements.md, Р3, Р5, Р6).

Правило предметной области, а не HTTP: роутер узлов зовёт element_change_refusal ДО
записи и переводит текст отказа в 422. Отказы — словами продукта:
- форма не «Сервис» — элемент задаётся только у сервиса (у листа-сервиса можно: это
  намерение, оно сработает с первым ребёнком, Р3);
- узел лежит внутри контейнера — он компонент, элемент задаётся у самого контейнера (Р5);
- контейнер, внутри которого база данных или брокер, — запрет (Р6, решение 2026-10-29);
- контейнер, внутри которого уже есть контейнер, — запрет (Р5).
Очистка (None) разрешена всегда. «Пользователь» внутри контейнера отказом не считается:
это замечание панели (AL25), как и до эпика.

Проверка смотрит на дерево ПОСЛЕ правки: форма и родитель — из того же запроса, если
они там есть. Новый узел (POST) проверяется как запись с временным ключом под будущим
родителем, — так одна функция отвечает и за создание, и за правку.
"""

import uuid
from collections.abc import Sequence

from app.domain_types import NodeElement
from app.element_marks import ElementRow, build_elements

ONLY_SERVICE = "Элемент архитектуры задаётся только у сервиса."
INSIDE_CONTAINER = (
    "Объект «{name}» лежит внутри контейнера «{container}» и считается его компонентом. "
    "Элемент архитектуры задаётся у самого контейнера."
)
# Тексты владельца (раздел 0а плана) — дословно, с родом формы.
STORE_INSIDE = {
    "database": (
        "Внутри лежит база данных «{name}», она не может входить в состав контейнера. "
        "Вынесите её на уровень выше и повторите."
    ),
    "broker": (
        "Внутри лежит брокер «{name}», он не может входить в состав контейнера. "
        "Вынесите его на уровень выше и повторите."
    ),
}
CONTAINER_INSIDE = (
    "Внутри «{name}» уже есть контейнер «{inner}». Контейнер не может входить в состав "
    "другого контейнера. Сначала измените элемент архитектуры у «{inner}»."
)


def element_change_refusal(
    rows: Sequence[ElementRow],
    *,
    node_id: uuid.UUID | None,
    name: str,
    parent_id: uuid.UUID | None,
    shape: str,
    value: NodeElement | None,
) -> str | None:
    """Почему узлу нельзя задать элемент value; None — можно.

    rows — все узлы проекта до правки (element_marks.project_element_rows). node_id —
    правимый узел, None — создаваемый; name, parent_id, shape — его имя, родитель и
    форма ПОСЛЕ правки."""
    if value is None:
        return None
    if shape != "service":
        return ONLY_SERVICE
    key = node_id if node_id is not None else uuid.uuid4()
    # Дерево после правки: у правимого узла — родитель и форма из запроса, создаваемый
    # дописан под будущего родителя. Хранимый элемент самого узла здесь не важен:
    # «внутри контейнера» решают предки, а состав ниже считается с новым значением.
    after = [r for r in rows if r.id != key]
    after.append(ElementRow(key, parent_id, shape, None, name))

    by_id = {r.id: r for r in after}
    elements = build_elements(after)
    if elements.effective(key) == "component":
        container = elements.container_of(key)
        # Без контейнера компонент бывает только в цикле данных — имя тогда пустое.
        inside = by_id[container].name if container is not None else ""
        return INSIDE_CONTAINER.format(name=name, container=inside)

    if value != "container":
        return None
    # Состав будущего контейнера — его потомки в обходе в глубину, дети по имени.
    future = build_elements(
        [r._replace(element="container") if r.id == key else r for r in after]
    )
    members = future.members_of(key)
    for m in members:
        template = STORE_INSIDE.get(by_id[m].shape)
        if template:
            return template.format(name=by_id[m].name)
    for m in members:
        if by_id[m].element == "container":
            return CONTAINER_INSIDE.format(name=name, inner=by_id[m].name)
    return None
