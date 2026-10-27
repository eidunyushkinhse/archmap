"""Сборка снимка удаляемого поддерева и восстановление из снимка (Undo удаления).

Снимок (build_deletion_snapshot) собирается ДО удаления и повторяет ровно то, что
исчезнет: поддерево узлов, ВСЯ их документация (схемы логики, таблицы БД с колонками,
каналы брокера с полями, параметры конфигурации — всё это умирает БД-каскадом),
экземпляры развёртывания (тоже каскадом; сами площадки не трогаются), инцидентные рёбра
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
from dataclasses import dataclass

from sqlalchemy import or_
from sqlalchemy.orm import Session, undefer

from app import tree
from app.database import Base
from app.models.broker_channel import BrokerChannel
from app.models.channel_field import ChannelField
from app.models.config_param import ConfigParam
from app.models.db_column import DbColumn
from app.models.db_table import DbTable
from app.models.deployment_instance import DeploymentInstance
from app.models.deployment_site import DeploymentSite
from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.node_version import NodeVersion
from app.models.view_layout import ViewLayoutItem
from app.models.view_state import ViewState
from app.schemas.restore import (
    BrokerChannelSnapshot,
    ChannelFieldSnapshot,
    ConfigParamSnapshot,
    DbColumnSnapshot,
    DbTableSnapshot,
    DeletionSnapshot,
    DeploymentInstanceSnapshot,
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
    ConfigParam: ConfigParamSnapshot,
    DeploymentInstance: DeploymentInstanceSnapshot,
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
    NodeVersion: (
        "история версий документации удалённого объекта уходит вместе с ним (каскад "
        "node_id), и Undo удаления возвращает объект без истории. Документация объекта "
        "при этом не теряется: её хранят срезы его контейнера и корня проекта"
    ),
}


@dataclass
class SubtreeDocs:
    """Документация узлов поддерева строками снимка: схемы логики с текстом, таблицы с
    колонками, каналы с полями, параметры конфигурации, экземпляры развёртывания. Одна
    выборка на два снимка — удаления (умрёт каскадом вместе с узлами) и версии
    документации (app/versions_snapshot): новая семья фактов добавляется здесь один раз.
    Экземпляры — свои, унаследованное размещение производное и не снимается
    (docs/tasks/deployment-view.md)."""

    node_docs: list[NodeDocSnapshot]
    db_tables: list[DbTableSnapshot]
    db_columns: list[DbColumnSnapshot]
    broker_channels: list[BrokerChannelSnapshot]
    channel_fields: list[ChannelFieldSnapshot]
    config_params: list[ConfigParamSnapshot]
    instances: list[DeploymentInstanceSnapshot]


def collect_subtree_docs(db: Session, subtree: set[uuid.UUID]) -> SubtreeDocs:
    """Вся документация узлов subtree — пачками по поддереву, без запроса на узел.

    Схемы логики висят на узле, а колонки и поля — на таблице/канале: их берём вторым
    шагом, иначе фильтровать было бы нечем.
    """
    # undefer: снимок обязан унести ТЕКСТ схемы — иначе Undo вернул бы пустые тела.
    # Тело отложено (см. NodeDoc.content), и без явного запроса оно приехало бы
    # по одному запросу на схему.
    docs = (
        db.query(NodeDoc)
        .options(undefer(NodeDoc.content))
        .filter(NodeDoc.node_id.in_(subtree))
        .all()
    )
    tables = db.query(DbTable).filter(DbTable.node_id.in_(subtree)).all()
    table_ids = [t.id for t in tables]
    columns = (
        db.query(DbColumn).filter(DbColumn.table_id.in_(table_ids)).all() if table_ids else []
    )
    params = db.query(ConfigParam).filter(ConfigParam.node_id.in_(subtree)).all()
    channels = db.query(BrokerChannel).filter(BrokerChannel.node_id.in_(subtree)).all()
    channel_ids = [c.id for c in channels]
    fields = (
        db.query(ChannelField).filter(ChannelField.channel_id.in_(channel_ids)).all()
        if channel_ids
        else []
    )
    instances = (
        db.query(DeploymentInstance).filter(DeploymentInstance.node_id.in_(subtree)).all()
    )
    return SubtreeDocs(
        node_docs=[NodeDocSnapshot.model_validate(d) for d in docs],
        db_tables=[DbTableSnapshot.model_validate(t) for t in tables],
        db_columns=[DbColumnSnapshot.model_validate(c) for c in columns],
        broker_channels=[BrokerChannelSnapshot.model_validate(c) for c in channels],
        channel_fields=[ChannelFieldSnapshot.model_validate(f) for f in fields],
        config_params=[ConfigParamSnapshot.model_validate(p) for p in params],
        instances=[DeploymentInstanceSnapshot.model_validate(i) for i in instances],
    )


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

    # Документация узлов поддерева — умрёт БД-каскадом вместе с ними.
    docs = collect_subtree_docs(db, subtree)

    return DeletionSnapshot(
        nodes=[NodeSnapshot.model_validate(n) for n in nodes],
        edges=[EdgeSnapshot.model_validate(e) for e in edges],
        layout_items=[ViewLayoutItemSnapshot.model_validate(r) for r in layout_rows],
        node_docs=docs.node_docs,
        db_tables=docs.db_tables,
        db_columns=docs.db_columns,
        broker_channels=docs.broker_channels,
        channel_fields=docs.channel_fields,
        config_params=docs.config_params,
        instances=docs.instances,
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


class RestoreError(ValueError):
    """Снимок нельзя восстановить целиком: он ссылается на объекты вне проекта,
    содержит цикл родителей или дубли имён. Роутер переводит в HTTP: 422 — чужие
    ссылки и цикл, 409 — дубль имени (как у обычного CRUD)."""

    def __init__(self, detail: str, status: int = 422) -> None:
        super().__init__(detail)
        self.detail = detail
        self.status = status


FOREIGN_REF_DETAIL = "Снимок ссылается на объекты вне проекта — восстановить его нельзя"
CYCLE_DETAIL = "В снимке цикл родителей — восстановить его нельзя"


def _check_no_parent_cycle(snapshot: DeletionSnapshot) -> None:
    """Цепочка parent_id внутри снимка обязана быть деревом: узел, ссылающийся на себя
    или на своего потомка, раньше вешал воркер в бесконечном обходе (аудит 2026-10)."""
    by_id = {n.id: n for n in snapshot.nodes}
    for n in snapshot.nodes:
        seen = {n.id}
        cur = n.parent_id
        while cur is not None and cur in by_id:
            if cur in seen:
                raise RestoreError(CYCLE_DETAIL)
            seen.add(cur)
            cur = by_id[cur].parent_id


def _check_unique_names(db: Session, snapshot: DeletionSnapshot, live_node_ids: set[uuid.UUID]) -> None:
    """Дубли имён внутри снимка и против живых строк тех родителей, что уже в проекте:
    без проверки они упирались бы в уникальный индекс БД и давали 500 вместо 409."""
    groups: list[tuple[str, list[tuple[tuple, str]]]] = [
        ("схема логики", [((d.node_id,), d.name) for d in snapshot.node_docs]),
        ("таблица", [((t.node_id, t.schema_name), t.name) for t in snapshot.db_tables]),
        ("колонка", [((c.table_id,), c.name) for c in snapshot.db_columns]),
        ("канал", [((c.node_id, c.group_name), c.name) for c in snapshot.broker_channels]),
        ("поле канала", [((f.channel_id,), f.name) for f in snapshot.channel_fields]),
        ("параметр", [((p.node_id,), p.name) for p in snapshot.config_params]),
    ]
    for noun, rows in groups:
        seen: set[tuple] = set()
        for owner, name in rows:
            key = (*owner, name)
            if key in seen:
                raise RestoreError(f"В снимке повторяется имя ({noun}): «{name}»", 409)
            seen.add(key)
    # Живые тёзки у родителей, которые остаются в проекте (сами узлы снимка ещё не
    # существуют — у них тёзок быть не может).
    if not live_node_ids:
        return
    live_docs = {
        (nid, name)
        for nid, name in db.query(NodeDoc.node_id, NodeDoc.name).filter(NodeDoc.node_id.in_(live_node_ids))
    }
    for d in snapshot.node_docs:
        if (d.node_id, d.name) in live_docs:
            raise RestoreError(f"Схема логики с именем «{d.name}» уже есть у этого объекта", 409)
    live_tables = {
        (nid, schema, name)
        for nid, schema, name in db.query(DbTable.node_id, DbTable.schema_name, DbTable.name).filter(
            DbTable.node_id.in_(live_node_ids)
        )
    }
    for t in snapshot.db_tables:
        if (t.node_id, t.schema_name, t.name) in live_tables:
            raise RestoreError(f"Таблица с именем «{t.name}» уже есть у этого объекта", 409)
    live_channels = {
        (nid, group, name)
        for nid, group, name in db.query(
            BrokerChannel.node_id, BrokerChannel.group_name, BrokerChannel.name
        ).filter(BrokerChannel.node_id.in_(live_node_ids))
    }
    for c in snapshot.broker_channels:
        if (c.node_id, c.group_name, c.name) in live_channels:
            raise RestoreError(f"Канал с именем «{c.name}» уже есть у этого объекта", 409)
    live_params = {
        (nid, name)
        for nid, name in db.query(ConfigParam.node_id, ConfigParam.name).filter(
            ConfigParam.node_id.in_(live_node_ids)
        )
    }
    for p in snapshot.config_params:
        if (p.node_id, p.name) in live_params:
            raise RestoreError(f"Параметр с именем «{p.name}» уже есть у этого объекта", 409)


def validate_snapshot(db: Session, snapshot: DeletionSnapshot, project_id: uuid.UUID) -> None:
    """Проверить снимок ДО записи: каждая ссылка (родитель узла, владелец дока/таблицы/
    канала/параметра, концы рёбер, вид раскладки, таблица колонки, канал поля) ведёт либо
    внутрь снимка, либо на живую строку ЭТОГО проекта. Снимок приходит от клиента, и без
    этой проверки редактор одного проекта писал строки на узлы другого (аудит 2026-10,
    S1). Заодно — цикл родителей (S2) и дубли имён (S9)."""
    _check_no_parent_cycle(snapshot)
    ids = {n.id for n in snapshot.nodes}

    # Ссылки на узлы вне снимка — одним запросом по проекту.
    node_refs: set[uuid.UUID] = set()
    node_refs.update(n.parent_id for n in snapshot.nodes if n.parent_id is not None)
    node_refs.update(d.node_id for d in snapshot.node_docs)
    node_refs.update(t.node_id for t in snapshot.db_tables)
    node_refs.update(c.node_id for c in snapshot.broker_channels)
    node_refs.update(p.node_id for p in snapshot.config_params)
    node_refs.update(i.node_id for i in snapshot.instances)
    node_refs.update(e.source_id for e in snapshot.edges)
    node_refs.update(e.target_id for e in snapshot.edges)
    node_refs.update(it.view_id for it in snapshot.layout_items if it.view_id is not None)
    outside = node_refs - ids
    live_nodes: set[uuid.UUID] = set()
    if outside:
        live_nodes = {
            nid
            for (nid,) in db.query(Node.id).filter(Node.id.in_(outside), Node.project_id == project_id)
        }
        if outside - live_nodes:
            raise RestoreError(FOREIGN_REF_DETAIL)

    # Таблицы колонок и каналы полей — внутри снимка либо живые у узлов проекта.
    table_ids = {t.id for t in snapshot.db_tables}
    column_tables = {c.table_id for c in snapshot.db_columns} - table_ids
    if column_tables:
        live_tables = {
            tid
            for (tid,) in db.query(DbTable.id)
            .join(Node, Node.id == DbTable.node_id)
            .filter(DbTable.id.in_(column_tables), Node.project_id == project_id)
        }
        if column_tables - live_tables:
            raise RestoreError(FOREIGN_REF_DETAIL)
    channel_ids = {c.id for c in snapshot.broker_channels}
    field_channels = {f.channel_id for f in snapshot.channel_fields} - channel_ids
    if field_channels:
        live_channels = {
            cid
            for (cid,) in db.query(BrokerChannel.id)
            .join(Node, Node.id == BrokerChannel.node_id)
            .filter(BrokerChannel.id.in_(field_channels), Node.project_id == project_id)
        }
        if field_channels - live_channels:
            raise RestoreError(FOREIGN_REF_DETAIL)

    # Площадка экземпляра: чужая — отказ (та же утечка изоляции, что чужой узел);
    # несуществующая — не отказ: её удалили после удаления объекта, и экземпляр
    # молча пропустит apply_snapshot (_restore_instances).
    site_ids = {i.site_id for i in snapshot.instances}
    if site_ids:
        foreign_sites = (
            db.query(DeploymentSite.id)
            .filter(DeploymentSite.id.in_(site_ids), DeploymentSite.project_id != project_id)
            .first()
        )
        if foreign_sites is not None:
            raise RestoreError(FOREIGN_REF_DETAIL)

    _check_unique_names(db, snapshot, live_nodes)


def restore_from_snapshot(
    db: Session, snapshot: DeletionSnapshot, project_id: uuid.UUID
) -> None:
    """Undo удаления: воссоздать всё из снимка (apply_snapshot) и закоммитить."""
    apply_snapshot(db, snapshot, project_id)
    db.commit()


def apply_snapshot(db: Session, snapshot: DeletionSnapshot, project_id: uuid.UUID) -> None:
    """Воссоздать узлы, их документацию, экземпляры развёртывания, рёбра и строки
    раскладки из снимка с сохранением исходных id — без коммита: откат версии документации
    (app/versions_restore) воссоздаёт недостающее этой же механикой внутри своей
    транзакции, рядом с правками уцелевших строк.

    Узлы вставляются родителями раньше детей: FK parent_id проверяется сразу, а
    корень поддерева ссылается на уцелевший (внешний) узел уровня. Документация,
    рёбра и раскладка — после узлов (их FK на nodes уже валидны). project_id —
    проект, в который восстанавливаем (снимок его не несёт; восстановление всегда в
    текущий проект).

    Строки собираются из ПОЛЕЙ СНИМКА целиком (model_dump), а не перечнем: поле,
    добавленное в снимок, доезжает до строки само.
    """
    validate_snapshot(db, snapshot, project_id)
    by_id = {n.id: n for n in snapshot.nodes}

    def depth(n: NodeSnapshot) -> int:
        d = 0
        cur = n
        seen = {n.id}  # цикл отсечён валидацией; страховка от зависания на всякий случай
        while cur.parent_id is not None and cur.parent_id in by_id and cur.parent_id not in seen:
            cur = by_id[cur.parent_id]
            seen.add(cur.id)
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
    _restore_db_columns(db, snapshot, project_id)

    # Структура брокера: каналы до полей (FK channel_id).
    for cs in snapshot.broker_channels:
        db.add(BrokerChannel(**cs.model_dump()))
    db.flush()
    for fs in snapshot.channel_fields:
        db.add(ChannelField(**fs.model_dump()))

    # Конфигурация сервиса: висит прямо на узле, второго уровня у неё нет.
    for ps in snapshot.config_params:
        db.add(ConfigParam(**ps.model_dump()))

    for es in snapshot.edges:
        db.add(Edge(**es.model_dump(), project_id=project_id))
    db.flush()

    _restore_instances(db, snapshot, project_id)

    # Строки раскладки: удаление их вычистило (каскад/явная чистка), коллизий нет.
    for it in snapshot.layout_items:
        db.add(ViewLayoutItem(**it.model_dump(), project_id=project_id))
    db.flush()


def _restore_instances(db: Session, snapshot: DeletionSnapshot, project_id: uuid.UUID) -> None:
    """Экземпляры развёртывания — после узлов (FK node_id уже валиден).

    Площадка в снимок не входит: она не потомок узла, и Undo удаления объекта не может
    вернуть площадку, удалённую после него. Такой экземпляр пропускается молча —
    объект возвращается без этого размещения, а не отказом всего отката. Пропускается
    и пара, которая уже стоит (экземпляр живого узла в присланном снимке): уникальность
    (node_id, site_id) дала бы 500 вместо отката."""
    if not snapshot.instances:
        return
    site_ids = {i.site_id for i in snapshot.instances}
    live_sites = {
        sid
        for (sid,) in db.query(DeploymentSite.id).filter(
            DeploymentSite.id.in_(site_ids), DeploymentSite.project_id == project_id
        )
    }
    node_ids = {i.node_id for i in snapshot.instances}
    taken = {
        (nid, sid)
        for nid, sid in db.query(DeploymentInstance.node_id, DeploymentInstance.site_id).filter(
            DeploymentInstance.node_id.in_(node_ids)
        )
    }
    taken_ids = {
        iid
        for (iid,) in db.query(DeploymentInstance.id).filter(
            DeploymentInstance.id.in_({i.id for i in snapshot.instances})
        )
    }
    for inst in snapshot.instances:
        pair = (inst.node_id, inst.site_id)
        if inst.site_id not in live_sites or pair in taken or inst.id in taken_ids:
            continue
        taken.add(pair)
        taken_ids.add(inst.id)
        db.add(DeploymentInstance(**inst.model_dump(), project_id=project_id))
    db.flush()


def _restore_db_columns(db: Session, snapshot: DeletionSnapshot, project_id: uuid.UUID) -> None:
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
    # Цель вне снимка обязана быть живой И принадлежать проекту: ER-ссылка в чужой
    # проект — та же утечка изоляции, что и чужой node_id (аудит 2026-10, S1).
    alive = (
        {
            c
            for (c,) in db.query(DbColumn.id)
            .join(DbTable, DbTable.id == DbColumn.table_id)
            .join(Node, Node.id == DbTable.node_id)
            .filter(DbColumn.id.in_(outside), Node.project_id == project_id)
            .all()
        }
        if outside
        else set()
    )
    for column_id, target in refs.items():
        if target in restored or target in alive:
            column = db.get(DbColumn, column_id)
            if column is not None:
                column.references_column_id = target
    db.flush()
