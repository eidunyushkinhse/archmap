"""Элемент архитектуры узла: система · контейнер · компонент (docs/plan-c4-elements.md).

У узла с детьми хранится элемент `system | container | None`; None («не сказано») читается
как система — так вели себя все узлы с детьми до эпика. Действующий элемент из хранимого
не выводится: лист вне контейнера сам контейнер, а всё внутри контейнера — компоненты,
поэтому нужен подъём к предкам, а не взгляд на `has_children`. Считает его ТОЛЬКО этот
модуль: выдачи узла, семьи фактов, алерты, размещение и превью ввоза берут ответ отсюда,
фронт и MCP его не вычисляют — две реализации разойдутся.

Правила действующего элемента:
- форма person — элемента нет (None): «Пользователь» живёт вне системы;
- есть предок (не сам узел) с хранимым container — компонент; у узла с детьми это
  составной компонент;
- иначе узел с детьми — контейнер, если так хранится, и система в любом другом случае;
- иначе (лист): у не-сервиса — контейнер (элемент задаётся только у сервиса); у сервиса
  с хранимым «система» — система («пустая система», Р39 раздела 13 плана: пользователь
  выбрал тип «Система» заранее, и до первого вложенного объекта она не должна
  показываться контейнером); с хранимым «контейнер» — контейнер (явное намерение, в том
  числе у внешнего листа); без хранимого элемента — система у внешнего (Р42) и
  контейнер у своего, как и у узла, потерявшего последнего ребёнка.

Внешний лист-сервис без хранимого элемента — внешняя система (Р42, решение владельца
2026-10-31): по C4 чужой продукт — система, чёрный ящик, а не контейнер, и до эпика
интерфейс так его и подписывал. Документация у внешней системы не ошибка (агент описывает
внешнее API спецификацией): AL24 внешние объекты не проверяет. Внешний узел с детьми
читается по общему правилу узла с детьми.

Пустая система — система во всём: своих фактов у неё нет (их ловит AL24), статус
складывается из единиц, а их нет («в работе»), размещать нечего (units_under пусто), её
экземпляры спят до первого вложенного объекта-единицы (app/element_change, правило 5
D34). Внешняя система (Р42) — так же, кроме фактов: её документация на месте.

Факт процесса (конфигурация, спецификация OpenAPI, площадки, статус страницы) — у
ближайшего контейнера (`container_of`), факт кода (схемы логики, источник, концы связей) —
у листа или компонента.

Модуль чистый, без ORM, по картам — как app/connectivity и app/deployment: ключ — любой
Hashable (uuid узла в БД, индекс узла в документе ввоза). Обход предков и потомков — с
seen: данные снимков и импорта бывают циклическими. Ответы мемоизируются, поэтому
`Elements` собирают один раз на запрос и спрашивают сколько угодно.
"""

from collections.abc import Collection, Hashable, Mapping, Sequence

from app.domain_types import NodeElement, NodeElementEffective

CONTAINER: NodeElement = "container"
SYSTEM: NodeElement = "system"


