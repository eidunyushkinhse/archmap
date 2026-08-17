"""Сторож отложенного тела схемы логики (Р37/Р38): считает SQL-запросы, а не рассуждает.

Тело схемы (NodeDoc.content) — отложенная колонка: графовая выдача узлов отдаёт
лёгкую мету (NodeDocMeta без content), и тянуть ради неё двести mermaid монолита
незачем. Опасность правки в том, что она НЕ ЛОМАЕТСЯ ВИДИМО: забытый undefer даёт
не ошибку, а тихий N+1 — код работает, обычные тесты зелёные, а на живых данных
запросов становится по одному на схему.

Поэтому здесь два вида проверок, и обе — счётные:
  • графовая выдача НЕ содержит тела ни в одном SELECT (было — содержала);
  • число запросов в местах, где тела НУЖНЫ, не зависит от числа схем. Именно это
    и значит «undefer поставлен»: константа при 3 схемах и при 30 — одна и та же.

Второе сильнее первого: оно ловит забытый undefer в любом месте карты, не привязываясь
к конкретному числу запросов (константа меняется от рефакторинга, зависимость от N — нет).
"""

import re
import uuid
from contextlib import contextmanager

from conftest import ensure_architect
from sqlalchemy import event
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.orm import sessionmaker

from app.alerts import compute_alerts
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.project import Project
from app.projects import copy_project_schema
from app.recon_import import build_recon_plan
from app.restore import build_deletion_snapshot
from app.routers.docs_import import docs_import_preview
from app.routers.node_docs import list_docs
from app.schemas.docs_import import DocsFileIn, DocsImportIn
from app.schemas.node import NodeResponse

# «Тело едет в этом SELECT-е». Выражение признака described — length(trim(content)) —
# телом НЕ является: оно считается в БД и возвращает булево, а не текст схемы.
BODY_COL = re.compile(r"(?<!trim\()node_docs\.content")

# Тело крупное намеренно: смысл правки — не тащить килобайты, и стенд должен быть
# похож на монолит, а не на проект с тремя строчками.
BODY = "flowchart TD\n" + "\n".join(f'  A{i} --> B{i}["шаг {i}"]' for i in range(80))


class Counter:
    """Снятые запросы: сколько всего и в скольких едет тело схемы."""

    def __init__(self) -> None:
        self.stmts: list[str] = []

    @property
    def n(self) -> int:
        return len(self.stmts)

    @property
    def with_body(self) -> int:
        return sum(1 for s in self.stmts if BODY_COL.search(s))


@contextmanager
def capture(engine):
    c = Counter()

    def _hook(conn, cursor, statement, params, context, executemany):
        c.stmts.append(statement)

    event.listen(engine, "before_cursor_execute", _hook)
    try:
        yield c
    finally:
        event.remove(engine, "before_cursor_execute", _hook)


def seed(db, title: str, docs_count: int) -> tuple[Project, Node]:
    """Проект с одним сервисом и docs_count схемами (нечётные — заглушки)."""
    p = Project(id=uuid.uuid4(), name=title)
    db.add(p)
    root = Node(id=uuid.uuid4(), name=title, project_id=p.id)
    db.add(root)
    node = Node(id=uuid.uuid4(), name="backend", project_id=p.id, parent_id=root.id)
    db.add(node)
    db.flush()
    for i in range(docs_count):
        db.add(
            NodeDoc(
                id=uuid.uuid4(),
                node_id=node.id,
                name=f"GET /res{i}",
                kind="operation",
                operation=f"GET /res{i}",
                content="" if i % 2 else BODY,
            )
        )
    ensure_architect(db)
    db.commit()
    return p, node


def measure(db, scenario, docs_count: int) -> Counter:
    """Прогнать сценарий на СВЕЖЕЙ сессии (без прогретой identity map) и посчитать запросы.

    Сессия своя, а не фикстурная: половина мест читает объекты, уже загруженные
    выборкой узлов, и на прогретой карте identity замер показал бы не то, что
    происходит в живом запросе.
    """
    engine = db.get_bind()
    s = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    try:
        run = scenario(s, docs_count)  # подготовка (сид, поиск объектов) — вне замера
        with capture(engine) as c:
            run()
        s.rollback()
        return c
    finally:
        s.close()


# ── сценарии: (сессия, число схем) → замыкание, которое и меряется ────────────


def _graph_output(s, k):
    p, _node = seed(s, f"graph-{k}", k)

    def run():
        nodes = s.query(Node).filter(Node.project_id == p.id).all()
        return [NodeResponse.model_validate(n, from_attributes=True) for n in nodes]

    return run


def _list_docs(s, k):
    p, node = seed(s, f"list-{k}", k)
    user = ensure_architect(s)

    def run():
        return [d.content for d in list_docs(node.id, db=s, project=p, _=user)]

    return run


