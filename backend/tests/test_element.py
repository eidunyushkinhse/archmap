"""Тесты чистого модуля элементов архитектуры (app/element.py, docs/plan-c4-elements.md).

Главный инвариант фазы Ф0: при пустом хранимом элементе ответ совпадает с сегодняшним
поведением продукта — все узлы с детьми системы, все листья (кроме «Пользователя»)
контейнеры, компонентов нет.
"""

from app.element import Elements


def _elements(parent_of: dict, stored: dict | None = None, persons: tuple = (), children_of=None) -> Elements:
    shapes = {nid: ("person" if nid in persons else "service") for nid in parent_of}
    return Elements(parent_of, shapes, stored or {}, children_of)


def test_лист_сам_себе_контейнер():
    el = _elements({"svc": None})
    assert el.effective("svc") == "container"
    assert el.container_of("svc") == "svc"
    assert el.members_of("svc") == []
    assert el.units_under("svc") == ["svc"]


def test_система_с_листьями():
    # root → (a, b); a → a1. Без хранимых элементов узлы с детьми — системы.
    el = _elements({"root": None, "a": "root", "a1": "a", "b": "root"})
    assert [el.effective(n) for n in ("root", "a", "a1", "b")] == ["system", "system", "container", "container"]
    assert el.container_of("root") is None
    assert el.container_of("a") is None
    assert el.container_of("a1") == "a1"
    assert el.members_of("root") == []
    # единицы — контейнеры поддерева в порядке обхода в глубину
    assert el.units_under("root") == ["a1", "b"]
    assert el.units_under("a") == ["a1"]


def test_контейнер_с_компонентами():
    # sys → (orders, search); orders — контейнер → (api, worker); api → handler.
    parent_of = {"sys": None, "orders": "sys", "api": "orders", "handler": "api", "worker": "orders", "search": "sys"}
    el = _elements(parent_of, {"orders": "container"})
    assert el.effective("sys") == "system"
    assert el.effective("orders") == "container"
    assert el.effective("api") == "component"  # узел с детьми внутри контейнера — составной компонент
    assert el.effective("handler") == "component"
    assert el.effective("worker") == "component"
    assert el.effective("search") == "container"
    assert el.container_of("orders") == "orders"
    assert el.container_of("handler") == "orders"
    assert el.container_of("api") == "orders"
    assert el.members_of("orders") == ["api", "handler", "worker"]
    assert el.members_of("api") == []  # компонент — не контейнер
    assert el.units_under("orders") == ["orders"]
    assert el.units_under("api") == []
    assert el.units_under("handler") == []
    # система: вниз до первого контейнера, компоненты в единицы не попадают
    assert el.units_under("sys") == ["orders", "search"]


def test_вложенный_хранимый_контейнер_внутри_контейнера_компонент():
    # Хранимое «container» у узла внутри контейнера не читается: он составной компонент,
    # а владелец фактов процесса — внешний контейнер.
    parent_of = {"outer": None, "inner": "outer", "leaf": "inner"}
    el = _elements(parent_of, {"outer": "container", "inner": "container"})
    assert el.effective("outer") == "container"
    assert el.effective("inner") == "component"
    assert el.effective("leaf") == "component"
    assert el.container_of("leaf") == "outer"
    assert el.container_of("inner") == "outer"
    assert el.members_of("outer") == ["inner", "leaf"]
    assert el.units_under("outer") == ["outer"]


def test_хранимое_у_листа_и_система_явно():
    # Хранимое значение у листа не читается (узел потерял последнего ребёнка);
    # явная «system» у узла с детьми — то же, что не сказано.
    parent_of = {"g": None, "leaf": "g", "lone": None}
    el = _elements(parent_of, {"g": "system", "leaf": "system", "lone": "container"})
    assert el.effective("g") == "system"
    assert el.effective("leaf") == "container"
    assert el.effective("lone") == "container"
    assert el.units_under("g") == ["leaf"]


def test_пользователь_снаружи_и_внутри_контейнера():
    parent_of = {"sys": None, "user": "sys", "svc": "sys", "admin": "svc", "part": "svc", "guest": None}
    el = _elements(parent_of, {"svc": "container"}, persons=("user", "admin", "guest"))
    for person in ("user", "admin", "guest"):
        assert el.effective(person) is None
        assert el.container_of(person) is None
        assert el.units_under(person) == []
        assert el.members_of(person) == []
    assert el.effective("part") == "component"
    # «Пользователь» в единицы системы не попадает, но в состав контейнера — как потомок
    assert el.units_under("sys") == ["svc"]
    assert el.members_of("svc") == ["admin", "part"]


def test_пустое_хранимое_совпадает_с_сегодняшним_поведением():
    # Дерево трёх уровней с «Пользователями»: без хранимых элементов компонентов нет.
    parent_of = {
        "r": None, "s1": "r", "s2": "r", "p": "r",
        "a": "s1", "b": "s1", "c": "s2", "d": "c", "e": "c", "q": "c",
    }
    persons = ("p", "q")
    el = _elements(parent_of, persons=persons)
    has_children = {pid for pid in parent_of.values() if pid is not None}
    for node in parent_of:
        if node in persons:
            expected = None
        elif node in has_children:
            expected = "system"
        else:
            expected = "container"
        assert el.effective(node) == expected, node
        assert el.members_of(node) == []
        assert el.container_of(node) == (node if expected == "container" else None)
    # единицы = листья без «Пользователей», как placeable_leaves в app/deployment
    assert el.units_under("r") == ["a", "b", "d", "e"]


def test_цикл_родителей_не_вешает():
    # a ↔ b — цикл; c под a. Подъём и спуск обрываются на повторе.
    el = _elements({"a": "b", "b": "a", "c": "a"})
    assert el.effective("a") == "system"
    assert el.effective("b") == "system"
    assert el.effective("c") == "container"
    assert el.units_under("a") == ["c"]
    # цикл с хранимым контейнером: a — контейнер, b и c — его компоненты
    el = _elements({"a": "b", "b": "a", "c": "a"}, {"a": "container"})
    assert el.effective("a") == "container"
    assert el.effective("b") == "component"
    assert el.container_of("c") == "a"
    assert el.members_of("a") == ["b", "c"]
    # цикл, где каждый узел — потомок контейнера: все компоненты, контейнера нет
    el = _elements({"x": "z", "y": "x", "z": "y"}, {"x": "container", "y": "container", "z": "container"})
    assert [el.effective(n) for n in ("x", "y", "z")] == ["component"] * 3
    assert el.container_of("x") is None
    assert el.units_under("x") == []
    # петля на себя — не ребёнок самому себе
    el = _elements({"self": "self"}, {"self": "container"})
    assert el.effective("self") == "container"
    assert el.members_of("self") == []


def test_порядок_детей_из_children_of_и_индексы_ввоза():
    # Ключ — любой Hashable: индексы узлов документа ввоза; порядок обхода — из children_of.
    parent_of = {0: None, 1: 0, 2: 0, 3: 0}
    el = _elements(parent_of, children_of={0: [3, 1, 2]})
    assert el.units_under(0) == [3, 1, 2]
    el = _elements(parent_of, {0: "container"}, children_of={0: [2, 3, 1]})
    assert el.members_of(0) == [2, 3, 1]