class Elements[K: Hashable]:
    """Действующие элементы узлов одного дерева.

    parent_of — родитель каждого узла (None у корня); узел, которого нет среди ключей,
    подъём останавливает. shape_of — форма узла. stored — хранимый элемент.
    children_of — дети в порядке обхода; без него собираются из parent_of в порядке его
    ключей. external — внешние узлы (is_external): внешний лист-сервис без хранимого
    элемента — система (Р42); без аргумента внешних нет."""

    def __init__(
        self,
        parent_of: Mapping[K, K | None],
        shape_of: Mapping[K, str],
        stored: Mapping[K, str | None],
        children_of: Mapping[K, Sequence[K]] | None = None,
        *,
        external: Collection[K] = (),
    ) -> None:
        self._parent_of = parent_of
        self._shape_of = shape_of
        self._stored = stored
        self._external = frozenset(external)
        kids: dict[K, list[K]] = {}
        if children_of is None:
            for node_id, parent_id in parent_of.items():
                if parent_id is not None and parent_id != node_id:
                    kids.setdefault(parent_id, []).append(node_id)
        else:
            for parent_id, children in children_of.items():
                own = [c for c in children if c != parent_id]
                if own:
                    kids[parent_id] = own
        self._children = kids
        self._memo: dict[K, NodeElementEffective | None] = {}
        # «Есть предок с хранимым container» — по узлам цепочек без цикла (_inside_container).
        self._inside: dict[K, bool] = {}

    def _ancestors(self, node_id: K) -> list[K]:
        """Предки от родителя к корню, без самого узла; цикл обрывается на повторе."""
        out: list[K] = []
        seen = {node_id}
        cur = self._parent_of.get(node_id)
        while cur is not None and cur not in seen:
            out.append(cur)
            seen.add(cur)
            cur = self._parent_of.get(cur)
        return out

    def _inside_container(self, node_id: K) -> bool:
        """Есть ли у узла предок (не он сам) с хранимым container.

        Один подъём отвечает за всю пройденную цепочку: ответ каждого узла на ней — хранимый
        container у его родителя или ответ родителя. Так проход по всем узлам проекта
        (статус страницы систем считает элемент каждого узла) линеен, а не квадратичен по
        глубине. Мемо пишется только для цепочек без цикла: у узла цикла предки считаются
        без него самого, и ответ по родителю был бы неверен, — там честный подъём от узла."""
        if node_id in self._inside:
            return self._inside[node_id]
        path: list[K] = [node_id]
        seen = {node_id}
        above = False  # ответ для узла, на котором подъём остановился (над путём)
        cur = self._parent_of.get(node_id)
        while cur is not None:
            if cur in seen:
                return any(self._stored.get(a) == CONTAINER for a in self._ancestors(node_id))
            if cur in self._inside:
                above = self._inside[cur] or self._stored.get(cur) == CONTAINER
                break
            path.append(cur)
            seen.add(cur)
            cur = self._parent_of.get(cur)
        for step in reversed(path):
            self._inside[step] = above
            above = above or self._stored.get(step) == CONTAINER
        return self._inside[node_id]

    def effective(self, node_id: K) -> NodeElementEffective | None:
        """Действующий элемент узла (правила — в шапке модуля): у «Пользователя» — None,
        внутри контейнера — компонент, у узла с детьми — хранимый контейнер или система,
        у листа — система при хранимом «система» (пустая система, Р39) и у внешнего
        сервиса без хранимого элемента (внешняя система, Р42), иначе контейнер."""
        if node_id in self._memo:
            return self._memo[node_id]
        result: NodeElementEffective | None
        if self._shape_of.get(node_id) == "person":
            result = None
        elif self._inside_container(node_id):
            result = "component"
        elif self._children.get(node_id):
            result = "container" if self._stored.get(node_id) == CONTAINER else "system"
        elif self._shape_of.get(node_id) != "service":
            # Элемент задаётся только у сервиса — у другой формы хранимое значение (данные
            # в обход правил) не читается, а внешность не делает базу или брокер системой.
            result = "container"
        elif self._stored.get(node_id) == SYSTEM:
            result = "system"  # пустая система (Р39)
        elif self._stored.get(node_id) == CONTAINER:
            result = "container"  # явное намерение — и у внешнего листа
        else:
            # Не сказано: свой лист — контейнер, внешний — внешняя система (Р42).
            result = "system" if node_id in self._external else "container"
        self._memo[node_id] = result
        return result

    def external_system(self, node_id: K) -> bool:
        """Внешняя система без вложенных (Р42): внешний лист, который читается системой, —
        чёрный ящик. Её документация на месте (AL24 и AL33 её не судят), размещать и
        согласовывать у неё нечего, и отказы говорят об этом без упрёка «пусто»."""
        return (
            node_id in self._external
            and not self._children.get(node_id)
            and self.effective(node_id) == "system"
        )

    def parent(self, node_id: K) -> K | None:
        """Родитель узла (None у корня и у узла, которого нет в дереве)."""
        return self._parent_of.get(node_id)

    def container_of(self, node_id: K) -> K | None:
        """Контейнер, которому принадлежат факты процесса узла: у контейнера — он сам, у
        компонента — его предок с действующим элементом «контейнер»; у системы и у
        «Пользователя» — None. В цикле, где все узлы — компоненты, контейнера нет."""
        element = self.effective(node_id)
        if element == "container":
            return node_id
        if element != "component":
            return None
        for ancestor in self._ancestors(node_id):
            if self.effective(ancestor) == "container":
                return ancestor
        return None

    def descendants(self, node_id: K) -> list[K]:
        """Все потомки узла в обходе в глубину (порядок детей сохраняется), без него."""
        out: list[K] = []
        seen = {node_id}
        stack = list(reversed(self._children.get(node_id, [])))
        while stack:
            cur = stack.pop()
            if cur in seen:
                continue
            seen.add(cur)
            out.append(cur)
            stack.extend(reversed(self._children.get(cur, [])))
        return out

    def members_of(self, container_id: K) -> list[K]:
        """Состав контейнера — все его потомки, компоненты любой глубины, в обходе в
        глубину. У не-контейнера — пусто. «Пользователя» в составе не бывает (N4г, он
        живёт на верхнем уровне); вложенный из старых данных попадает сюда как есть, его
        отмечает AL25."""
        if self.effective(container_id) != "container":
            return []
        return self.descendants(container_id)

    def units_under(self, node_id: K) -> list[K]:
        """Развёртываемые единицы узла: контейнер — он сам; система — единицы её детей в
        порядке обхода (вниз до первого контейнера); компонент и «Пользователь» — пусто."""
        out: list[K] = []
        seen: set[K] = set()
        stack = [node_id]
        while stack:
            cur = stack.pop()
            if cur in seen:
                continue
            seen.add(cur)
            element = self.effective(cur)
            if element == "container":
                out.append(cur)
            elif element == "system":
                stack.extend(reversed(self._children.get(cur, [])))
        return out
