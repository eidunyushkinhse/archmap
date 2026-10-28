"""Глобальные алерты незавершённости схемы.

Доменный алгоритм, который раньше жил прямо в HTTP-слое (routers.nodes.get_alerts):
по всей схеме проекта находит классы проблем — от «подвисших» узлов и связей в
контейнер до пометок обращений, не нашедших цели. HTTP-слой лишь отдаёт готовый ответ.

Устройство (аудит Q-7: была одна функция на 488 строк): AlertContext читает проект
один раз, у каждого класса алерта — своя функция над контекстом, compute_alerts их
собирает.
"""

import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from functools import cached_property
from typing import Any, Literal

from sqlalchemy import func
from sqlalchemy.orm import Session, aliased

from app.connectivity import connected_components
from app.data_refs import ProjectCatalog, RefStatus, catalog_for_project, doc_ref_hits
from app.models.business_process import BusinessProcess
from app.models.config_param import ConfigParam
from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.process_message import ProcessMessage
from app.models.process_participant import ProcessParticipant
from app.schemas.alerts import (
    AlertsResponse,
    BrokerEdgeChannelAlert,
    ContainerOwnDocsAlert,
    DanglingMessageAlert,
    DescendantEdgeAlert,
    DisconnectedNodeAlert,
    IntermediateEdgeAlert,
    IsolatedGroupAlert,
    OrphanLegAlert,
    PersonInsideAlert,
    UnboundParticipantAlert,
    UndescribedDocsAlert,
    UnlinkedMessageAlert,
    UnresolvedChannelRefAlert,
    UnresolvedConfigRefAlert,
    UnresolvedDataRefAlert,
)

# Разведение классов AL29/AL30: табличные причины — в «неописанные данные»,
# канальные — в «неописанные каналы». Отображения ЯВНЫЕ, а не «status как есть»:
# «ambiguous» общий для обеих семей, и чей он — говорит только режим пометки.
_TABLE_REASON: dict[RefStatus, Literal["unknown_table", "ambiguous", "unknown_column"]] = {
    "unknown_table": "unknown_table",
    "ambiguous": "ambiguous",
    "unknown_column": "unknown_column",
}
_CHANNEL_REASON: dict[
    RefStatus, Literal["unknown_channel", "ambiguous", "unknown_field"]
] = {
    "unknown_channel": "unknown_channel",
    "ambiguous": "ambiguous",
    "unknown_field": "unknown_field",
}


@dataclass
class AlertContext:
    """Проект, прочитанный один раз на все классы алертов."""

    db: Session
    project_id: uuid.UUID
    nodes: list[Node]
    edges: list[Edge]
    name_by_id: dict[uuid.UUID, str] = field(init=False)
    parent_by_id: dict[uuid.UUID, uuid.UUID | None] = field(init=False)
    # Промежуточные узлы = те, что являются чьим-то родителем (есть дети).
    intermediate_ids: set[uuid.UUID] = field(init=False)

    def __post_init__(self) -> None:
        self.name_by_id = {n.id: n.name for n in self.nodes}
        self.parent_by_id = {n.id: n.parent_id for n in self.nodes}
        self.intermediate_ids = {
            pid
            for (pid,) in self.db.query(Node.parent_id)
            .filter(Node.project_id == self.project_id, Node.parent_id.isnot(None))
            .distinct()
            .all()
        }

    @classmethod
    def load(cls, db: Session, project_id: uuid.UUID) -> "AlertContext":
        return cls(
            db,
            project_id,
            db.query(Node).filter(Node.project_id == project_id).all(),
            db.query(Edge).filter(Edge.project_id == project_id).all(),
        )

    def name(self, node_id: uuid.UUID | None) -> str:
        return self.name_by_id.get(node_id, "?") if node_id is not None else "?"

    def end_name(self, node_id: uuid.UUID | None, own: str) -> str:
        """Конец шага: живое имя узла, а у непривязанного участника — его собственное
        (иначе конец показывался бы как «?»)."""
        return (self.name_by_id.get(node_id) if node_id is not None else None) or own

    @cached_property
    def catalog(self) -> ProjectCatalog:
        return catalog_for_project(self.db, self.project_id)

    @cached_property
    def descendant_edges(self) -> list[DescendantEdgeAlert]:
        return _descendant_edges(self)

    @cached_property
    def descendant_edge_ids(self) -> set[uuid.UUID]:
        """Связи узла с собственным потомком (AL32) — у них свой класс, и советы
        соседних классов («уточните конец», «допишите канал») к ним не относятся."""
        return {a.edge_id for a in self.descendant_edges}

    def descends(self, child: uuid.UUID, ancestor: uuid.UUID) -> bool:
        """Потомок ли child для ancestor (любой глубины). Дерево БД без циклов
        (parent_id — FK на узел того же проекта, цикл создать нечем), но счётчик
        шагов держим: битые данные не должны вешать запрос алертов."""
        parent = self.parent_by_id.get(child)
        for _ in range(len(self.parent_by_id) + 1):
            if parent is None:
                return False
            if parent == ancestor:
                return True
            parent = self.parent_by_id.get(parent)
        return False


