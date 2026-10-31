"""Где элемент архитектуры задавать можно, а где нет (docs/plan-c4-elements.md, Р3, Р5, Р6).

Правило предметной области, а не HTTP: роутер узлов зовёт element_change_refusal ДО
записи и переводит текст отказа в 422. Отказы — словами продукта:
- форма не «Сервис» — элемент задаётся только у сервиса (у листа-сервиса можно: это
  намерение, оно сработает с первым ребёнком, Р3);
- узел лежит внутри контейнера — он компонент, элемент задаётся у самого контейнера (Р5);
- контейнер, внутри которого база данных или брокер, — запрет (Р6, решение 2026-10-29);
- контейнер, внутри которого уже есть контейнер, — запрет (Р5).
Очистка (None) разрешена всегда. «Пользователь» вложенным не бывает (решение владельца
2026-10-31): создание внутри объекта, перенос внутрь и смену формы у вложенного объекта
запрещает app/reparent.person_refusal. Вложенный «Пользователь» из старых данных смене
элемента родителя не мешает: он и так не на своём месте, его отмечает AL25.

Проверка смотрит на дерево ПОСЛЕ правки: форма и родитель — из того же запроса, если
они там есть. Новый узел (POST) проверяется как запись с временным ключом под будущим
родителем, — так одна функция отвечает и за создание, и за правку.

Тот же запрет Р6 с другой стороны — store_refusal: база или брокер не входят в контейнер
ни созданием, ни переносом, ни сменой формы (роутер узлов и app/reparent переводят текст
в 422/400). Тексты — одна семья шаблонов с родом формы, рядом со STORE_INSIDE.

Первый вложенный объект задаёт элемент родителя (Р38 раздела 13 плана) —
first_child_refusal: создание с NodeCreate.parent_element допустимо, только пока
родитель ждёт первого вложенного объекта (сервис без хранимого элемента, без детей и не
компонент — тот же признак, что у окна создания на фронте). «Контейнер» родителю даёт
только компонент: база и брокер не входят в контейнер (Р6), а контейнер внутри
контейнера модель не допускает. «Пользователя» внутри объекта не создают вовсе — роутер
отказывает раньше этого правила (app/reparent.person_refusal).
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


# Р38: элемент родителя при создании первого вложенного объекта.
PARENT_HAS_CHILDREN = "У «{name}» уже есть вложенные объекты, его тип меняют в свойствах."
PARENT_ELEMENT_SET = "У «{name}» тип уже выбран, его меняют в свойствах."
PARENT_ELEMENT_ROOT = "Элемент родителя задаётся только при создании вложенного объекта."


def first_child_refusal(
    rows: Sequence[ElementRow],
    *,
    parent_id: uuid.UUID | None,
    value: NodeElement,
    child_name: str,
    child_shape: str,
    child_element: NodeElement | None,
) -> str | None:
    """Р38: почему первому вложенному объекту нельзя задать элемент родителя value;
    None — можно. rows — все узлы проекта до правки; parent_id — будущий родитель
    создаваемого объекта, child_* — сам создаваемый объект.

    Родитель должен ждать первого вложенного объекта: сервис без хранимого элемента, без
    детей и не компонент. «Контейнер» родителю задаёт только компонент — объект формы
    «Сервис» без своего элемента «контейнер»: база и брокер в контейнер не входят (Р6,
    те же тексты, что у создания базы под контейнером), контейнер внутри контейнера
    модель не допускает (CONTAINER_INSIDE). «Пользователь» сюда не доходит: создание
    человека внутри объекта роутер отказывает раньше (app/reparent.person_refusal)."""
    if parent_id is None:
        return PARENT_ELEMENT_ROOT
    by_id = {r.id: r for r in rows}
    parent = by_id.get(parent_id)
    if parent is None:  # родителя проверяет вызывающий (404) — здесь страховка
        return PARENT_ELEMENT_ROOT
    if parent.shape != "service":
        return ONLY_SERVICE
    elements = build_elements(rows)
    if elements.effective(parent_id) == "component":
        holder = elements.container_of(parent_id)
        inside = by_id[holder].name if holder is not None else ""
        return INSIDE_CONTAINER.format(name=parent.name, container=inside)
    if any(r.parent_id == parent_id and r.id != parent_id for r in rows):
        return PARENT_HAS_CHILDREN.format(name=parent.name)
    if parent.element is not None:
        return PARENT_ELEMENT_SET.format(name=parent.name)
    if value != "container":
        return None
    if child_shape in STORE_CREATE:
        return STORE_CREATE[child_shape].format(name=child_name, container=parent.name)
    if child_element == "container":
        return CONTAINER_INSIDE.format(name=parent.name, inner=child_name)
    return None


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
