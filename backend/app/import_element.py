"""Элемент архитектуры во ввозе: санитизация разобранного дерева (docs/plan-c4-elements.md,
Р5, Р6, Р29).

Правка узла через API отказывает в недопустимом элементе (app/element_rules, 422), а ввоз
файлом из-за этого не отвергается: агент мог ошибиться в одном узле, и терять из-за этого
весь документ — хуже, чем поправить одно место с замечанием. Инвариант хранимых данных тот
же, что держит API: элемент задаётся только у сервиса; внутри контейнера нет ни базы, ни
брокера, ни другого контейнера, а у компонентов элемента нет вовсе.

Одна функция на все ввозы: разбор одного файла (parse_import), слияние нескольких
(_Merger.finish — по слитому дереву, где база и контейнер могли прийти из разных файлов) и
применение ответов на вопросы (выбранный «Контейнер» мог стать недопустимым). Правила
идут по порядку, обход — «родители раньше детей» (так строит дерево и разбор, и слияние):
0. у базы данных, брокера и «Пользователя» вложенных объектов не бывает (API отвечает на
   это отказом, N4): их дети поднимаются на уровень выше — к родителю такого объекта (у
   корневого — на верхний уровень) — с поддеревьями. Правило идёт первым и не зависит от
   элементов: поднятый объект дальше проверяется по своему новому месту (база, поднятая
   из базы внутри контейнера, следующим правилом выносится и из контейнера). Своих
   площадок у поднятого нет — он берёт объявление прежнего родителя: тот был для него
   системой и отдавал ему своё размещение (app/deployment.unit_placements); внутри
   контейнера размещения не было ни у кого из них, и ничего не берётся. Вложенного
   «Пользователя» это правило не трогает — его поднимает следующее;
0а. «Пользователь» живёт только на верхнем уровне (решение владельца 2026-10-31, API
   отказывает в создании внутри объекта): вложенный поднимается на верхний уровень, где
   бы ни лежал — в системе, контейнере, компоненте или внутри базы. Правило идёт после
   правила 0: дети человека к этому моменту уже у его родителя и в корень с ним не
   уезжают. Замечание одно на человека; отчёт слияния о людях внутри системы больше не
   пишет (app/merge_warnings) — после подъёма ему не о ком говорить;
1. элемент у не-сервиса снимается — значение пропущено;
2. база или брокер внутри контейнера ВЫНОСИТСЯ на уровень выше — к родителю контейнера (у
   корневого контейнера — на верхний уровень), контейнер остаётся контейнером (решение
   владельца Р6, раздел 0а плана). Выносятся все такие потомки, и лежащие глубже, внутри
   составных компонентов, — в обходе в глубину с детьми по имени, как у отказа API
   (Elements над теми же записями ElementRow). Поддерево выносимого едет с ним. Своего
   размещения у выносимого нет — он берёт объявление ближайшего узла на пути от прежнего
   родителя до контейнера включительно: иначе потерял бы площадки, которые получал по
   объявлению предка (app/deployment.unit_placements);
3. у потомков действующего контейнера заданный элемент снимается — они его компоненты.
   Так разрешается и «контейнер внутри контейнера»: внутренний становится составным
   компонентом, наружный остаётся контейнером;
4. площадки у компонента (по итоговым элементам) снимаются с замечанием: размещение
   задаётся контейнеру, у компонента его не бывает (Р16). В контейнер они тихо не
   переносятся — это было бы наследованием с другой стороны (ошибка 2026-10).
У листа-сервиса значение — намерение (Р3) и не замечание.

Закреплённые узлы (pinned) не переносятся никогда: это живые объекты проекта при догрузке
(вход №0 — снимок живого проекта), а догрузка живое дерево не перестраивает. Если среди
выносимых есть закреплённый, правило 2 оставляет базу на месте и снимает элемент у
контейнера — узел читается системой. Исключение — контейнер, чей элемент тоже живой
(live_element): живые данные вне правила (записанные в обход API) ввоз не судит и не
правит — догрузка только доливает пустое, — поэтому такое место остаётся как есть и без
замечания.

Тексты замечаний не содержат маркеров классов остатка (app/unified_remarks,
_REMARK_CLASSES и _REMARK_TAILS узнают класс подстрокой): строка без маркера едет в
свёртку «Придется подправить вручную» как есть.
"""

