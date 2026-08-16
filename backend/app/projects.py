"""Глубокая копия схемы проекта (POST /projects со start="copy:<projectId>").

Копирует узлы со всей их документацией (схемы логики, структура БД, каналы брокеров),
связи, бизнес-процессы и раскладочный слой в новый проект с НОВЫМИ id, перемэппивая
все внутренние ссылки. Исходный проект не меняется.

ЧТО именно переносится — объявлено в app/copy_plan.py (по умолчанию копируется всё,
кроме объявленного своим/пересчитываемым). Здесь — только ПОРЯДОК вставки и карты
«старый id → новый»: все карты аллоцируются ЗАРАНЕЕ, чтобы ссылки перемэппивались
без оглядки на порядок обхода.
"""

import uuid

from sqlalchemy.orm import Session

from app.copy_plan import copy_row
from app.models.broker_channel import BrokerChannel
from app.models.business_process import BusinessProcess
from app.models.channel_field import ChannelField
from app.models.db_column import DbColumn
from app.models.db_table import DbTable
from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.process_fragment import ProcessFragment, ProcessFragmentBranch
from app.models.process_message import ProcessMessage
from app.models.process_participant import ProcessParticipant
from app.models.view_layout import ViewLayoutItem


def copy_project_schema(db: Session, src_id: uuid.UUID, dst_id: uuid.UUID) -> None:
    """Скопировать всю схему проекта src_id в проект dst_id с новыми id. Коммит —
    на вызывающей стороне. Узлы вставляются родителями раньше детей (FK parent_id)."""
    nmap: dict[uuid.UUID, uuid.UUID] = {}  # старый node id → новый
    emap: dict[uuid.UUID, uuid.UUID] = {}  # старый edge id → новый
    pmap: dict[uuid.UUID, uuid.UUID] = {}  # старый process id → новый
    partmap: dict[uuid.UUID, uuid.UUID] = {}  # старый participant id → новый
    fragmap: dict[uuid.UUID, uuid.UUID] = {}  # старый fragment id → новый
    tmap: dict[uuid.UUID, uuid.UUID] = {}  # старый db_table id → новый
    colmap: dict[uuid.UUID, uuid.UUID] = {}  # старый db_column id → новый
    chmap: dict[uuid.UUID, uuid.UUID] = {}  # старый broker_channel id → новый

    nodes = db.query(Node).filter(Node.project_id == src_id).all()
    # Заранее выделяем новые id, чтобы перемэппить parent_id без учёта порядка.
    for n in nodes:
        nmap[n.id] = uuid.uuid4()
    # Сортировка по глубине: родитель (его новый id уже в nmap) существует до ребёнка.
    by_id = {n.id: n for n in nodes}

    def depth(n: Node) -> int:
        d, cur = 0, n
        while cur.parent_id is not None and cur.parent_id in by_id:
            cur = by_id[cur.parent_id]
            d += 1
        return d

    for n in sorted(nodes, key=depth):
        db.add(
            copy_row(
                n,
                id=nmap[n.id],
                project_id=dst_id,
                parent_id=nmap.get(n.parent_id) if n.parent_id else None,
            )
        )
    db.flush()

    if nmap:
        _copy_node_docs(db, nmap)
        _copy_db_structure(db, nmap, tmap, colmap)
        _copy_broker_structure(db, nmap, chmap)
        db.flush()

    for e in db.query(Edge).filter(Edge.project_id == src_id).all():
        emap[e.id] = uuid.uuid4()
        db.add(
            copy_row(
                e,
                id=emap[e.id],
                project_id=dst_id,
                source_id=nmap[e.source_id],
                target_id=nmap[e.target_id],
            )
        )
    db.flush()

    _copy_processes(db, src_id, dst_id, nmap, emap, pmap, partmap, fragmap)
    _copy_layout(db, src_id, dst_id, nmap)


def _copy_node_docs(db: Session, nmap: dict[uuid.UUID, uuid.UUID]) -> None:
    """Схемы логики узлов (node_docs) — с новыми id, перевешены на новые узлы."""
    docs = db.query(NodeDoc).filter(NodeDoc.node_id.in_(nmap.keys())).all()
    for d in docs:
        db.add(copy_row(d, id=uuid.uuid4(), node_id=nmap[d.node_id]))


def _copy_db_structure(
    db: Session,
    nmap: dict[uuid.UUID, uuid.UUID],
    tmap: dict[uuid.UUID, uuid.UUID],
    colmap: dict[uuid.UUID, uuid.UUID],
) -> None:
    """Структура БД узлов-баз: таблицы и их колонки.

    id колонок выделяем ЗАРАНЕЕ вместе с id таблиц: ссылка references_column_id —
    внешний ключ КАРТЫ, её цель может лежать в другой таблице и даже у другого узла,
    и без общей карты колонка копии смотрела бы в исходный проект.
    """
    tables = db.query(DbTable).filter(DbTable.node_id.in_(nmap.keys())).all()
    for t in tables:
        tmap[t.id] = uuid.uuid4()
    columns = (
        db.query(DbColumn).filter(DbColumn.table_id.in_(tmap.keys())).all() if tmap else []
    )
    for c in columns:
        colmap[c.id] = uuid.uuid4()

    for t in tables:
        db.add(copy_row(t, id=tmap[t.id], node_id=nmap[t.node_id]))
    db.flush()  # таблицы существуют до колонок (FK table_id)
    new_columns: dict[uuid.UUID, DbColumn] = {}
    for c in columns:
        new = copy_row(c, id=colmap[c.id], table_id=tmap[c.table_id])
        new_columns[c.id] = new
        db.add(new)
    db.flush()
    # Ссылки колонка→колонка проставляем ВТОРЫМ проходом, когда все колонки уже в БД:
    # цель может лежать в любой таблице (и ссылаться обратно), а FK проверяется сразу
    # на вставке — порядком «сначала цель, потом ссылку» это не решается.
    for c in columns:
        if c.references_column_id:
            new_columns[c.id].references_column_id = colmap.get(c.references_column_id)


