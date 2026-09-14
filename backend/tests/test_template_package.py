"""Сторож ПАКЕТНОГО шаблона (демо-проект «Маркетплейс "Ярмарка"»).

Пакет — СНИМОК живого эталонного проекта (scripts/refresh-demo-template.py), а не
декларация в коде: протухнуть он способен молча — файл потерялся при обновлении,
семья не доехала, привязки шагов осыпались. Тест держит не точные числа (они
законно меняются с каждым снимком), а ИНВАРИАНТЫ витрины:

• пакет ввозится начисто — без замечаний и без алертов (демо обязано быть эталоном);
• все семьи фактов на месте и не пусты — иначе шаблон перестал быть витриной;
• каждый шаг процесса привязан к схеме логики (AL34 по построению ноль);
• жизненный цикл показан: в схеме есть и planned, и deprecated;
• раскладку пакет НЕ везёт (решение Р3, docs/plan-demo-template.md);
• каталог витрины собирается из самого пакета и совпадает с его корнями.
"""

import uuid

import pytest
from conftest import ensure_architect
from fastapi import HTTPException

from app.alerts import compute_alerts
from app.models.broker_channel import BrokerChannel
from app.models.business_process import BusinessProcess
from app.models.config_param import ConfigParam
from app.models.db_table import DbTable
from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.process_message import ProcessMessage
from app.models.view_layout import ViewLayoutItem
from app.routers.projects import create_project
from app.schemas.project import ProjectCreate
from app.templates import (
    is_package_template,
    list_templates,
    package_ids,
    seed_package_template,
)

ДЕМО = "demo-marketplace"


@pytest.fixture()
def посеянный(db):
    """Проект, созданный из пакетного шаблона (тот же путь, что у роутера)."""
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


def test_каталог_витрины_совпадает_с_пакетом(db, посеянный):
    записи = {t["id"]: t for t in list_templates()}
    assert ДЕМО in записи, "пакетный шаблон пропал из витрины"
    демо = записи[ДЕМО]
    assert демо["name"] and демо["tagline"] and демо["blurb"] and демо["techs"]

    # Превью — корни пакета: те же имена, что у корней посеянного проекта.
    корни_проекта = {
        n.name for n in db.query(Node).filter(Node.project_id == посеянный.id, Node.parent_id.is_(None))
    }
    assert {n["name"] for n in демо["nodes"]} == корни_проекта
    # Координат у пакетного шаблона нет — их считает фронт тем же ELK, что холст.
    assert all(n["x"] is None and n["y"] is None for n in демо["nodes"])
    ключи = {n["key"] for n in демо["nodes"]}
    assert all(e["source"] in ключи and e["target"] in ключи for e in демо["edges"])
    assert демо["edges"], "превью осталось без связей"


def test_каркасы_витрины_целы():
    """Пакетный шаблон не вытеснил каркасы и не сломал их контракт."""
    записи = list_templates()
    каркасы = [t for t in записи if t["id"] not in package_ids()]
    assert len(каркасы) == 6
    assert all(n["x"] is not None and n["y"] is not None for t in каркасы for n in t["nodes"])
    # Пакетные — последние в списке (решение Р2: рядовой седьмой пункт).
    assert записи[-1]["id"] in package_ids()


def test_роутер_создаёт_проект_пакетным_шаблоном(db):
    user = ensure_architect(db)
    ответ = create_project(
        ProjectCreate(name="Из демо-шаблона", start=f"template:{ДЕМО}"), db=db, user=user
    )
    assert ответ.name == "Из демо-шаблона"
    assert ответ.object_count >= 30 and ответ.edge_count >= 30
    # Описание пакетный шаблон подставляет из манифеста, если пользователь его не задал.
    assert ответ.description
    assert db.query(BusinessProcess).filter(BusinessProcess.project_id == ответ.id).count() >= 3


def test_неизвестный_шаблон_даёт_404(db):
    user = ensure_architect(db)
    assert not is_package_template("нет-такого")
    with pytest.raises(HTTPException) as e:
        create_project(ProjectCreate(name="X", start="template:нет-такого"), db=db, user=user)
    assert e.value.status_code == 404
    # Сирота не остаётся: проект не создаётся вовсе.
    assert db.query(BusinessProcess).count() == 0


def test_сироты_после_отказа_нет(db):
    """Пакетный шаблон создаёт проект сам — при отказе в БД не должно остаться пусто-проекта."""
    from app.models.project import Project

    user = ensure_architect(db)
    было = db.query(Project).count()
    with pytest.raises(HTTPException):
        create_project(ProjectCreate(name="X", start="template:нет-такого"), db=db, user=user)
    db.rollback()
    assert db.query(Project).count() == было
    assert uuid.UUID(str(user.id))
