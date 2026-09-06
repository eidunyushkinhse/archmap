"""Связность схемы по рёбрам — ядро, ОБЩЕЕ для алерта «изолированные группы»
(app/alerts.compute_alerts, п. 3) и замечания превью импорта
(import_merge._warn_isolated_groups). Трактовка обязана совпадать до буквы — иначе
превью и алерты разойдутся в вердиктах на одной и той же схеме (тесты паритета в
tests/test_import_merge.py).

Правила (docs/specs/alerts.md, AL7):
- Иерархия parent СВЯЗЬЮ НЕ СЧИТАЕТСЯ: через дерево связано вообще всё, и такой
  критерий не отличал бы фрагментированную схему от целой.
- ИСКЛЮЧЕНИЕ (2026-09-06): конец связи В КОНТЕЙНЕРЕ касается всего его поддерева.
  Связь в коробку значит «кто-то говорит с чем-то внутри», поэтому контейнер с
  собственной связью объединяется для связности со своими потомками любой
  глубины — но только с теми, у кого связи есть: одиночки остаются одиночками, о
  них говорит отдельная проверка. Контейнер БЕЗ своей связи детей не соединяет.
  Полевой случай — федерация (docs/plan-byoa-quality.md, Ф-B): пять связей плагина
  в коробки продуктов давали «группу из 5 объектов не связана» при связной схеме.
- Узлы без единой связи в компоненты не входят.
"""

from collections.abc import Hashable, Iterable, Mapping
from typing import TypeVar

T = TypeVar("T", bound=Hashable)


def subtree_bridges(
    edges: Iterable[tuple[T, T]], parent_of: Mapping[T, T | None]
) -> list[tuple[T, T]]:
    """Мостики «контейнер со связью ↔ его потомок со связью» (любой глубины).

    Порядок — от порядка рёбер (первое появление узла), чтобы результат был
    детерминирован при том же входе. Подъём по parent_of конечен: дерево без
    циклов, а счётчик шагов защищает от битых данных."""
    linked = list(dict.fromkeys(x for e in edges for x in e))
    linked_set = set(linked)
    bridges: list[tuple[T, T]] = []
    for n in linked:
        p = parent_of.get(n)
        for _ in range(len(parent_of) + 1):
            if p is None:
                break
            if p in linked_set:
                bridges.append((p, n))
            p = parent_of.get(p)
    return bridges


def connected_components(
    edges: Iterable[tuple[T, T]], parent_of: Mapping[T, T | None] | None = None
) -> list[list[T]]:
    """Связные компоненты графа РЁБЕР; компоненты из одного узла не возвращаются.

    С parent_of к рёбрам добавляются мостики поддеревьев (см. шапку модуля); без
    него — чистый граф рёбер. Порядок компонент и узлов внутри — от порядка рёбер:
    детерминирован при том же входе, а показываем мы их всё равно отсортированными.
    """
    pairs = list(edges)
    if parent_of is not None:
        pairs += subtree_bridges(pairs, parent_of)
    adjacency: dict[T, set[T]] = {}
    for a, b in pairs:
        adjacency.setdefault(a, set()).add(b)
        adjacency.setdefault(b, set()).add(a)
    visited: set[T] = set()
    out: list[list[T]] = []
    for start in adjacency:
        if start in visited:
            continue
        visited.add(start)
        stack = [start]
        comp: list[T] = []
        while stack:
            cur = stack.pop()
            comp.append(cur)
            for nxt in adjacency[cur]:
                if nxt not in visited:
                    visited.add(nxt)
                    stack.append(nxt)
        if len(comp) >= 2:
            out.append(comp)
    return out