import uuid
from collections.abc import Callable, Sequence
from typing import Protocol

from app.domain_types import NodeElement, NodeElementEffective
from app.element import CONTAINER, Elements
from app.element_marks import ElementRow, build_elements

ONLY_SERVICE_NOTE = "{path}: элемент архитектуры задаётся только у сервиса — значение пропущено"
# Правило 0а: вложенный «Пользователь» поднимается на верхний уровень. {path} — где он
# лежал (путь родителя), как у замечаний правила 0 и выноса из контейнера.
PERSON_LIFTED_NOTE = (
    "{path}: пользователь «{name}» живёт вне границ системы — поднят на верхний уровень"
)
# Правило 0: у формы без детей вложенный объект поднимается выше. {where} — как у выноса
# из контейнера (_where): «на уровень выше, в «Путь»» либо «на верхний уровень».
CHILDLESS_LIFTED_NOTE = {
    "database": (
        "{path}: у базы данных «{name}» вложенных объектов не бывает — «{child}» поднят "
        "{where}"
    ),
    "broker": (
        "{path}: у брокера «{name}» вложенных объектов не бывает — «{child}» поднят {where}"
    ),
    "person": (
        "{path}: у пользователя «{name}» вложенных объектов не бывает — «{child}» поднят "
        "{where}"
    ),
}
# Тексты владельца (раздел 0а плана) с родом формы — как у отказа API (STORE_INSIDE).
# {where} — «на уровень выше, в «Путь»» либо «на верхний уровень» (_where).
STORE_LIFTED_NOTE = {
    "database": (
        "{path}: внутри лежит база данных «{name}», она не может входить в состав "
        "контейнера — вынесена {where}"
    ),
    "broker": (
        "{path}: внутри лежит брокер «{name}», он не может входить в состав "
        "контейнера — вынесен {where}"
    ),
}
# Закреплённую базу (живой объект при догрузке) вынести нельзя — остаётся системой.
STORE_KEPT_NOTE = {
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
COMPONENT_SITES_NOTE = (
    "{path}: размещение задаётся контейнеру «{container}» — площадки у компонента пропущены"
)


class ElementNode(Protocol):
    """Узел разобранного дерева, как его видит санитизация (_ImpNode ввоза): элемент,
    родитель и площадки она меняет, имя, форму и внешность только читает (внешний
    лист-сервис без элемента — система, Р42)."""

    @property
    def name(self) -> str: ...

    @property
    def shape(self) -> str: ...

    @property
    def is_external(self) -> bool: ...

    parent_idx: int | None
    element: NodeElement | None
    sites: list[str]


def _key(idx: int) -> uuid.UUID:
    """Индекс узла документа как ключ записи ElementRow. Порядок строк таких ключей —
    порядок индексов (нули слева), поэтому тёзки идут в порядке документа."""
    return uuid.UUID(int=idx)


def _rows(nodes: Sequence[ElementNode]) -> list[ElementRow]:
    return [
        ElementRow(
            _key(i), None if n.parent_idx is None else _key(n.parent_idx), n.shape, n.element,
            n.name, n.is_external,
        )
        for i, n in enumerate(nodes)
    ]


def _inside(nodes: Sequence[ElementNode], idx: int, ancestor: int) -> bool:
    """Лежит ли узел (всё ещё) внутри ancestor. Шагов не больше числа узлов: родители
    в разобранном дереве раньше детей, но данные бывают какими угодно."""
    cur = nodes[idx].parent_idx
    for _ in range(len(nodes)):
        if cur is None:
            return False
        if cur == ancestor:
            return True
        cur = nodes[cur].parent_idx
    return False


def _lift(nodes: Sequence[ElementNode], idx: int, container: int) -> None:
    """Вынести узел к родителю контейнера. Без своих площадок — площадки ближайшего
    объявившего их узла на пути от прежнего родителя до контейнера включительно."""
    node = nodes[idx]
    if not node.sites:
        cur = node.parent_idx
        for _ in range(len(nodes)):
            if cur is None:
                break
            if nodes[cur].sites:
                node.sites = list(nodes[cur].sites)
                break
            if cur == container:
                break
            cur = nodes[cur].parent_idx
    node.parent_idx = nodes[container].parent_idx


def _where(nodes: Sequence[ElementNode], paths: Sequence[str], container: int) -> str:
    parent = nodes[container].parent_idx
    return "на верхний уровень" if parent is None else f"на уровень выше, в «{paths[parent]}»"


def _in_container(nodes: Sequence[ElementNode], idx: int) -> bool:
    """Есть ли над узлом сервис с элементом «контейнер» (тогда узел — компонент, и
    размещения ни у него, ни у его детей нет). Шагов не больше числа узлов."""
    cur = nodes[idx].parent_idx
    for _ in range(len(nodes)):
        if cur is None:
            return False
        if nodes[cur].shape == "service" and nodes[cur].element == CONTAINER:
            return True
        cur = nodes[cur].parent_idx
    return False


def _lift_from_childless(
    nodes: Sequence[ElementNode],
    paths: Sequence[str],
    pinned: Callable[[int], bool] | None,
) -> list[str]:
    """Правило 0: дети базы, брокера и «Пользователя» — к родителю такого объекта, с
    поддеревьями. Цепочка «база в базе» распутывается за один проход: родители раньше
    детей, и поднятый (индекс больше) будет осмотрен позже уже на новом месте.
    Закреплённый ребёнок (живой при догрузке) не переносится — живое против живого
    ввоз не судит. Ребёнок-«Пользователь» остаётся правилу 0а: оно поднимет его сразу
    на верхний уровень одним замечанием, а не двумя."""
    notes: list[str] = []
    for i, holder in enumerate(nodes):
        if holder.shape not in CHILDLESS_LIFTED_NOTE:
            continue
        for c, child in enumerate(nodes):
            if (
                child.parent_idx != i
                or child.shape == "person"
                or (pinned is not None and pinned(c))
            ):
                continue
            if not child.sites and not _in_container(nodes, i):
                child.sites = list(holder.sites)
            child.parent_idx = holder.parent_idx
            notes.append(CHILDLESS_LIFTED_NOTE[holder.shape].format(
                path=paths[i], name=holder.name, child=child.name,
                where=_where(nodes, paths, i),
            ))
    return notes


def _lift_persons(
    nodes: Sequence[ElementNode],
    paths: Sequence[str],
    pinned: Callable[[int], bool] | None,
) -> list[str]:
    """Правило 0а: вложенный «Пользователь» — на верхний уровень. Порядок «родители
    раньше детей» сохраняется: у корневого узла родителя нет. Площадки не берутся — у
    пользователя размещения не бывает (app/deployment). Закреплённый (живой при
    догрузке) не переносится: догрузка живое дерево не перестраивает, вложенного
    человека из старых данных отмечает AL25."""
    notes: list[str] = []
    for i, n in enumerate(nodes):
        if n.shape != "person" or n.parent_idx is None or (pinned is not None and pinned(i)):
            continue
        notes.append(PERSON_LIFTED_NOTE.format(path=paths[n.parent_idx], name=n.name))
        n.parent_idx = None
    return notes


def sanitize_elements(
    nodes: Sequence[ElementNode],
    paths: Sequence[str],
    pinned: Callable[[int], bool] | None = None,
    live_element: Callable[[int], bool] | None = None,
) -> list[str]:
    """Поправить элементы архитектуры дерева (правила — в шапке модуля). Мутирует element,
    parent_idx и sites узлов и возвращает замечания; paths — путь каждого узла ДО правки
    (для текста). Узлы обязаны идти «родители раньше детей» — после выноса это так и
    остаётся: новый родитель (родитель контейнера) раньше контейнера, а тот раньше
    выносимого. pinned — узлы, которые переносить нельзя (живые при догрузке);
    live_element — узлы, чей элемент взят из живого проекта, а не из ввоза."""
    notes = _lift_from_childless(nodes, paths, pinned)
    notes += _lift_persons(nodes, paths, pinned)
    if all(n.element is None for n in nodes):
        return notes
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
        culprits = [
            m.int for m in elements.members_of(_key(i))
            if nodes[m.int].shape in STORE_LIFTED_NOTE
        ]
        if not culprits:
            continue
        stuck = next((c for c in culprits if pinned is not None and pinned(c)), None)
        if stuck is not None and live_element is not None and live_element(i):
            continue  # живое против живого — не дело ввоза
        if stuck is not None:
            n.element = None
            notes.append(STORE_KEPT_NOTE[nodes[stuck].shape].format(
                path=paths[i], name=nodes[stuck].name,
            ))
        else:
            for c in culprits:
                # База внутри уже вынесенной базы едет вместе с ней — второй раз не нужно.
                if not _inside(nodes, c, i):
                    continue
                _lift(nodes, c, i)
                notes.append(STORE_LIFTED_NOTE[nodes[c].shape].format(
                    path=paths[i], name=nodes[c].name, where=_where(nodes, paths, i),
                ))
        # Дерево изменилось — действующие элементы потомков считаются заново.
        elements = build_elements(_rows(nodes))

    return notes + _strip_components(nodes, paths, elements)


def _strip_components(
    nodes: Sequence[ElementNode], paths: Sequence[str], elements: Elements[uuid.UUID]
) -> list[str]:
    """Правила 3 и 4: у компонента снимаются элемент и площадки, с замечанием на каждое.
    Снятие элемента у компонента действующих элементов не меняет (компонентом его делает
    предок-контейнер, а не своё значение), поэтому оба правила — один проход по одной
    сборке."""
    notes: list[str] = []
    for i, n in enumerate(nodes):
        if elements.effective(_key(i)) != "component" or (n.element is None and not n.sites):
            continue
        container = elements.container_of(_key(i))
        name = nodes[container.int].name if container is not None else ""
        if n.element is not None:
            n.element = None
            notes.append(COMPONENT_NOTE.format(path=paths[i], container=name))
        if n.sites:
            n.sites = []
            notes.append(COMPONENT_SITES_NOTE.format(path=paths[i], container=name))
    return notes


def effective_elements(nodes: Sequence[ElementNode]) -> list[NodeElementEffective | None]:
    """Действующий элемент каждого узла разобранного (слитого) дерева по индексу — одна
    сборка app/element на всё дерево. Ей говорят слова замечаний и вопросов превью ввоза:
    конец связи в системе или в контейнере, тег объекта в списках разбора."""
    elements = build_elements(_rows(nodes))
    return [elements.effective(_key(i)) for i in range(len(nodes))]


def tree_paths(nodes: Sequence[ElementNode]) -> list[str]:
    """Полные пути «Корень / … / Имя» по текущим родителям (родители раньше детей) — после
    выноса пути вынесенных поддеревьев другие."""
    out: list[str] = []
    for n in nodes:
        out.append(n.name if n.parent_idx is None else f"{out[n.parent_idx]} / {n.name}")
    return out


def as_clause(refusal: str) -> str:
    """Текст отказа правила (app/element_rules) хвостом строки отчёта после тире: с
    маленькой буквы, как продолжение фразы."""
    return refusal[:1].lower() + refusal[1:]
