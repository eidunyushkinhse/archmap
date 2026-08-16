"""Сборка снимка удаляемого поддерева и восстановление из снимка (Undo удаления).

Снимок (build_deletion_snapshot) собирается ДО удаления и повторяет ровно то, что
исчезнет: поддерево узлов, ВСЯ их документация (схемы логики, таблицы БД с колонками,
каналы брокера с полями — всё это умирает БД-каскадом), инцидентные рёбра
(источник/цель в поддереве) и строки раскладки view_layout — свои виды поддерева
(умрут каскадом view_id) плюс строки других видов, чьи ключи ссылаются на поддерево
(их чистит delete_node). Восстановление (restore_from_snapshot) воссоздаёт всё это
С СОХРАНЕНИЕМ исходных id, чтобы вернувшиеся сущности были теми же самыми (ссылки
извне, история, redo=повторное удаление по id).

Строки собираются и воссоздаются НЕ ручным перечнем полей: снимок валидируется из
модели (from_attributes), а обратно строка собирается из полей снимка целиком
(model_dump). Ручной перечень — тот самый механизм, из-за которого снимок отстал от
модели (потерянный source_ref) и вовсе не заметил новых таблиц; полноту сторожат
тесты по реестру SNAPSHOT_PLAN ниже и декларации app/copy_plan.py.
"""

import uuid

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app import tree
from app.database import Base
from app.models.broker_channel import BrokerChannel
from app.models.business_process import BusinessProcess
from app.models.channel_field import ChannelField
from app.models.db_column import DbColumn
from app.models.db_table import DbTable
from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.view_layout import ViewLayoutItem
from app.models.view_state import ViewState
from app.schemas.restore import (
    BrokerChannelSnapshot,
    ChannelFieldSnapshot,
    DbColumnSnapshot,
    DbTableSnapshot,
    DeletionSnapshot,
    EdgeSnapshot,
    NodeDocSnapshot,
    NodeSnapshot,
    ViewLayoutItemSnapshot,
)

# Что снимок обязан нести: модель → её схема-снимок. Реестр нужен сторожу (см.
# tests/test_restore.py): удаление узла сносит каскадом ВСЁ, что на него завязано,
# и новая такая таблица обязана споткнуться о гейт, а не о пользователя, у которого
# Ctrl+Z вернёт узел без документации.
SNAPSHOT_PLAN: dict[type[Base], type] = {
    Node: NodeSnapshot,
    Edge: EdgeSnapshot,
    NodeDoc: NodeDocSnapshot,
    DbTable: DbTableSnapshot,
    DbColumn: DbColumnSnapshot,
    BrokerChannel: BrokerChannelSnapshot,
    ChannelField: ChannelFieldSnapshot,
    ViewLayoutItem: ViewLayoutItemSnapshot,
}

# Каскадные потомки узла, которых снимок НЕ несёт — с причиной словами.
NOT_IN_SNAPSHOT: dict[type[Base], str] = {
    ViewState: (
        "версия вида — fence конкурентных записей раскладки, а не данные: отсутствие "
        "строки трактуется как версия 0, и вернувшийся вид получает свежий счётчик "
        "первым же bump_view_version. Возвращать старое число не только не нужно, но и "
        "вредно: сессия с устаревшим base_version обязана получить 409 и перечитать "
        "уровень (та же причина, по которой ViewState не копирует копия проекта)"
    ),
    BusinessProcess: (
        "процесс, у которого удаляемый узел задан ОБЛАСТЬЮ, сносится каскадом "
        "scope_node_id вместе со всеми участниками, шагами и фрагментами, и откат его "
        "не вернёт. Это известный дефект (docs/plan-process-docs-challenge.md, П8): он "
        "латентен — задать область процесса сегодня нечем, — и чинится не снимком, а "
        "самим FK. Дети процесса сюда не перечисляются: они уезжают вместе с ним"
    ),
}


def build_deletion_snapshot(db: Session, root_id: uuid.UUID) -> DeletionSnapshot:
    """Снимок всего, что исчезнет при удалении узла root_id (вызывать ДО delete)."""
    subtree = tree.collect_subtree_ids_db(db, root_id)

    nodes = db.query(Node).filter(Node.id.in_(subtree)).all()
    # Рёбра с любым концом в поддереве — их снесёт каскад (source_id/target_id CASCADE).
    edges = (
        db.query(Edge)
        .filter(or_(Edge.source_id.in_(subtree), Edge.target_id.in_(subtree)))
        .all()
    )

    # Строки раскладки: виды поддерева (каскад view_id) + строки любых видов, чей
    # item_id содержит uuid из поддерева (гостевые позиции/пучки — их чистит delete_node).
    layout_rows = (
        db.query(ViewLayoutItem)
        .filter(
            or_(
                ViewLayoutItem.view_id.in_(subtree),
                *[ViewLayoutItem.item_id.like(f"%{sid}%") for sid in subtree],
            )
        )
        .all()
    )

    # Документация узлов поддерева — умрёт БД-каскадом вместе с ними. Схемы логики
    # висят на узле, а колонки и поля — на таблице/канале: их берём вторым шагом,
    # иначе фильтровать было бы нечем.
    docs = db.query(NodeDoc).filter(NodeDoc.node_id.in_(subtree)).all()
    tables = db.query(DbTable).filter(DbTable.node_id.in_(subtree)).all()
    table_ids = [t.id for t in tables]
    columns = (
        db.query(DbColumn).filter(DbColumn.table_id.in_(table_ids)).all() if table_ids else []
    )
    channels = db.query(BrokerChannel).filter(BrokerChannel.node_id.in_(subtree)).all()
    channel_ids = [c.id for c in channels]
    fields = (
        db.query(ChannelField).filter(ChannelField.channel_id.in_(channel_ids)).all()
        if channel_ids
        else []
    )

    return DeletionSnapshot(
        nodes=[NodeSnapshot.model_validate(n) for n in nodes],
        edges=[EdgeSnapshot.model_validate(e) for e in edges],
        layout_items=[ViewLayoutItemSnapshot.model_validate(r) for r in layout_rows],
        node_docs=[NodeDocSnapshot.model_validate(d) for d in docs],
        db_tables=[DbTableSnapshot.model_validate(t) for t in tables],
        db_columns=[DbColumnSnapshot.model_validate(c) for c in columns],
        broker_channels=[BrokerChannelSnapshot.model_validate(c) for c in channels],
        channel_fields=[ChannelFieldSnapshot.model_validate(f) for f in fields],
    )