def _copy_broker_structure(
    db: Session, nmap: dict[uuid.UUID, uuid.UUID], chmap: dict[uuid.UUID, uuid.UUID]
) -> None:
    """Структура брокеров: каналы и поля их сообщений.

    Имя канала переносится БЕЗ изменений: связь ссылается на канал по имени
    (Edge.channel — мягкая ссылка, не FK), и переименование порвало бы шов в копии.
    """
    channels = db.query(BrokerChannel).filter(BrokerChannel.node_id.in_(nmap.keys())).all()
    for ch in channels:
        chmap[ch.id] = uuid.uuid4()
    for ch in channels:
        db.add(copy_row(ch, id=chmap[ch.id], node_id=nmap[ch.node_id]))
    db.flush()  # каналы существуют до полей (FK channel_id)
    if chmap:
        fields = db.query(ChannelField).filter(ChannelField.channel_id.in_(chmap.keys())).all()
        for f in fields:
            db.add(copy_row(f, id=uuid.uuid4(), channel_id=chmap[f.channel_id]))


def _copy_processes(
    db: Session,
    src_id: uuid.UUID,
    dst_id: uuid.UUID,
    nmap: dict[uuid.UUID, uuid.UUID],
    emap: dict[uuid.UUID, uuid.UUID],
    pmap: dict[uuid.UUID, uuid.UUID],
    partmap: dict[uuid.UUID, uuid.UUID],
    fragmap: dict[uuid.UUID, uuid.UUID],
) -> None:
    """Бизнес-процессы с участниками, шагами и фрагментами (включая ветви [иначе])."""
    procs = db.query(BusinessProcess).filter(BusinessProcess.project_id == src_id).all()
    for p in procs:
        pmap[p.id] = uuid.uuid4()
        db.add(
            copy_row(
                p,
                id=pmap[p.id],
                project_id=dst_id,
                scope_node_id=nmap.get(p.scope_node_id) if p.scope_node_id else None,
            )
        )
    db.flush()
    if not procs:
        return

    old_pids = list(pmap.keys())
    parts = (
        db.query(ProcessParticipant).filter(ProcessParticipant.process_id.in_(old_pids)).all()
    )
    for part in parts:
        partmap[part.id] = uuid.uuid4()
        db.add(
            copy_row(
                part,
                id=partmap[part.id],
                process_id=pmap[part.process_id],
                # Непривязанный участник переносится как есть: узла у него нет,
                # ремапить нечего, а имя он несёт в себе.
                node_id=nmap[part.node_id] if part.node_id else None,
            )
        )
    db.flush()

    msgs = db.query(ProcessMessage).filter(ProcessMessage.process_id.in_(old_pids)).all()
    for msg in msgs:
        db.add(
            copy_row(
                msg,
                id=uuid.uuid4(),
                process_id=pmap[msg.process_id],
                # Повисший шаг остаётся повисшим: расхождение со схемой должно быть
                # видно в копии ровно так же, как в источнике.
                edge_id=emap.get(msg.edge_id) if msg.edge_id else None,
                from_participant_id=partmap[msg.from_participant_id],
                to_participant_id=partmap[msg.to_participant_id],
            )
        )

    frags = db.query(ProcessFragment).filter(ProcessFragment.process_id.in_(old_pids)).all()
    for frag in frags:
        fragmap[frag.id] = uuid.uuid4()
        db.add(copy_row(frag, id=fragmap[frag.id], process_id=pmap[frag.process_id]))
    db.flush()  # фрагменты существуют до ветвей (FK fragment_id)
    if fragmap:
        # Ветви [иначе] — отдельные строки: без явного переноса копия молча теряла бы
        # ветвления alt.
        branches = (
            db.query(ProcessFragmentBranch)
            .filter(ProcessFragmentBranch.fragment_id.in_(fragmap.keys()))
            .all()
        )
        for b in branches:
            db.add(copy_row(b, id=uuid.uuid4(), fragment_id=fragmap[b.fragment_id]))


def _copy_layout(
    db: Session, src_id: uuid.UUID, dst_id: uuid.UUID, nmap: dict[uuid.UUID, uuid.UUID]
) -> None:
    """Раскладочный слой (view_layout): ремапим вид и все uuid внутри строкового ключа
    (позиции — сам uuid узла/сущности). Payload фильтруем до живых ключей
    (x/y/expanded): ручной слой стрелок удалён 2026-07-09, легаси-геометрию пучков в
    копию не тащим; опустевшие строки не копируем вовсе."""
    if not nmap:
        return
    str_map = {str(old): str(new) for old, new in nmap.items()}

    def remap_str(s: str) -> str:
        for old, new in str_map.items():
            if old in s:
                s = s.replace(old, new)
        return s

    for it in db.query(ViewLayoutItem).filter(ViewLayoutItem.project_id == src_id).all():
        new_view = nmap.get(it.view_id) if it.view_id is not None else None
        if it.view_id is not None and new_view is None:
            continue  # вид ссылался на несуществующий узел — мусор, не копируем
        payload = {k: v for k, v in it.payload.items() if k in ("x", "y", "expanded")}
        if not payload:
            continue  # чисто легаси-строка (геометрия пучка) — в копии не нужна
        db.add(
            copy_row(
                it,
                id=uuid.uuid4(),
                project_id=dst_id,
                view_id=new_view,
                item_id=remap_str(it.item_id),
                payload=payload,
            )
        )
