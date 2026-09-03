"""Глобальные алерты незавершённости схемы.

Доменный алгоритм, который раньше жил прямо в HTTP-слое (routers.nodes.get_alerts):
по всей схеме проекта находит три класса проблем — «подвисшие» атомарные узлы без
единой связи, связи с концом в промежуточном (контейнерном) узле и изолированные
группы (связные компоненты графа рёбер). HTTP-слой лишь отдаёт готовый ответ.
"""

import uuid
from collections import defaultdict
from typing import Literal

from sqlalchemy import func
from sqlalchemy.orm import Session, aliased

from app.data_refs import (
    CatalogChannel,
    RefStatus,
    catalog_for_project,
    parse_data_refs,
    resolve_data_refs,
)
from app.models.business_process import BusinessProcess
from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.process_message import ProcessMessage
from app.models.process_participant import ProcessParticipant
from app.schemas.node import (
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


def _channel_known(name: str, channels: list[CatalogChannel]) -> bool:
    """Есть ли такой канал в структуре брокера-конца связи.

    Послабления те же, что у пометок (Ф2в): точное имя канала — включая имя С ТОЧКАМИ
    целиком («orders.created» — норма Kafka), — либо «группа.канал» (vhost RabbitMQ,
    namespace Pulsar, account NATS). Квалификатора «Брокер / …» здесь не бывает по
    построению: брокер задан концом связи, искать его по имени незачем.
    """
    for c in channels:
        if c.name == name:
            return True
        if c.group_name and f"{c.group_name}.{c.name}" == name:
            return True
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
    4) контейнеры с СОБСТВЕННЫМИ доками/спекой (grandfather) — логика и спеки
       должны жить на атомарных детях, такие доки распределяют по детям;
    5) люди (shape=person), вложенные в другой узел — по C4 актор живёт на
       контекстном уровне, ВНЕ границы системы;
    6) повисшие сообщения процессов — связь, которой шло сообщение, удалена
       из схемы (edge_id = NULL);
    9) пометки обращений «читает:/пишет:» в схемах логики, не нашедшие свою
       таблицу структуры — обещание факта, которое текст дал, а структура не
       подтверждает (таблицы нет / имя неоднозначно / колонки нет);
    10) то же для событий: пометки «публикует:/потребляет:», не нашедшие свой
       канал в структуре брокеров (канала нет / имя неоднозначно / поля нет);
    11) связи, у которых конец — брокер, а канал не назван (missing) либо назван,
       но структура брокера его не знает (unknown);
    13) шаги процессов без привязки к схеме логики (doc_id = NULL) — алерт
       полноты, той же семьи, что «не описана» у разведки: гаснет привязкой;
    14) объекты с неописанными схемами логики (заглушки разведки — схемы без
       тела): одна запись на объект с числом заглушек, гаснет описанием.
    Контейнеры в проверке (1) не участвуют: прямых связей у них быть не должно
    (это как раз ловит проверка 2), а группировку детей за «подвисание» не считаем.
    """
    all_nodes = db.query(Node).filter(Node.project_id == project_id).all()
    all_edges = db.query(Edge).filter(Edge.project_id == project_id).all()
    name_by_id = {n.id: n.name for n in all_nodes}

    # Промежуточные узлы = те, что являются чьим-то родителем (есть дети)
    intermediate_ids = {
        pid
        for (pid,) in db.query(Node.parent_id)
        .filter(Node.project_id == project_id, Node.parent_id.isnot(None))
        .distinct()
        .all()
    }

    # Узлы, у которых есть хоть одна связь (по сырым концам рёбер)
    connected_ids: set[uuid.UUID] = set()
    for e in all_edges:
        connected_ids.add(e.source_id)
        connected_ids.add(e.target_id)

    disconnected = [
        DisconnectedNodeAlert(node_id=n.id, node_name=n.name)
        for n in all_nodes
        if n.id not in intermediate_ids and n.id not in connected_ids
    ]

    # 2а) Связь узла с СОБСТВЕННЫМ потомком (AL32) — разбирается ДО связей в
    #     контейнер и снимается с них. Вложенность уже выражена иерархией: такая
    #     стрелка семантически пуста, и совет AL6 («уточните конец до конкретного
    #     компонента») отвечает на неё бессмыслицей — конец УЖЕ компонент, притом
    #     этого же контейнера. Полевая находка матрицы федерации (находка 4,
    #     docs/qa-federation-matrix.md): в превью импорта класс уже отделён (К4),
    #     здесь закрывается паритет — иначе превью советует удалить связь, а панель
    #     проекта тут же требует обратного.
    parent_by_id = {n.id: n.parent_id for n in all_nodes}

    def _descends(child: uuid.UUID, ancestor: uuid.UUID) -> bool:
        """Потомок ли child для ancestor (любой глубины). Дерево БД без циклов
        (parent_id — FK на узел того же проекта, цикл создать нечем), но счётчик
        шагов держим: битые данные не должны вешать запрос алертов."""
        parent = parent_by_id.get(child)
        for _ in range(len(parent_by_id) + 1):
            if parent is None:
                return False
            if parent == ancestor:
                return True
            parent = parent_by_id.get(parent)
        return False

    descendant_edges: list[DescendantEdgeAlert] = []
    descendant_edge_ids: set[uuid.UUID] = set()
    for e in all_edges:
        source_is_part = _descends(e.source_id, e.target_id)
        if not source_is_part and not _descends(e.target_id, e.source_id):
            continue
        descendant_edge_ids.add(e.id)
        descendant_edges.append(
            DescendantEdgeAlert(
                edge_id=e.id,
                label=e.label,
                source_id=e.source_id,
                source_name=name_by_id.get(e.source_id, "?"),
                target_id=e.target_id,
                target_name=name_by_id.get(e.target_id, "?"),
                source_is_part=source_is_part,
            )
        )

    intermediate_edges: list[IntermediateEdgeAlert] = []
    for e in all_edges:
        if e.id in descendant_edge_ids:
            continue  # свой класс (AL32) — два совета на одну связь противоречивы
        src_inter = e.source_id in intermediate_ids
        tgt_inter = e.target_id in intermediate_ids
        if src_inter or tgt_inter:
            intermediate_edges.append(
                IntermediateEdgeAlert(
                    edge_id=e.id,
                    label=e.label,
                    source_id=e.source_id,
                    source_name=name_by_id.get(e.source_id, "?"),
                    target_id=e.target_id,
                    target_name=name_by_id.get(e.target_id, "?"),
                    source_is_intermediate=src_inter,
                    target_is_intermediate=tgt_inter,
                )
            )

    # 3) Изолированные группы — связные компоненты графа РЁБЕР (иерархию
    #    parent_id игнорируем: иначе всё связано через дерево). Узлы без
    #    единой связи сюда не попадают (их ловит проверка 1). Алерт зажигаем,
    #    только если связных групп (≥2 узла) больше одной — иначе это просто
    #    единственный кластер плюс висячие узлы, и фрагментации нет.
    adjacency: dict[uuid.UUID, set[uuid.UUID]] = {}
    for e in all_edges:
        adjacency.setdefault(e.source_id, set()).add(e.target_id)
        adjacency.setdefault(e.target_id, set()).add(e.source_id)

    visited: set[uuid.UUID] = set()
    components: list[list[uuid.UUID]] = []
    for start in adjacency:
        if start in visited:
            continue
        stack = [start]
        visited.add(start)
        comp: list[uuid.UUID] = []
        while stack:
            cur = stack.pop()
            comp.append(cur)
            for nxt in adjacency[cur]:
                if nxt not in visited:
                    visited.add(nxt)
                    stack.append(nxt)
        if len(comp) >= 2:
            components.append(comp)

    isolated_groups: list[IsolatedGroupAlert] = []
    if len(components) >= 2:
        for comp in components:
            isolated_groups.append(
                IsolatedGroupAlert(
                    node_ids=comp,
                    node_names=[name_by_id.get(nid, "?") for nid in comp],
                )
            )

    # 4) Контейнеры с собственными доками/спекой (grandfather). Контейнер =
    #    service с детьми. Алерт: узел стал контейнером, но логика/спека
    #    остались на нём — надо распределить по детям.
    node_ids = [n.id for n in all_nodes]
    doc_owner_flat: set[uuid.UUID] = set()
    if node_ids:
        rows = db.query(NodeDoc.node_id).filter(NodeDoc.node_id.in_(node_ids)).distinct().all()
        doc_owner_flat = {nid for (nid,) in rows}

    container_own_docs: list[ContainerOwnDocsAlert] = []
    for n in all_nodes:
        if n.id not in intermediate_ids or n.shape != "service":
            continue
        has_docs = n.id in doc_owner_flat
        has_spec = bool(n.openapi_spec)
        if has_docs or has_spec:
            container_own_docs.append(
                ContainerOwnDocsAlert(
                    node_id=n.id,
                    node_name=n.name,
                    has_docs=has_docs,
                    has_spec=has_spec,
                )
            )

    # 5) Люди внутри системы. Правило C4: актор не может быть частью контейнера.
    #    Промпт импорта его требует, отчёт слияния предупреждает — но объекты,
    #    заведённые РУКАМИ, не проверял никто (остаток находки 2026-08-08).
    persons_inside = [
        PersonInsideAlert(
            node_id=n.id,
            node_name=n.name,
            parent_id=n.parent_id,
            parent_name=name_by_id.get(n.parent_id, "?"),
        )
        for n in all_nodes
        if n.shape == "person" and n.parent_id is not None
    ]

    # 6) Повисшие сообщения процессов. Удаление связи из схемы НЕ сносит сообщение
    #    (ON DELETE SET NULL) — расхождение процесса со схемой должно быть видно, а
    #    не происходить тихо. До сих пор оно было видно только ВНУТРИ окна процесса;
    #    здесь тот же факт поднимается на уровень схемы. Самосообщения исключены:
    #    у внутренней операции участника связи C4 и не было.
    from_p = aliased(ProcessParticipant)
    to_p = aliased(ProcessParticipant)
    dangling_messages = [
        DanglingMessageAlert(
            process_id=proc_id,
            process_name=proc_name,
            message_id=msg_id,
            caption=caption,
            # Живое имя узла, а у непривязанного участника — его собственное:
            # иначе конец повисшего шага показывался бы как «?».
            from_name=name_by_id.get(from_node) or from_own,
            to_name=name_by_id.get(to_node) or to_own,
        )
        for proc_id, proc_name, msg_id, caption, from_node, to_node, from_own, to_own in (
            db.query(
                BusinessProcess.id,
                BusinessProcess.name,
                ProcessMessage.id,
                ProcessMessage.caption,
                from_p.node_id,
                to_p.node_id,
                from_p.name,
                to_p.name,
            )
            .join(ProcessMessage, ProcessMessage.process_id == BusinessProcess.id)
            .join(from_p, from_p.id == ProcessMessage.from_participant_id)
            .join(to_p, to_p.id == ProcessMessage.to_participant_id)
            .filter(
                BusinessProcess.project_id == project_id,
                ProcessMessage.edge_id.is_(None),
                ProcessMessage.from_participant_id != ProcessMessage.to_participant_id,
            )
            .order_by(BusinessProcess.name, ProcessMessage.order)
            .all()
        )
    ]

    # 7) Участники процессов без узла схемы (AL27). Симметрично повисшему сообщению:
    #    линия жизни на диаграмме есть, объекта архитектуры за ней нет. Путь
    #    исправления — привязка участника к узлу прямо на его шапке.
    unbound_participants = [
        UnboundParticipantAlert(
            process_id=proc_id, process_name=proc_name, participant_id=part_id, name=name
        )
        for proc_id, proc_name, part_id, name in (
            db.query(
                BusinessProcess.id,
                BusinessProcess.name,
                ProcessParticipant.id,
                ProcessParticipant.name,
            )
            .join(ProcessParticipant, ProcessParticipant.process_id == BusinessProcess.id)
            .filter(
                BusinessProcess.project_id == project_id,
                ProcessParticipant.node_id.is_(None),
            )
            .order_by(BusinessProcess.name, ProcessParticipant.order)
            .all()
        )
    ]

    # 8) Шаги, у которых пропало ПЛЕЧО канала (AL28). Связь на месте — исчезло
    #    именно плечо: канал сменили на асинхронный уже после создания шага-ответа.
    #    Сравнение с False, а не «not True»: is_synchronous nullable, и NULL значит
    #    синхронный по умолчанию (edge_is_synchronous) — такой шаг цел.
    orphan_legs = [
        OrphanLegAlert(
            process_id=proc_id,
            process_name=proc_name,
            message_id=msg_id,
            caption=caption,
            edge_label=edge_label,
            from_name=name_by_id.get(from_node) or from_own,
            to_name=name_by_id.get(to_node) or to_own,
        )
        for proc_id, proc_name, msg_id, caption, edge_label, from_node, to_node, from_own, to_own in (
            db.query(
                BusinessProcess.id,
                BusinessProcess.name,
                ProcessMessage.id,
                ProcessMessage.caption,
                Edge.label,
                from_p.node_id,
                to_p.node_id,
                from_p.name,
                to_p.name,
            )
            .join(ProcessMessage, ProcessMessage.process_id == BusinessProcess.id)
            .join(Edge, Edge.id == ProcessMessage.edge_id)
            .join(from_p, from_p.id == ProcessMessage.from_participant_id)
            .join(to_p, to_p.id == ProcessMessage.to_participant_id)
            .filter(
                BusinessProcess.project_id == project_id,
                ProcessMessage.leg == "return",
                Edge.is_synchronous.is_(False),
            )
            .order_by(BusinessProcess.name, ProcessMessage.order)
            .all()
        )
    ]

    # 13) Шаги процессов без привязки к схеме логики (AL34). Алерт ПОЛНОТЫ, а не
    #     поломки (Р4 «шумно, зато консистентно»): любой шаг с doc_id = NULL, не
    #     различая «не привязывали» и «схему удалили» (SET NULL гасит ссылку молча).
    #     Самосообщения участвуют наравне — внутренняя операция участника тоже
    #     документируется схемой; повисшие шаги тоже: у них ДВА разных изъяна
    #     (нет опоры в схеме — AL26, нет документации — этот), чинятся порознь.
    unlinked_messages = [
        UnlinkedMessageAlert(
            process_id=proc_id,
            process_name=proc_name,
            message_id=msg_id,
            caption=caption,
            from_name=name_by_id.get(from_node) or from_own,
            to_name=name_by_id.get(to_node) or to_own,
        )
        for proc_id, proc_name, msg_id, caption, from_node, to_node, from_own, to_own in (
            db.query(
                BusinessProcess.id,
                BusinessProcess.name,
                ProcessMessage.id,
                ProcessMessage.caption,
                from_p.node_id,
                to_p.node_id,
                from_p.name,
                to_p.name,
            )
            .join(ProcessMessage, ProcessMessage.process_id == BusinessProcess.id)
            .join(from_p, from_p.id == ProcessMessage.from_participant_id)
            .join(to_p, to_p.id == ProcessMessage.to_participant_id)
            .filter(
                BusinessProcess.project_id == project_id,
                ProcessMessage.doc_id.is_(None),
            )
            .order_by(BusinessProcess.name, ProcessMessage.order)
            .all()
        )
    ]

    # 14) Объекты с неописанными схемами логики (AL35). Заглушка разведки — строка
    #     перечня без тела (docs/plan-recon.md): не схема, а обещание её написать.
    #     Алерт ПОЛНОТЫ той же семьи, что AL34, но ОДНА запись на объект, а не на
    #     заглушку: после разведки монолита заглушек две сотни, и две сотни строк в
    #     панели — стена, а не сигнал; построчный бэклог живёт на странице объекта
    #     (блок «Не описано»). Признак — тот же, что у витрины (NodeDoc.described:
    #     тело после trim пустое). Гаснет, когда все заглушки описаны или удалены.
    undescribed_docs: list[UndescribedDocsAlert] = []
    if node_ids:
        stub_rows = (
            db.query(NodeDoc.node_id, func.count(NodeDoc.id))
            .filter(NodeDoc.node_id.in_(node_ids), ~NodeDoc.described)
            .group_by(NodeDoc.node_id)
            .all()
        )
        undescribed_docs = [
            UndescribedDocsAlert(node_id=nid, node_name=name_by_id.get(nid, "?"), count=cnt)
            for nid, cnt in stub_rows
        ]
        undescribed_docs.sort(key=lambda a: a.node_name)

    # 9) Пометки обращений, не нашедшие цели (AL29, пивот §9 plan-db-docs.md).
    #    «читает: orders.status» в тексте схемы логики — обещание факта, и невыполненное
    #    обещание обязано быть видно: обратный индекс базы такую пометку не показывает
    #    (он отвечает за факты), а обращение с несуществующей колонкой показывает как
    #    обращение к таблице целиком — алерт остаётся единственным местом, где битая
    #    колонка заметна. Резолв — на ЧТЕНИИ, по каталогу всего проекта: хранимых
    #    обращений нет, а значит нет и точек инвалидации.
    tables, channels, params_by_node, node_paths = catalog_for_project(db, project_id)
    unresolved_data_refs: list[UnresolvedDataRefAlert] = []
    unresolved_channel_refs: list[UnresolvedChannelRefAlert] = []
    unresolved_config_refs: list[UnresolvedConfigRefAlert] = []
    for doc_id, doc_name, content, owner_id, owner_name in (
        db.query(NodeDoc.id, NodeDoc.name, NodeDoc.content, Node.id, Node.name)
        .select_from(NodeDoc)
        .join(Node, Node.id == NodeDoc.node_id)
        .filter(Node.project_id == project_id)
        .all()
    ):
        if not content:
            continue
        for ref in resolve_data_refs(
            parse_data_refs(content),
            tables,
            channels,
            node_paths,
            # Конфигурация ВЛАДЕЛЬЦА дока: «зависит от:» ищется только у него.
            owner_params=params_by_node.get(owner_id, {}),
        ):
            if ref.status == "ok":
                continue
            # 12) Пометка «зависит от:» не нашла параметра (AL33). Класс отдельный по
            #     той же причине, что и канальный: своя починка — «опишите ручку в
            #     разделе „Конфигурация“ этого объекта». Причину не передаём: она
            #     здесь ровно одна (см. UnresolvedConfigRefAlert).
            if ref.mode == "config":
                unresolved_config_refs.append(
                    UnresolvedConfigRefAlert(
                        node_id=owner_id,
                        node_name=owner_name,
                        doc_id=doc_id,
                        doc_name=doc_name,
                        ref=ref.ref,
                    )
                )
                continue
            # 10) То же самое для каналов (AL30): пометка «публикует:/потребляет:»
            #     не нашла канал в структуре брокеров. Класс ОТДЕЛЬНЫЙ — причины и
            #     слова починки свои («укажите „Брокер / канал“»), и мешать топики
            #     с таблицами в одной строке панели значит запутать починку.
            if ref.mode == "publish" or ref.mode == "consume":
                channel_reason = _CHANNEL_REASON.get(ref.status)
                if channel_reason is None:
                    continue
                unresolved_channel_refs.append(
                    UnresolvedChannelRefAlert(
                        node_id=owner_id,
                        node_name=owner_name,
                        doc_id=doc_id,
                        doc_name=doc_name,
                        ref=ref.ref,
                        mode=ref.mode,
                        reason=channel_reason,
                    )
                )
                continue
            table_reason = _TABLE_REASON.get(ref.status)
            if table_reason is None:
                continue
            unresolved_data_refs.append(
                UnresolvedDataRefAlert(
                    node_id=owner_id,
                    node_name=owner_name,
                    doc_id=doc_id,
                    doc_name=doc_name,
                    ref=ref.ref,
                    mode=ref.mode,
                    reason=table_reason,
                )
            )
    # Порядок детерминированный: у соседних классов его даёт ORDER BY, здесь он
    # появляется только после разбора текста — сортируем готовые записи.
    unresolved_data_refs.sort(key=lambda a: (a.node_name, a.doc_name, a.ref))
    unresolved_channel_refs.sort(key=lambda a: (a.node_name, a.doc_name, a.ref))
    unresolved_config_refs.sort(key=lambda a: (a.node_name, a.doc_name, a.ref))

    # 11) Связи с брокером, не называющие канал (AL31). Решение пользователя №4
    #     (§4 plan-broker-docs.md): стрелка «сервис → брокер» ОБЯЗАНА назвать топик —
    #     без этого схема не отвечает на «откуда взялось событие». Канал на связи —
    #     ссылка по ИМЕНИ, не FK, поэтому шов держит алерт, а не БД: `missing` —
    #     не указан вовсе, `unknown` — указан, но структура брокера-конца его не знает.
    #     Направление в резолве не участвует (публикация и доставка равноправны,
    #     см. edge.md E83) — ищем у ЛЮБОГО конца-брокера.
    channels_by_node: dict[uuid.UUID, list[CatalogChannel]] = defaultdict(list)
    for c in channels:
        channels_by_node[c.node_id].append(c)
    shape_by_id = {n.id: n.shape for n in all_nodes}
    broker_edge_channels: list[BrokerEdgeChannelAlert] = []
    for e in all_edges:
        if e.id in descendant_edge_ids:
            continue  # AL32 велит связь удалить — «допишите канал» рядом с этим
            # советом противоречиво (тот же принцип, что у превью импорта).
        # dict.fromkeys — на случай петли «узел сам на себя»: конец один, не два.
        broker_ends = [
            nid
            for nid in dict.fromkeys((e.source_id, e.target_id))
            if shape_by_id.get(nid) == "broker"
        ]
        if not broker_ends:
            continue
        named = (e.channel or "").strip()
        reason: Literal["missing", "unknown"]
        if not named:
            reason = "missing"
        elif any(_channel_known(named, channels_by_node[nid]) for nid in broker_ends):
            continue  # нашёлся хотя бы у одного конца-брокера — шов цел
        else:
            reason = "unknown"
        broker_edge_channels.append(
            BrokerEdgeChannelAlert(
                edge_id=e.id,
                source_name=name_by_id.get(e.source_id, "?"),
                target_name=name_by_id.get(e.target_id, "?"),
                broker_name=name_by_id.get(broker_ends[0], "?"),
                channel=e.channel if named else None,
                reason=reason,
            )
        )
    broker_edge_channels.sort(key=lambda a: (a.source_name, a.target_name, a.channel or ""))

    return AlertsResponse(
        disconnected_nodes=disconnected,
        intermediate_edges=intermediate_edges,
        isolated_groups=isolated_groups,
        container_own_docs=container_own_docs,
        persons_inside=persons_inside,
        dangling_messages=dangling_messages,
        unbound_participants=unbound_participants,
        orphan_legs=orphan_legs,
        unlinked_messages=unlinked_messages,
        undescribed_docs=undescribed_docs,
        unresolved_data_refs=unresolved_data_refs,
        unresolved_channel_refs=unresolved_channel_refs,
        unresolved_config_refs=unresolved_config_refs,
        broker_edge_channels=broker_edge_channels,
        descendant_edges=descendant_edges,
    )