def build_edge_deletion_snapshot(db: Session, edge_id: uuid.UUID) -> DeletionSnapshot:
    """Снимок одной связи (Undo удаления/создания связи).

    Строки раскладки удаление связи НЕ сносит (геометрия живёт на ключе ПУЧКА и
    обслуживает всех его членов — R3), поэтому снимок несёт только само ребро.
    Восстанавливается тем же restore_from_snapshot (nodes=[]) с исходным id.
    """
    edge = db.get(Edge, edge_id)
    return DeletionSnapshot(
        nodes=[],
        edges=[EdgeSnapshot.model_validate(edge)] if edge is not None else [],
        layout_items=[],
    )


def restore_from_snapshot(
    db: Session, snapshot: DeletionSnapshot, project_id: uuid.UUID
) -> None:
    """Воссоздать узлы, их документацию, рёбра и строки раскладки из снимка с
    сохранением исходных id.

    Узлы вставляются родителями раньше детей: FK parent_id проверяется сразу, а
    корень поддерева ссылается на уцелевший (внешний) узел уровня. Документация,
    рёбра и раскладка — после узлов (их FK на nodes уже валидны). project_id —
    проект, в который восстанавливаем (снимок его не несёт; восстановление всегда в
    текущий проект).

    Строки собираются из ПОЛЕЙ СНИМКА целиком (model_dump), а не перечнем: поле,
    добавленное в снимок, доезжает до строки само.
    """
    by_id = {n.id: n for n in snapshot.nodes}

    def depth(n: NodeSnapshot) -> int:
        d = 0
        cur = n
        while cur.parent_id is not None and cur.parent_id in by_id:
            cur = by_id[cur.parent_id]
            d += 1
        return d

    for ns in sorted(snapshot.nodes, key=depth):
        db.add(Node(**ns.model_dump(), project_id=project_id))
    db.flush()  # узлы существуют до рёбер/раскладки/документации

    # Схемы логики — с исходными id (redo-удаление и внешние ссылки работают по id)
    for ds in snapshot.node_docs:
        db.add(NodeDoc(**ds.model_dump()))

    # Структура БД: таблицы до колонок (FK table_id).
    for ts in snapshot.db_tables:
        db.add(DbTable(**ts.model_dump()))
    db.flush()
    _restore_db_columns(db, snapshot)

    # Структура брокера: каналы до полей (FK channel_id).
    for cs in snapshot.broker_channels:
        db.add(BrokerChannel(**cs.model_dump()))
    db.flush()
    for fs in snapshot.channel_fields:
        db.add(ChannelField(**fs.model_dump()))

    for es in snapshot.edges:
        db.add(Edge(**es.model_dump(), project_id=project_id))
    db.flush()

    # Строки раскладки: удаление их вычистило (каскад/явная чистка), коллизий нет.
    for it in snapshot.layout_items:
        db.add(ViewLayoutItem(**it.model_dump(), project_id=project_id))

    db.commit()


def _restore_db_columns(db: Session, snapshot: DeletionSnapshot) -> None:
    """Колонки таблиц — В ДВА ПРОХОДА из-за ссылки колонка→колонка.

    references_column_id — внешний ключ КАРТЫ (ER-связь): его цель лежит в другой
    таблице и в снимке может стоять ПОСЛЕ ссылающейся колонки, а FK проверяется сразу
    на вставке. Поэтому сначала вставляем все колонки без ссылок, потом проставляем
    ссылки. Цель, исчезнувшую вне снимка (её таблицу успели удалить отдельно), гасим —
    ровно так же, как это сделал бы ON DELETE SET NULL самой БД.
    """
    for cs in snapshot.db_columns:
        db.add(DbColumn(**cs.model_dump(exclude={"references_column_id"})))
    db.flush()
    refs = {cs.id: cs.references_column_id for cs in snapshot.db_columns if cs.references_column_id}
    if not refs:
        return
    restored = {cs.id for cs in snapshot.db_columns}
    outside = {target for target in refs.values() if target not in restored}
    alive = (
        {c for (c,) in db.query(DbColumn.id).filter(DbColumn.id.in_(outside)).all()}
        if outside
        else set()
    )
    for column_id, target in refs.items():
        if target in restored or target in alive:
            column = db.get(DbColumn, column_id)
            if column is not None:
                column.references_column_id = target
    db.flush()
