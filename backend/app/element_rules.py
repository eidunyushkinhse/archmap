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

Тот же запрет Р6 с другой стороны — store_refusal: база или брокер не входят в контейнер
ни созданием, ни переносом, ни сменой формы (роутер узлов и app/reparent переводят текст
в 422/400). Тексты — одна семья шаблонов с родом формы, рядом со STORE_INSIDE.
"""

import uuid
from collections.abc import Sequence
from typing import Literal

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
# Р6 со стороны вложения: база или брокер оказываются внутри контейнера — созданием,
# переносом (сами или в переносимом поддереве) или сменой формы. Род формы — в шаблоне.
STORE_CREATE = {
    "database": (
        "База данных «{name}» не может входить в состав контейнера «{container}». "
        "Создайте её на уровне выше."
    ),
    "broker": (
        "Брокер «{name}» не может входить в состав контейнера «{container}». "
        "Создайте его на уровне выше."
    ),
}
STORE_MOVE = {
    "database": (
        "База данных «{name}» не может входить в состав контейнера «{container}». "
        "Перенесите её на уровень выше."
    ),
    "broker": (
        "Брокер «{name}» не может входить в состав контейнера «{container}». "
        "Перенесите его на уровень выше."
    ),
}
STORE_MOVE_INSIDE = {
    "database": (
        "Внутри «{name}» лежит база данных «{store}», она не может входить в состав "
        "контейнера «{container}». Вынесите её на уровень выше и повторите."
    ),
    "broker": (
        "Внутри «{name}» лежит брокер «{store}», он не может входить в состав "
        "контейнера «{container}». Вынесите его на уровень выше и повторите."
    ),
}
STORE_SHAPE = {
    "database": (
        "Объект «{name}» лежит внутри контейнера «{container}», а база данных не может "
        "входить в состав контейнера. Вынесите его на уровень выше и повторите."
    ),
    "broker": (
        "Объект «{name}» лежит внутри контейнера «{container}», а брокер не может "
        "входить в состав контейнера. Вынесите его на уровень выше и повторите."
    ),
}


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


def store_refusal(
    rows: Sequence[ElementRow],
    *,
    node_id: uuid.UUID | None,
    name: str,
    parent_id: uuid.UUID | None,
    shape: str,
    action: Literal["create", "move", "shape"],
) -> str | None:
    """Р6: почему узел (или его поддерево) не может оказаться там, куда его ставят; None —
    может. База и брокер внутри контейнера — компоненты, а компонентом бывает только
    код: таблицам и каналам нужен свой контейнер рядом (решение владельца 2026-10-29).

    rows — все узлы проекта до правки. node_id — правимый узел, None — создаваемый;
    name, parent_id, shape — его имя, родитель и форма ПОСЛЕ правки. action выбирает
    текст: создание, перенос (сам узел или база/брокер в его поддереве) или смена формы.
    Дерево — после правки, как у element_change_refusal: хранимые элементы прочих узлов
    те же, поэтому контейнер, внутрь которого кладут, считается тем же Elements."""
    key = node_id if node_id is not None else uuid.uuid4()
    own = next((r for r in rows if r.id == key), None)
    after = [r for r in rows if r.id != key]
    after.append(ElementRow(key, parent_id, shape, own.element if own else None, name))
    by_id = {r.id: r for r in after}
    elements = build_elements(after)

    def container_name(node: uuid.UUID) -> str:
        holder = elements.container_of(node)
        # Без контейнера компонент бывает только в цикле данных — имя тогда пустое.
        return by_id[holder].name if holder is not None else ""

    own_template = {"create": STORE_CREATE, "move": STORE_MOVE, "shape": STORE_SHAPE}[action]
    if shape in own_template and elements.effective(key) == "component":
        return own_template[shape].format(name=name, container=container_name(key))
    if action != "move":
        return None
    # Переносимое поддерево: первый виновник в обходе в глубину (дети по имени).
    for inner in elements.descendants(key):
        row = by_id[inner]
        if row.shape in STORE_MOVE_INSIDE and elements.effective(inner) == "component":
            return STORE_MOVE_INSIDE[row.shape].format(
                name=name, store=row.name, container=container_name(inner)
            )
    return None
