"""Сторож ДЕМО-ПАКЕТА (демо-проект «Маркетплейс "Ярмарка"») для будущего онбординга.

Пакет — СНИМОК живого эталонного проекта (scripts/refresh-demo-template.py), а не
декларация в коде: протухнуть он способен молча — файл потерялся при обновлении,
семья не доехала, привязки шагов осыпались. Способ старта «Шаблон» убран
2026-09-30, и из API пакет больше не сеется — тест зовёт сидер
(app/demo_package.py) напрямую. Держит он не точные числа (они законно меняются с
каждым снимком), а ИНВАРИАНТЫ демо:

• пакет ввозится начисто — без замечаний и без алертов (демо обязано быть эталоном);
• все семьи фактов на месте и не пусты — иначе демо перестало быть витриной продукта;
• каждый шаг процесса привязан к схеме логики (AL34 по построению ноль);
• жизненный цикл показан: в схеме есть и planned, и deprecated;
• раскладку пакет НЕ везёт (решение Р3, docs/plan-demo-template.md);
• неизвестный пакет не сеется и сирот не оставляет.
"""

import pytest
from conftest import ensure_architect

from app.alerts import compute_alerts
from app.demo_package import DEMO_PACKAGE, seed_package_template
from app.models.broker_channel import BrokerChannel
from app.models.business_process import BusinessProcess
from app.models.config_param import ConfigParam
from app.models.db_table import DbTable
from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.process_message import ProcessMessage
from app.models.project import Project
from app.models.view_layout import ViewLayoutItem

ДЕМО = DEMO_PACKAGE


@pytest.fixture()
def посеянный(db):
    """Проект, посеянный из демо-пакета напрямую сидером (из API он не зовётся)."""
    user = ensure_architect(db)
    project = seed_package_template(db, ДЕМО, "Демо-проект", None, user.id)
    assert project is not None
    db.commit()
    return project


def test_пакет_ввозится_и_даёт_полную_витрину(db, посеянный):
    pid = посеянный.id
    nodes = db.query(Node).filter(Node.project_id == pid).all()
    edges = db.query(Edge).filter(Edge.project_id == pid).count()
    docs = db.query(NodeDoc).join(Node).filter(Node.project_id == pid).count()
    tables = db.query(DbTable).join(Node).filter(Node.project_id == pid).count()
    channels = db.query(BrokerChannel).join(Node).filter(Node.project_id == pid).count()
    params = db.query(ConfigParam).join(Node).filter(Node.project_id == pid).count()
    specs = sum(1 for n in nodes if (n.openapi_spec or "").strip())
    processes = db.query(BusinessProcess).filter(BusinessProcess.project_id == pid).count()

    # Пороги, а не равенства: снимок обновляется, витрина обязана остаться витриной.
    assert len(nodes) >= 30, "демо обмелело: объектов меньше, чем в снимке"
    assert edges >= 30
    assert docs >= 20, "схемы логики не доехали"
    assert specs >= 5, "спеки OpenAPI не доехали"
    assert tables >= 10, "структура БД не доехала"
    assert channels >= 1, "каналы брокера не доехали"
    assert params >= 40, "конфигурация не доехала"
    assert processes >= 3, "бизнес-процессы не доехали"

    # Многоуровневость: у демо есть внуки (не плоский список корней).
    by_id = {n.id: n for n in nodes}
    depths = {n.id: 0 for n in nodes}
    for n in nodes:
        d, cur = 0, n
        while cur.parent_id is not None and cur.parent_id in by_id:
            cur = by_id[cur.parent_id]
            d += 1
        depths[n.id] = d
    assert max(depths.values()) >= 2, "демо стало плоским — уровней меньше трёх"

    # Жизненный цикл объекта показан обоими необычными статусами (решение Р1).
    statuses = {n.status for n in nodes}
    assert "planned" in statuses and "deprecated" in statuses
    # Якорь источника — тоже часть витрины.
    assert any(n.source_ref for n in nodes)


def test_каждый_шаг_процесса_привязан_к_схеме(db, посеянный):
    шаги = (
        db.query(ProcessMessage)
        .join(BusinessProcess)
        .filter(BusinessProcess.project_id == посеянный.id)
        .all()
    )
    assert шаги, "процессы приехали без шагов"
    без_привязки = [m for m in шаги if m.doc_id is None]
    assert not без_привязки, f"шагов без схемы логики: {len(без_привязки)} из {len(шаги)}"


def test_алертов_ноль(db, посеянный):
    alerts = compute_alerts(db, посеянный.id).model_dump()
    непустые = {k: len(v) for k, v in alerts.items() if isinstance(v, list) and v}
    assert not непустые, f"демо-шаблон приехал с алертами: {непустые}"


def test_раскладку_пакет_не_везёт(db, посеянный):
    """Решение Р3: демо ведёт себя как импорт — раскладку строит движок."""
    assert db.query(ViewLayoutItem).filter(ViewLayoutItem.project_id == посеянный.id).count() == 0


def test_сидер_создаёт_проект_с_описанием_из_манифеста(db):
    user = ensure_architect(db)
    проект = seed_package_template(db, ДЕМО, "Из демо-пакета", None, user.id)
    assert проект is not None
    db.commit()
    assert проект.name == "Из демо-пакета"
    # Описание подставляется из манифеста пакета, если его не задали.
    assert проект.description
    assert db.query(Node).filter(Node.project_id == проект.id).count() >= 30
    assert db.query(BusinessProcess).filter(BusinessProcess.project_id == проект.id).count() >= 3


def test_неизвестный_пакет_не_сеется_и_сирот_нет(db):
    """Сидер создаёт проект сам — на неизвестный пакет он не заводит ничего."""
    user = ensure_architect(db)
    было = db.query(Project).count()
    assert seed_package_template(db, "нет-такого", "X", None, user.id) is None
    db.commit()
    assert db.query(Project).count() == было
    assert db.query(BusinessProcess).count() == 0