def compute_alerts(db: Session, project_id: uuid.UUID) -> AlertsResponse:
    """Глобальные алерты незавершённости схемы проекта:
    1) атомарные (листовые) узлы без единой связи — «подвисшие»;
    2) связи, у которых хотя бы один конец упирается в промежуточный
       (контейнерный) узел, а не в атомарный;
    2а) связи между узлом и его собственным потомком — вложенность уже выражена
       иерархией; класс свой, и такие связи не попадают ни в (2), ни в (11):
       «уточните конец» и «допишите канал» противоречат совету «удалите связь»;
    3) изолированные группы — связные компоненты графа рёбер;
    4) контейнеры с СОБСТВЕННЫМИ доками/спекой/конфигурацией (grandfather) — логика,
       спеки и параметры должны жить на атомарных детях, такие доки распределяют по детям;
    5) люди (shape=person), вложенные в другой узел — по C4 актор живёт на
       контекстном уровне, ВНЕ границы системы;
    6) повисшие сообщения процессов — связь, которой шло сообщение, удалена
       из схемы (edge_id = NULL);
    7) участники процессов без узла схемы;
    8) шаги-ответы, у которых пропало плечо канала;
    9) пометки обращений «читает:/пишет:» в схемах логики, не нашедшие свою
       таблицу структуры — обещание факта, которое текст дал, а структура не
       подтверждает (таблицы нет / имя неоднозначно / колонки нет);
    10) то же для событий: пометки «публикует:/потребляет:», не нашедшие свой
       канал в структуре брокеров (канала нет / имя неоднозначно / поля нет);
    11) связи, у которых конец — брокер, а канал не назван (missing) либо назван,
       но структура брокера его не знает (unknown);
    12) пометки «зависит от:», не нашедшие параметра у владельца схемы;
    13) шаги процессов без привязки к схеме логики (doc_id = NULL) — алерт
       полноты, той же семьи, что «не описана» у разведки: гаснет привязкой;
    14) объекты с неописанными схемами логики (заглушки разведки — схемы без
       тела): одна запись на объект с числом заглушек, гаснет описанием.
    Контейнеры в проверке (1) не участвуют: прямых связей у них быть не должно
    (это как раз ловит проверка 2), а группировку детей за «подвисание» не считаем.
    """
    ctx = AlertContext.load(db, project_id)
    data_refs, channel_refs, config_refs = _unresolved_refs(ctx)
    return AlertsResponse(
        disconnected_nodes=_disconnected(ctx),
        intermediate_edges=_intermediate_edges(ctx),
        isolated_groups=_isolated_groups(ctx),
        container_own_docs=_container_own_docs(ctx),
        persons_inside=_persons_inside(ctx),
        dangling_messages=_dangling_messages(ctx),
        unbound_participants=_unbound_participants(ctx),
        orphan_legs=_orphan_legs(ctx),
        unlinked_messages=_unlinked_messages(ctx),
        undescribed_docs=_undescribed_docs(ctx),
        unresolved_data_refs=data_refs,
        unresolved_channel_refs=channel_refs,
        unresolved_config_refs=config_refs,
        broker_edge_channels=_broker_edge_channels(ctx),
        descendant_edges=ctx.descendant_edges,
    )


# ── Схема: узлы и связи ──────────────────────────────────────────────────────


def _disconnected(ctx: AlertContext) -> list[DisconnectedNodeAlert]:
    """1) Атомарные узлы без единой связи (по сырым концам рёбер)."""
    connected_ids: set[uuid.UUID] = set()
    for e in ctx.edges:
        connected_ids.add(e.source_id)
        connected_ids.add(e.target_id)
    return [
        DisconnectedNodeAlert(node_id=n.id, node_name=n.name)
        for n in ctx.nodes
        if n.id not in ctx.intermediate_ids and n.id not in connected_ids
    ]


