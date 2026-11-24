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
• раскладку архив пакета НЕ везёт (решение Р3, docs/archive/plan-demo-template.md); своя
  расстановка пакета (layout.yaml, раунд 5 обучения) ложится посевом строками раскладки
  ЭТОГО проекта, объекта нет — позиция пропускается, битый файл посев не роняет;
• неизвестный пакет не сеется и сирот не оставляет;
• тип записан у каждого объекта с вложенными: разбор пакета не отказывает, и спора о
  типе (элементе архитектуры) превью не задаёт.
"""

import io
import zipfile

import pytest
from conftest import ensure_architect

from app import demo_package
from app.alerts import compute_alerts
from app.demo_package import (
    DEMO_PACKAGE,
    LAYOUT_FILE,
    LayoutPos,
    _package_zip,
    parse_layout,
    read_layout,
    seed_package_template,
)
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
from app.unified_import import build_unified_plan
from app.unified_remarks import remainder_from_plan

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
    assert specs >= 5, "спецификации OpenAPI не доехали"
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


def _пути(db, pid) -> dict:
    """id объекта проекта → путь «Корень / … / Имя»."""
    узлы = {n.id: n for n in db.query(Node).filter(Node.project_id == pid)}

    def путь(n):
        части = [n.name]
        while n.parent_id is not None:
            n = узлы[n.parent_id]
            части.append(n.name)
        return " / ".join(reversed(части))

    return {str(i): путь(n) for i, n in узлы.items()}


def _раскладка(db, pid) -> dict:
    """(путь вида | None, путь объекта) → payload строк раскладки проекта."""
    пути = _пути(db, pid)
    return {
        (пути[str(r.view_id)] if r.view_id else None, пути[r.item_id]): r.payload
        for r in db.query(ViewLayoutItem).filter(ViewLayoutItem.project_id == pid)
    }


СИСТЕМА = "Маркетплейс «Ярмарка»"
ЗАКАЗЫ = "Маркетплейс «Ярмарка» / Заказы"


def test_посев_кладёт_расстановку_корня_и_двух_уровней(db, посеянный):
    """Раунд 5 обучения: главная демо читается — объекты стоят, как их расставили руками."""
    раскладка = _раскладка(db, посеянный.id)
    виды = {вид for вид, _ in раскладка}
    assert виды == {None, СИСТЕМА, ЗАКАЗЫ}
    # Корень: система в центре, вокруг действующие лица и внешние системы.
    assert раскладка[(None, СИСТЕМА)] == {"x": 460, "y": 0}
    assert раскладка[(None, "Продавец")] == {"x": 0, "y": 0}
    assert раскладка[(None, "Покупатель")] == {"x": 920, "y": 0}
    # Уровень системы: свои объекты и объекты с других уровней (гости).
    assert раскладка[(СИСТЕМА, ЗАКАЗЫ)] == {"x": 360, "y": 1164}
    assert раскладка[(СИСТЕМА, "Покупатель")] == {"x": 672, "y": 30}
    # Уровень «Заказы»: вложенные и соседи.
    assert раскладка[(ЗАКАЗЫ, ЗАКАЗЫ + " / Оркестратор заказа")] == {"x": 371, "y": 408}
    assert раскладка[(ЗАКАЗЫ, "Служба доставки")] == {"x": 30, "y": 1006}
    # Только координаты: раскрытие файл не задаёт, ключей «Развёртывания» нет.
    assert all(set(p) == {"x", "y"} for p in раскладка.values())
    assert len(раскладка) == len(demo_package._package_layout(ДЕМО))


def test_расстановка_не_едет_в_архив_пакета():
    """Архив знания раскладку не возит (Р3): zip пакета — ровно файлы архива."""
    имена = zipfile.ZipFile(io.BytesIO(_package_zip(ДЕМО))).namelist()
    assert LAYOUT_FILE not in имена
    assert "manifest.yaml" in имена


def test_отсутствующий_объект_и_вид_пропускаются(db, monkeypatch):
    """Пакет и файл расстановки могут разойтись: чего нет в проекте, то пропускается."""
    свои = (
        LayoutPos(None, "Продавец", 1.5, 2.5),
        LayoutPos(None, "Нет такого объекта", 10, 10),
        LayoutPos("Нет такого вида", "Продавец", 20, 20),
        LayoutPos(СИСТЕМА, "Маркетплейс «Ярмарка» / Нет такого", 30, 30),
    )
    monkeypatch.setattr(demo_package, "_package_layout", lambda _pid: свои)
    user = ensure_architect(db)
    проект = seed_package_template(db, ДЕМО, "Демо", None, user.id)
    assert проект is not None
    db.commit()
    assert _раскладка(db, проект.id) == {(None, "Продавец"): {"x": 1.5, "y": 2.5}}


def test_строк_чужого_проекта_не_появляется(db):
    """Две песочницы: строки каждой ссылаются только на свои объекты, первая не тронута."""
    user = ensure_architect(db)
    первый = seed_package_template(db, ДЕМО, "Первый", None, user.id)
    db.commit()
    assert первый is not None
    было = sorted((str(r.view_id), r.item_id) for r in
                  db.query(ViewLayoutItem).filter(ViewLayoutItem.project_id == первый.id))
    второй = seed_package_template(db, ДЕМО, "Второй", None, user.id)
    db.commit()
    assert второй is not None
    for проект in (первый, второй):
        свои = {str(n.id) for n in db.query(Node).filter(Node.project_id == проект.id)}
        строки = db.query(ViewLayoutItem).filter(ViewLayoutItem.project_id == проект.id).all()
        assert строки
        assert all(r.item_id in свои for r in строки)
        assert all(r.view_id is None or str(r.view_id) in свои for r in строки)
    стало = sorted((str(r.view_id), r.item_id) for r in
                   db.query(ViewLayoutItem).filter(ViewLayoutItem.project_id == первый.id))
    assert стало == было


@pytest.mark.parametrize(
    "текст",
    ["views: [", "просто строка", "views: 5", "views:\n- view: 3\n  items: {a: {x: 1, y: 2}}",
     "views:\n- view: null\n  items: {a: {x: true, y: 2}, b: {x: .inf, y: 1}, c: 7}"],
)
def test_битая_расстановка_пуста(текст):
    assert parse_layout(текст) == []


def test_нет_файла_нет_расстановки(tmp_path):
    assert read_layout(tmp_path / LAYOUT_FILE) == []
    (tmp_path / LAYOUT_FILE).write_bytes(b"\xff\xfe\x00")
    assert read_layout(tmp_path / LAYOUT_FILE) == []


def test_битый_файл_не_роняет_посев(db, monkeypatch):
    monkeypatch.setattr(demo_package, "_package_layout", lambda _pid: tuple(parse_layout("views: [")))
    user = ensure_architect(db)
    проект = seed_package_template(db, ДЕМО, "Демо", None, user.id)
    assert проект is not None
    db.commit()
    assert db.query(ViewLayoutItem).filter(ViewLayoutItem.project_id == проект.id).count() == 0
    assert db.query(Node).filter(Node.project_id == проект.id).count() >= 30


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


def test_пакет_демо_ввозится_без_вопросов_о_типе():
    """Тип выбран всегда (docs/tasks/type-always.md): у каждого объекта пакета с вложенными
    тип записан — разбор не отказывает, и спора о типе превью не задаёт."""
    план = build_unified_plan([(f"{ДЕМО}.zip", _package_zip(ДЕМО))])
    assert план.ok, план.errors
    assert [c for c in remainder_from_plan(план).field_conflicts if c.field == "element"] == []