def _docs_import_preview(s, k):
    p, _node = seed(s, f"import-{k}", k)
    user = ensure_architect(s)
    payload = DocsImportIn(
        files=[
            DocsFileIn(
                name=f"res{i}.mmd",
                content=(
                    f"%% archmap-name: GET /res{i}\n"
                    "%% archmap-kind: operation\n"
                    f"%% archmap-operation: GET /res{i}\n"
                    "%% archmap-node: backend\n" + BODY
                ),
            )
            for i in range(k)
        ],
        only="logic",
    )

    def run():
        return docs_import_preview(payload, db=s, project=p, _=user)

    return run


def _deletion_snapshot(s, k):
    _p, node = seed(s, f"snap-{k}", k)

    def run():
        return build_deletion_snapshot(s, node.id)

    return run


def _copy_project(s, k):
    p, _node = seed(s, f"copy-{k}", k)
    dst = Project(id=uuid.uuid4(), name=f"copy-{k}-dst")
    s.add(dst)
    s.flush()

    def run():
        copy_project_schema(s, p.id, dst.id)

    return run


def _recon_plan(s, k):
    p, node = seed(s, f"recon-{k}", k)
    файл = (
        "# archmap-recon\nnode: backend\noperations:\n"
        + "\n".join(f"  - GET /res{i}" for i in range(k))
        + "\n"
    )

    def run():
        nodes = s.query(Node).filter(Node.project_id == p.id).all()
        return build_recon_plan(s, nodes, [("archmap-recon.yaml", файл)], node.id)

    return run


def _alerts(s, k):
    p, _node = seed(s, f"alerts-{k}", k)

    def run():
        return compute_alerts(s, p.id)

    return run


# ── проверки ─────────────────────────────────────────────────────────────────

МАЛО, МНОГО = 3, 30


def test_графовая_выдача_не_везёт_тела_схем(db):
    """Р37: выборка узлов проекта не читает ни одного mermaid.

    Сердце правки: NodeResponse.docs — это NodeDocMeta, content там нет вовсе, и
    до правки каждая выборка узлов монолита тянула две сотни текстов, чтобы их
    тут же выбросить.
    """
    c = measure(db, _graph_output, МНОГО)
    assert c.with_body == 0, "в графовой выдаче узлов не должно быть ни одного тела схемы"


def test_графовая_выдача_не_плодит_запросы(db):
    """selectin остался одним запросом на выборку: отложенная колонка не должна
    превратить его в запрос на схему."""
    мало = measure(db, _graph_output, МАЛО)
    много = measure(db, _graph_output, МНОГО)
    assert мало.n == много.n, f"выдача узлов зависит от числа схем: {мало.n} → {много.n}"


def test_признак_описанности_верен_без_загруженного_тела(db):
    """Р38: described считается выражением в БД и не зависит от того, загружено тело.

    Ровно то, ради чего он и делался столбцовым выражением, а не свойством Python:
    витрина обязана отличать ЗАГЛУШКУ разведки от готовой схемы, не читая mermaid.
    """
    p, _node = seed(db, "признак", 6)  # 0,2,4 — описаны; 1,3,5 — заглушки
    db.expire_all()
    nodes = db.query(Node).filter(Node.project_id == p.id).all()
    docs = sorted((d for n in nodes for d in n.docs), key=lambda d: d.name)

    assert [d.described for d in docs] == [True, False, True, False, True, False]
    # …и при этом ни одно тело не загружено
    assert all("content" in sa_inspect(d).unloaded for d in docs)
    # тело по-прежнему доступно (отложенное — не значит потерянное)
    assert docs[0].content == BODY
    assert docs[1].content == ""


def test_тела_нужны_но_запросов_не_больше_чем_без_них(db):
    """Главный сторож: там, где тела НУЖНЫ, число запросов не растёт по числу схем.

    Забытый undefer виден только здесь: он не ошибка и не расхождение в данных, а
    лишний запрос на каждую схему. Сравниваем 3 схемы против 30 — константа обязана
    совпасть до запроса.
    """
    сценарии = {
        "GET /nodes/{id}/docs": _list_docs,
        "POST /docs-import/preview": _docs_import_preview,
        "снимок удаления (undo)": _deletion_snapshot,
        "копия проекта": _copy_project,
        "план разведки": _recon_plan,
        "алерты": _alerts,
    }
    for имя, сценарий in сценарии.items():
        мало = measure(db, сценарий, МАЛО)
        много = measure(db, сценарий, МНОГО)
        assert мало.n == много.n, (
            f"{имя}: запросов {мало.n} при {МАЛО} схемах и {много.n} при {МНОГО} — "
            f"это N+1, где-то забыт undefer(NodeDoc.content)"
        )
        # …и тела едут одним SELECT-ом, а не по одному на схему
        assert много.with_body <= 1, f"{имя}: тела схем едут {много.with_body} запросами"


def test_план_разведки_обходится_без_тел(db):
    """Разведке нужен булев ответ «описана?», а не текст: тела она не читает вовсе."""
    c = measure(db, _recon_plan, МНОГО)
    assert c.with_body == 0, "разведке тела схем не нужны — ей хватает признака described"