def _descendant_edges(ctx: AlertContext) -> list[DescendantEdgeAlert]:
    """2а) Связь узла с СОБСТВЕННЫМ потомком (AL32) — разбирается ДО связей в
    контейнер и снимается с них. Вложенность уже выражена иерархией: такая стрелка
    семантически пуста, и совет AL6 («уточните конец до конкретного компонента»)
    отвечает на неё бессмыслицей — конец УЖЕ компонент, притом этого же контейнера.
    Полевая находка матрицы федерации (находка 4, docs/qa-federation-matrix.md): в
    превью импорта класс уже отделён (К4), здесь закрывается паритет — иначе превью
    советует удалить связь, а панель проекта тут же требует обратного."""
    out: list[DescendantEdgeAlert] = []
    for e in ctx.edges:
        source_is_part = ctx.descends(e.source_id, e.target_id)
        if not source_is_part and not ctx.descends(e.target_id, e.source_id):
            continue
        out.append(
            DescendantEdgeAlert(
                edge_id=e.id,
                label=e.label,
                source_id=e.source_id,
                source_name=ctx.name(e.source_id),
                target_id=e.target_id,
                target_name=ctx.name(e.target_id),
                source_is_part=source_is_part,
            )
        )
    return out


def _intermediate_edges(ctx: AlertContext) -> list[IntermediateEdgeAlert]:
    """2) Связи с концом в контейнере, кроме связей с собственным потомком (AL32):
    два совета на одну связь противоречивы."""
    out: list[IntermediateEdgeAlert] = []
    for e in ctx.edges:
        if e.id in ctx.descendant_edge_ids:
            continue
        src_inter = e.source_id in ctx.intermediate_ids
        tgt_inter = e.target_id in ctx.intermediate_ids
        if src_inter or tgt_inter:
            out.append(
                IntermediateEdgeAlert(
                    edge_id=e.id,
                    label=e.label,
                    source_id=e.source_id,
                    source_name=ctx.name(e.source_id),
                    target_id=e.target_id,
                    target_name=ctx.name(e.target_id),
                    source_is_intermediate=src_inter,
                    target_is_intermediate=tgt_inter,
                )
            )
    return out


def _isolated_groups(ctx: AlertContext) -> list[IsolatedGroupAlert]:
    """3) Изолированные группы — связные компоненты графа РЁБЕР (иерархию parent_id
    игнорируем: иначе всё связано через дерево; единственное исключение — конец связи
    в контейнере касается его поддерева, см. app.connectivity). Узлы без единой связи
    сюда не попадают (их ловит проверка 1). Алерт зажигаем, только если связных групп
    (≥2 узла) больше одной — иначе это просто единственный кластер плюс висячие узлы,
    и фрагментации нет. Ядро общее с превью импорта — вердикты совпадают по построению."""
    components = connected_components(
        [(e.source_id, e.target_id) for e in ctx.edges], ctx.parent_by_id
    )
    if len(components) < 2:
        return []
    return [
        IsolatedGroupAlert(node_ids=comp, node_names=[ctx.name(nid) for nid in comp])
        for comp in components
    ]


def _container_own_docs(ctx: AlertContext) -> list[ContainerOwnDocsAlert]:
    """4) Контейнеры с собственными доками/спекой/конфигурацией (grandfather). Контейнер =
    service с детьми. Алерт: узел стал контейнером, но логика/спека/параметры остались
    на нём — надо распределить по детям.

    Конфигурация — третий жилец (2026-10-28, полевой репорт): контейнер для неё такая
    же абстракция, параметры читает код компонентов, а пометки «зависит от:» в их
    схемах ищут ручку у владельца схемы (data_refs._resolve_config), не у родителя —
    параметры на контейнере не найдёт никто."""
    node_ids = [n.id for n in ctx.nodes]
    doc_owners: set[uuid.UUID] = set()
    param_owners: set[uuid.UUID] = set()
    if node_ids:
        rows = (
            ctx.db.query(NodeDoc.node_id).filter(NodeDoc.node_id.in_(node_ids)).distinct().all()
        )
        doc_owners = {nid for (nid,) in rows}
        prow = (
            ctx.db.query(ConfigParam.node_id)
            .filter(ConfigParam.node_id.in_(node_ids))
            .distinct()
            .all()
        )
        param_owners = {nid for (nid,) in prow}
    out: list[ContainerOwnDocsAlert] = []
    for n in ctx.nodes:
        if n.id not in ctx.intermediate_ids or n.shape != "service":
            continue
        has_docs = n.id in doc_owners
        has_spec = bool(n.openapi_spec)
        has_config = n.id in param_owners
        if has_docs or has_spec or has_config:
            out.append(
                ContainerOwnDocsAlert(
                    node_id=n.id,
                    node_name=n.name,
                    has_docs=has_docs,
                    has_spec=has_spec,
                    has_config=has_config,
                )
            )
    return out


