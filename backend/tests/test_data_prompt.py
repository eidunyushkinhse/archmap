"""Тесты промпта «Описать структуру» (app/data_prompt.py + GET /data-import/prompt).

Находка №1 полевого QA: промпт не нёс узлов проекта — слабая модель адрес владельца
ВЫДУМЫВАЛА («Zabbix Storage», потом контейнер), и пакет на 203 таблицы блокировался
целиком. Здесь проверяется, что перечень узлов-БД доезжает до текста промпта, а при
единственной базе агенту не остаётся места для выдумки.
"""

import uuid

from conftest import ensure_architect, ensure_project

from app.data_import import NODE_HEADER
from app.data_prompt import build_data_prompt
from app.models.node import Node
from app.routers.data_import import data_prompt


def _node(db, name, shape="database", parent=None):
    n = Node(
        id=uuid.uuid4(),
        name=name,
        shape=shape,
        project_id=ensure_project(db).id,
        parent_id=parent.id if parent is not None else None,
    )
    db.add(n)
    db.flush()
    return n


def test_единственная_база_подставлена_в_пример():
    # Адрес нарочно не похож на образцовый: подстановку видно, подмену — тоже.
    p = build_data_prompt(["Zabbix 7 / mysql"])
    assert "## Куда адресовать" in p
    # Адрес в ОБРАЗЦЕ формата — ровно тот, что есть в проекте: выдумывать нечего.
    assert "# archmap-node: Zabbix 7 / mysql" in p
    assert "Платформа / Хранилище" not in p
    assert "Узел-БД в этом проекте один" in p
    # Потерянная решётка — второй способ промахнуться мимо узла (прогон 9 QA):
    # ключ без «#» становится обычным YAML-ключом, и адрес молча не виден.
    assert "КОММЕНТАРИЕМ" in p and "именно с решёткой" in p


def test_адрес_из_образца_разбирается_нашим_же_парсером():
    """Реальный адрес в образце копируют ДОСЛОВНО — значит, строка обязана извлекаться
    ровно в путь узла. Хвост-пояснение в той же строке уехал бы в адрес и дал бы
    «объект не найден» (та же гарантия, что у образца .mmd в docs_prompt)."""
    m = NODE_HEADER.search(build_data_prompt(["Zabbix 7 / mysql"]))
    assert m is not None and m.group(1) == "Zabbix 7 / mysql"


def test_несколько_баз_перечислены():
    p = build_data_prompt(["Zabbix 7 / mysql", "Zabbix 7 / elasticsearch"])
    assert "Zabbix 7 / mysql" in p and "Zabbix 7 / elasticsearch" in p
    assert "ДОСЛОВНО из этого перечня" in p


def test_без_баз_промпт_велит_сначала_создать_узел():
    p = build_data_prompt([])
    assert "сначала создайте его" in p
    assert "уедут к объекту, со страницы которого открыто окно" in p


def test_эндпоинт_подставляет_узлы_БД_проекта(db):
    система = _node(db, "Zabbix 7", shape="service")
    _node(db, "mysql", parent=система)
    # Контейнер слабая модель уже присылала адресом (прогон 8 QA) — в перечне ему не место.
    _node(db, "zabbix-server", shape="service", parent=система)

    out = data_prompt(db=db, project=ensure_project(db), _=ensure_architect(db))

    # Адрес — ПОЛНЫЙ путь узла: тот же, что понимает резолвер дозаливки.
    assert "Zabbix 7 / mysql" in out.prompt
    assert "zabbix-server" not in out.prompt
    assert "сначала создайте" not in out.prompt
