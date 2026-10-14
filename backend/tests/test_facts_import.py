"""Общее у дозаливок табличных фактов (app/facts_import.py) — без БД и HTTP."""

import uuid

from app.facts_import import as_bool, as_str, nodes_hint, resolve_owner
from app.models.node import Node
from app.node_ref import NodeIndex


def _node(name: str, parent: Node | None = None, shape: str = "service") -> Node:
    return Node(id=uuid.uuid4(), name=name, shape=shape, parent_id=parent.id if parent else None)


def _project() -> tuple[NodeIndex, dict[str, Node]]:
    shop = _node("Маркетплейс")
    orders = _node("Сервис заказов", shop)
    orders_db = _node("БД", orders, shape="database")
    billing = _node("Биллинг", shop)
    billing_db = _node("БД", billing, shape="database")
    nodes = {"shop": shop, "orders": orders, "orders_db": orders_db, "billing": billing, "billing_db": billing_db}
    return NodeIndex.of(list(nodes.values())), nodes


def test_скаляры_пакета() -> None:
    assert as_bool(True) and as_bool(" Да ") and as_bool("yes") and as_bool("1")
    assert not as_bool("false") and not as_bool(None) and not as_bool(1)
    # Аудит Q-2: булево в строковом поле — «false», как его пишет агент, а не «False»
    # (раньше так было только у конфигурации).
    assert as_str(False) == "false" and as_str(True) == "true"
    assert as_str(None) == "" and as_str("  varchar ") == "varchar" and as_str(30) == "30"


def test_подсказка_перечисляет_объекты_формы() -> None:
    index, _ = _project()
    assert nodes_hint(index, "database") == "Маркетплейс / Биллинг / БД, Маркетплейс / Сервис заказов / БД"
    assert nodes_hint(index, "broker") == "в проекте их нет"


def test_адрес_полный_хвостом_и_окно() -> None:
    index, n = _project()
    errors: list[str] = []
    assert resolve_owner("Маркетплейс / Биллинг / БД", "a.yaml", index, None, errors, "-") is n["billing_db"]
    # Агент видит только свой репозиторий: путь без корня находится по хвосту.
    assert resolve_owner("Сервис заказов / БД", "a.yaml", index, None, errors, "-") is n["orders_db"]
    assert resolve_owner(None, "a.yaml", index, n["orders"].id, errors, "-") is n["orders"]
    assert errors == []


def test_промахи_пишутся_в_ошибки_с_подсказкой() -> None:
    index, _ = _project()
    errors: list[str] = []
    assert resolve_owner("БД", "a.yaml", index, None, errors, "-") is None
    assert resolve_owner("Хранилище", "b.yaml", index, None, errors, "узлы-БД проекта: X") is None
    assert resolve_owner(None, "c.yaml", index, None, errors, "-") is None
    assert resolve_owner(None, "d.yaml", index, uuid.uuid4(), errors, "-") is None
    assert errors == [
        # Кандидаты — в порядке документа: сиблинги по имени.
        "a.yaml: имя «БД» неоднозначно (Маркетплейс / Биллинг / БД, "
        "Маркетплейс / Сервис заказов / БД) — укажите полный путь",
        "b.yaml: объект «Хранилище» не найден; узлы-БД проекта: X",
        "c.yaml: не указан объект, а окно не сказало, к какому применять",
        "d.yaml: объект окна не найден",
    ]