def _persons_inside(ctx: AlertContext) -> list[PersonInsideAlert]:
    """5) Люди внутри системы. Правило C4: актор не может быть частью контейнера.
    Промпт импорта его требует, отчёт слияния предупреждает — но объекты, заведённые
    РУКАМИ, не проверял никто (остаток находки 2026-08-08)."""
    return [
        PersonInsideAlert(
            node_id=n.id, node_name=n.name, parent_id=n.parent_id, parent_name=ctx.name(n.parent_id)
        )
        for n in ctx.nodes
        if n.shape == "person" and n.parent_id is not None
    ]


def _undescribed_docs(ctx: AlertContext) -> list[UndescribedDocsAlert]:
    """14) Объекты с неописанными схемами логики (AL35). Заглушка разведки — строка
    перечня без тела (docs/plan-recon.md): не схема, а обещание её написать. Алерт
    ПОЛНОТЫ той же семьи, что AL34, но ОДНА запись на объект, а не на заглушку: после
    разведки монолита заглушек две сотни, и две сотни строк в панели — стена, а не
    сигнал; построчный бэклог живёт на странице объекта (блок «Не описано»). Признак —
    тот же, что у витрины (NodeDoc.described: тело после trim пустое). Гаснет, когда
    все заглушки описаны или удалены."""
    node_ids = [n.id for n in ctx.nodes]
    if not node_ids:
        return []
    stub_rows = (
        ctx.db.query(NodeDoc.node_id, func.count(NodeDoc.id))
        .filter(NodeDoc.node_id.in_(node_ids), ~NodeDoc.described)
        .group_by(NodeDoc.node_id)
        .all()
    )
    out = [
        UndescribedDocsAlert(node_id=nid, node_name=ctx.name(nid), count=cnt)
        for nid, cnt in stub_rows
    ]
    out.sort(key=lambda a: a.node_name)
    return out


# ── Процессы ─────────────────────────────────────────────────────────────────


def _steps(ctx: AlertContext, *where: Any, edge_label: bool = False) -> Sequence[Any]:
    """Шаги процессов проекта по условию where — строками (процесс, имя, шаг,
    подпись[, метка связи], узел и имя участника-отправителя, то же получателя), в
    порядке процесса и шага. edge_label — присоединить связь шага и взять её метку."""
    from_p = aliased(ProcessParticipant)
    to_p = aliased(ProcessParticipant)
    cols: list[Any] = [
        BusinessProcess.id, BusinessProcess.name, ProcessMessage.id, ProcessMessage.caption,
    ]
    if edge_label:
        cols.append(Edge.label)
    cols += [from_p.node_id, to_p.node_id, from_p.name, to_p.name]
    q = ctx.db.query(*cols).join(ProcessMessage, ProcessMessage.process_id == BusinessProcess.id)
    if edge_label:
        q = q.join(Edge, Edge.id == ProcessMessage.edge_id)
    return (
        q.join(from_p, from_p.id == ProcessMessage.from_participant_id)
        .join(to_p, to_p.id == ProcessMessage.to_participant_id)
        .filter(BusinessProcess.project_id == ctx.project_id, *where)
        .order_by(BusinessProcess.name, ProcessMessage.order)
        .all()
    )


def _dangling_messages(ctx: AlertContext) -> list[DanglingMessageAlert]:
    """6) Повисшие сообщения процессов. Удаление связи из схемы НЕ сносит сообщение
    (ON DELETE SET NULL) — расхождение процесса со схемой должно быть видно, а не
    происходить тихо. До сих пор оно было видно только ВНУТРИ окна процесса; здесь
    тот же факт поднимается на уровень схемы. Самосообщения исключены: у внутренней
    операции участника связи C4 и не было."""
    return [
        DanglingMessageAlert(
            process_id=proc_id, process_name=proc_name, message_id=msg_id, caption=caption,
            from_name=ctx.end_name(from_node, from_own), to_name=ctx.end_name(to_node, to_own),
        )
        for proc_id, proc_name, msg_id, caption, from_node, to_node, from_own, to_own in _steps(
            ctx,
            ProcessMessage.edge_id.is_(None),
            ProcessMessage.from_participant_id != ProcessMessage.to_participant_id,
        )
    ]


