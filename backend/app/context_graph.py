"""Контекстный граф страницы объекта (single-schema).

Доменный алгоритм, который раньше жил прямо в HTTP-слое
(routers.nodes.get_node_context_graph): собирает контекст объекта — виртуальный
корневой уровень «фокус + представители соседей» — в формате СЫРОГО графа уровня
(GraphResponse), который фронт рендерит тем же level-конвейером, что и обычный
уровень. Проекция концов на видимые сущности — на фронте (graph/projection.ts).
"""

import uuid
from collections import Counter
from typing import cast

from sqlalchemy.orm import Session

from app import tree
from app.graph_queries import ghost_registry, project_has_status_info, read_view_layout
from app.models.edge import Edge
from app.models.node import Node
from app.models.project import Project
from app.schemas.node import GraphEdgeResponse, GraphResponse, NodeResponse
from app.view_state import current_version


def build_context_graph(db: Session, project: Project, focus: Node) -> GraphResponse:
    """Контекст объекта в формате СЫРОГО графа уровня — «Схема» страницы объекта
    (single-schema): виртуальный корневой уровень, который фронт рендерит тем же
    level-конвейером, что и обычный уровень. Форма ответа — GraphResponse:

    - nodes (локалы) = фокус + ПРЕДСТАВИТЕЛИ соседей: сиблинги фокуса (дети того
      же родителя; на корне — корневые узлы), в чьём поддереве лежит хотя бы один
      сосед. Несвязанные сиблинги уровня в контекст не попадают.
    - edges — СЫРЫЕ рёбра контекста (реальные концы, проекция — на фронте):
      внутренние поддерева фокуса (питают раскрытие R5), граничные (ровно один
      конец в поддереве — сам контекст) и сосед↔сосед (связи между соседями —
      как в «отдельном проекте», куда положили объект и его соседей).
    - endpoints — реестр не-локальных концов этих рёбер с цепочками предков.
    - layout — сохранённая раскладка ВИДА ФОКУСА (view_id = focus.id): архитектор
      двигает узлы на странице с персистом (как на обычном холсте). Нет сохранённой
      → пустой dict → фронт раскладывает свежим ELK (первый просмотр). Сохранённые
      координаты общего холста на страницу не переносятся — у каждой страницы СВОЙ
      вид (решение 2026-08-02; инвариант X13 переписан).
    """
    all_nodes = {n.id: n for n in db.query(Node).filter(Node.project_id == project.id).all()}
    all_edges = db.query(Edge).filter(Edge.project_id == project.id).all()
    subtree = tree.subtree_ids(all_nodes, focus.id)

    # Соседи — внешние сырые концы граничных рёбер поддерева фокуса.
    neighbor_ids: set[uuid.UUID] = set()
    for e in all_edges:
        s_in = e.source_id in subtree
        t_in = e.target_id in subtree
        if s_in != t_in:
            neighbor_ids.add(e.target_id if s_in else e.source_id)

    # Представители соседей среди сиблингов фокуса: контекст — это уровень
    # родителя, обрезанный до связанной с фокусом части, поэтому сосед из
    # поддерева сиблинга показывается этим сиблингом (глубокий конец поднимет
    # фронтовая проекция), а сосед вне родителя останется гостем реестра.
    # ПОРЯДОК локалов — порядок ЗАПРОСА УРОВНЯ (как у get_root_graph/get_node_graph):
    # ELK чувствителен к порядку входа — детерминированная раскладка страницы.
    siblings = (
        db.query(Node)
        .filter(Node.project_id == project.id, Node.parent_id == focus.parent_id)
        .all()
    )
    local_nodes = [
        n
        for n in siblings
        if n.id == focus.id or tree.subtree_ids(all_nodes, n.id) & neighbor_ids
    ]
    local_ids = {n.id for n in local_nodes}

    result_edges: list[GraphEdgeResponse] = []
    endpoint_ids: set[uuid.UUID] = set()
    for e in all_edges:
        touches_subtree = e.source_id in subtree or e.target_id in subtree
        both_neighbors = e.source_id in neighbor_ids and e.target_id in neighbor_ids
        if not (touches_subtree or both_neighbors):
            continue
        result_edges.append(
            GraphEdgeResponse(
                id=e.id,
                label=e.label,
                technology=e.technology,
                channel=e.channel,
                source_id=e.source_id,
                target_id=e.target_id,
                version=e.version,
            )
        )
        for nid in (e.source_id, e.target_id):
            if nid not in local_ids:
                endpoint_ids.add(nid)

    child_counts = Counter(n.parent_id for n in all_nodes.values() if n.parent_id is not None)
    for n in local_nodes:
        n.child_count = child_counts.get(n.id, 0)
        n.has_children = n.child_count > 0
    # ORM-узлы сериализуются в NodeResponse через from_attributes (child_count/
    # has_children проставлены выше) — на границе сериализации типизируем как
    # list[NodeResponse].
    return GraphResponse(
        nodes=cast(list[NodeResponse], local_nodes),
        edges=result_edges,
        endpoints=ghost_registry(all_nodes, endpoint_ids, child_counts),
        layout=read_view_layout(db, project.id, focus.id),
        version=current_version(db, project.id, focus.id),
        graph_rev=project.graph_rev,
        meta_rev=project.meta_rev,
        has_status_info=project_has_status_info(db, project.id),
    )