def _unbound_participants(ctx: AlertContext) -> list[UnboundParticipantAlert]:
    """7) Участники процессов без узла схемы (AL27). Симметрично повисшему сообщению:
    линия жизни на диаграмме есть, объекта архитектуры за ней нет. Путь исправления —
    привязка участника к узлу прямо на его шапке."""
    return [
        UnboundParticipantAlert(
            process_id=proc_id, process_name=proc_name, participant_id=part_id, name=name
        )
        for proc_id, proc_name, part_id, name in (
            ctx.db.query(
                BusinessProcess.id,
                BusinessProcess.name,
                ProcessParticipant.id,
                ProcessParticipant.name,
            )
            .join(ProcessParticipant, ProcessParticipant.process_id == BusinessProcess.id)
            .filter(
                BusinessProcess.project_id == ctx.project_id,
                ProcessParticipant.node_id.is_(None),
            )
            .order_by(BusinessProcess.name, ProcessParticipant.order)
            .all()
        )
    ]


def _orphan_legs(ctx: AlertContext) -> list[OrphanLegAlert]:
    """8) Шаги, у которых пропало ПЛЕЧО канала (AL28). Связь на месте — исчезло
    именно плечо: канал сменили на асинхронный уже после создания шага-ответа.
    Сравнение с False, а не «not True»: is_synchronous nullable, и NULL значит
    синхронный по умолчанию (edge_is_synchronous) — такой шаг цел."""
    return [
        OrphanLegAlert(
            process_id=proc_id, process_name=proc_name, message_id=msg_id, caption=caption,
            edge_label=edge_label,
            from_name=ctx.end_name(from_node, from_own), to_name=ctx.end_name(to_node, to_own),
        )
        for (
            proc_id, proc_name, msg_id, caption, edge_label, from_node, to_node, from_own, to_own
        ) in _steps(
            ctx, ProcessMessage.leg == "return", Edge.is_synchronous.is_(False), edge_label=True
        )
    ]


def _unlinked_messages(ctx: AlertContext) -> list[UnlinkedMessageAlert]:
    """13) Шаги процессов без привязки к схеме логики (AL34). Алерт ПОЛНОТЫ, а не
    поломки (Р4 «шумно, зато консистентно»): любой шаг с doc_id = NULL, не различая
    «не привязывали» и «схему удалили» (SET NULL гасит ссылку молча). Самосообщения
    участвуют наравне — внутренняя операция участника тоже документируется схемой;
    повисшие шаги тоже: у них ДВА разных изъяна (нет опоры в схеме — AL26, нет
    документации — этот), чинятся порознь."""
    return [
        UnlinkedMessageAlert(
            process_id=proc_id, process_name=proc_name, message_id=msg_id, caption=caption,
            from_name=ctx.end_name(from_node, from_own), to_name=ctx.end_name(to_node, to_own),
        )
        for proc_id, proc_name, msg_id, caption, from_node, to_node, from_own, to_own in _steps(
            ctx, ProcessMessage.doc_id.is_(None)
        )
    ]


# ── Пометки обращений и каналы связей ────────────────────────────────────────


def _unresolved_refs(
    ctx: AlertContext,
) -> tuple[list[UnresolvedDataRefAlert], list[UnresolvedChannelRefAlert], list[UnresolvedConfigRefAlert]]:
    """9, 10, 12) Пометки обращений, не нашедшие цели (AL29, AL30, AL33; пивот §9
    plan-db-docs.md). «читает: orders.status» в тексте схемы логики — обещание факта,
    и невыполненное обещание обязано быть видно: обратный индекс базы такую пометку не
    показывает (он отвечает за факты), а обращение с несуществующей колонкой
    показывает как обращение к таблице целиком — алерт остаётся единственным местом,
    где битая колонка заметна. Резолв — на ЧТЕНИИ, по каталогу всего проекта: хранимых
    обращений нет, а значит нет и точек инвалидации."""
    data: list[UnresolvedDataRefAlert] = []
    channel: list[UnresolvedChannelRefAlert] = []
    config: list[UnresolvedConfigRefAlert] = []
    for hit in doc_ref_hits(ctx.db, ctx.project_id, ctx.catalog):
        ref = hit.ref
        if ref.status == "ok":
            continue
        where = {
            "node_id": hit.node_id,
            "node_name": hit.node_name,
            "doc_id": hit.doc_id,
            "doc_name": hit.doc_name,
            "ref": ref.ref,
        }
        # 12) Пометка «зависит от:» не нашла параметра (AL33). Класс отдельный по той
        #     же причине, что и канальный: своя починка — «опишите ручку в разделе
        #     „Конфигурация“ этого объекта». Причину не передаём: она здесь ровно одна
        #     (см. UnresolvedConfigRefAlert).
        if ref.mode == "config":
            config.append(UnresolvedConfigRefAlert(**where))
            continue
        # 10) То же самое для каналов (AL30): пометка «публикует:/потребляет:» не нашла
        #     канал в структуре брокеров. Класс ОТДЕЛЬНЫЙ — причины и слова починки
        #     свои («укажите „Брокер / канал“»), и мешать топики с таблицами в одной
        #     строке панели значит запутать починку.
        if ref.mode == "publish" or ref.mode == "consume":
            channel_reason = _CHANNEL_REASON.get(ref.status)
            if channel_reason is not None:
                channel.append(
                    UnresolvedChannelRefAlert(**where, mode=ref.mode, reason=channel_reason)
                )
            continue
        table_reason = _TABLE_REASON.get(ref.status)
        if table_reason is not None:
            data.append(UnresolvedDataRefAlert(**where, mode=ref.mode, reason=table_reason))
    # Порядок детерминированный: у соседних классов его даёт ORDER BY, здесь он
    # появляется только после разбора текста — сортируем готовые записи.
    data.sort(key=lambda a: (a.node_name, a.doc_name, a.ref))
    channel.sort(key=lambda a: (a.node_name, a.doc_name, a.ref))
    config.sort(key=lambda a: (a.node_name, a.doc_name, a.ref))
    return data, channel, config


def _broker_edge_channels(ctx: AlertContext) -> list[BrokerEdgeChannelAlert]:
    """11) Связи с брокером, не называющие канал (AL31). Решение пользователя №4 (§4
    plan-broker-docs.md): стрелка «сервис → брокер» ОБЯЗАНА назвать топик — без этого
    схема не отвечает на «откуда взялось событие». Канал на связи — ссылка по ИМЕНИ, не
    FK, поэтому шов держит алерт, а не БД: `missing` — не указан вовсе, `unknown` —
    указан, но структура брокера-конца его не знает. Направление в резолве не участвует
    (публикация и доставка равноправны, см. edge.md E83) — ищем у ЛЮБОГО конца-брокера.

    Известные каналы — множеством пар «брокер, имя» (аудит Q-7: был линейный проход
    по каналам в цикле по связям). Имя — как у пометок (Ф2в): точное имя канала,
    включая имя С ТОЧКАМИ целиком («orders.created» — норма Kafka), либо «группа.канал»
    (vhost RabbitMQ, namespace Pulsar, account NATS). Квалификатора «Брокер / …» здесь
    не бывает по построению: брокер задан концом связи, искать его по имени незачем."""
    known: set[tuple[uuid.UUID, str]] = set()
    for c in ctx.catalog.channels:
        known.add((c.node_id, c.name))
        if c.group_name:
            known.add((c.node_id, f"{c.group_name}.{c.name}"))
    shape_by_id = {n.id: n.shape for n in ctx.nodes}
    out: list[BrokerEdgeChannelAlert] = []
    for e in ctx.edges:
        if e.id in ctx.descendant_edge_ids:
            continue  # AL32 велит связь удалить — «допишите канал» рядом с этим
            # советом противоречиво (тот же принцип, что у превью импорта).
        # dict.fromkeys — на случай петли «узел сам на себя»: конец один, не два.
        broker_ends = [
            nid for nid in dict.fromkeys((e.source_id, e.target_id)) if shape_by_id.get(nid) == "broker"
        ]
        if not broker_ends:
            continue
        named = (e.channel or "").strip()
        reason: Literal["missing", "unknown"]
        if not named:
            reason = "missing"
        elif any((nid, named) in known for nid in broker_ends):
            continue  # нашёлся хотя бы у одного конца-брокера — шов цел
        else:
            reason = "unknown"
        out.append(
            BrokerEdgeChannelAlert(
                edge_id=e.id,
                source_name=ctx.name(e.source_id),
                target_name=ctx.name(e.target_id),
                broker_name=ctx.name(broker_ends[0]),
                channel=e.channel if named else None,
                reason=reason,
            )
        )
    out.sort(key=lambda a: (a.source_name, a.target_name, a.channel or ""))
    return out
