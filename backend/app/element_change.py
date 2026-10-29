"""Смена элемента архитектуры и перенос узла с последствиями для размещения (Р18 эпика
docs/plan-c4-elements.md).

Размещение живёт только у единиц — узлов с действующим элементом «контейнер» (D33):
смена элемента у узла с детьми или перенос узла внутрь контейнера и наружу меняет, кто
единица, и площадки без переноса молча уснули бы у компонентов. Поэтому перенос
размещения — часть той же правки (PATCH /nodes/{id}, одна транзакция; отдельной ручки нет:
одна точка для интерфейса, MCP и повторов Undo/Redo). Четыре случая:
1. система → контейнер: узел получает объединение площадок своих единиц (до смены);
2. контейнер → система: каждая единица после смены (в том числе листья бывших составных
   компонентов) получает площадки контейнера;
3. вход в контейнер (переносимое становится компонентом): целевой контейнер добавляет к
   своим площадкам объединение площадок единиц переносимого поддерева;
4. выход из контейнера (переносимое перестаёт быть компонентом): каждая единица
   переносимого поддерева получает площадки прежнего контейнера (у него они остаются).
Контейнер → контейнер, компонент → компонент другого контейнера, лист без детей,
«Пользователь» — ничего не переезжает (none). Компоненты после операции экземпляров не
держат: их экземпляры удаляются, спящих остатков от операции не бывает. Спецификация,
конфигурация и схемы логики автоматически не переезжают никогда — их переносят явные
действия (Р19), а пока они не на месте, их отмечают рекомендации (AL24, AL36).

Чистое ядро (relocation) — над двумя Elements (до и после) и картой экземпляров; превью
и применение считают одно и то же, поэтому окно показывает ровно то, что запишется.
"""

import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.deployment import ordered_instances, own_by_node, project_sites
from app.domain_types import ElementChangeKind
from app.element import Elements
from app.element_marks import ElementRow, build_elements, project_element_rows
from app.models.config_param import ConfigParam
from app.models.deployment_instance import DeploymentInstance
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.project import Project
from app.schemas.node import ElementChangePreview, PlacementRowOut

Own = Mapping[uuid.UUID, Sequence[uuid.UUID]]


@dataclass(frozen=True)
class Relocation:
    """Что делает с размещением одна правка узла.

    own_after — новые наборы площадок затронутых узлов (пустой — снять все экземпляры);
    before_units и after_units — участники таблицы окна до и после, в порядке строк;
    holder — контейнер-участник переноса (цель или прежний); future_components — кто
    станет компонентом (их спецификацию и конфигурацию отметит AL36); former_container —
    контейнер, ставший системой (его собственную документацию отметит AL24)."""

    kind: ElementChangeKind
    own_after: dict[uuid.UUID, list[uuid.UUID]]
    before_units: list[uuid.UUID]
    after_units: list[uuid.UUID]
    holder: uuid.UUID | None = None
    future_components: tuple[uuid.UUID, ...] = ()
    former_container: uuid.UUID | None = None


NOTHING = Relocation("none", {}, [], [])


def _union(lists: Sequence[Sequence[uuid.UUID]], rank: Mapping[uuid.UUID, int]) -> list[uuid.UUID]:
    """Объединение наборов площадок в порядке площадок проекта."""
    merged = dict.fromkeys(site for sites in lists for site in sites)
    return sorted(merged, key=lambda s: rank.get(s, len(rank)))


def relocation(
    before: Elements[uuid.UUID],
    after: Elements[uuid.UUID],
    node_id: uuid.UUID,
    own: Own,
    rank: Mapping[uuid.UUID, int],
    *,
    moved: bool,
) -> Relocation:
    """Последствия правки узла node_id для размещения. before и after — элементы дерева
    до и после правки; own — экземпляры до неё; moved — правка переносит узел (иначе —
    меняет его элемент)."""
    was, will = before.effective(node_id), after.effective(node_id)
    subtree = [node_id, *after.descendants(node_id)]
    if moved and was in ("system", "container") and will == "component":
        holder = after.container_of(node_id)
        if holder is None:  # компонент без контейнера бывает только в цикле данных
            return NOTHING
        units = before.units_under(node_id)
        out: dict[uuid.UUID, list[uuid.UUID]] = {n: [] for n in subtree}
        out[holder] = _union([own.get(holder, ()), *(own.get(u, ()) for u in units)], rank)
        return Relocation(
            "join_container", out, [holder, *units], [holder], holder=holder,
            future_components=tuple(n for n in subtree if after.effective(n) == "component"),
        )
    if moved and was == "component" and will in ("system", "container"):
        holder = before.container_of(node_id)
        if holder is None:
            return NOTHING
        sites = list(own.get(holder, ()))
        units = after.units_under(node_id)
        out = {n: [] for n in subtree}
        for unit in units:
            out[unit] = list(sites)
        return Relocation("leave_container", out, [holder], [holder, *units], holder=holder)
    if not moved and was == "system" and will == "container":
        units = before.units_under(node_id)
        out = {n: [] for n in after.members_of(node_id)}
        out[node_id] = _union([own.get(u, ()) for u in units], rank)
        return Relocation(
            "system_to_container", out, units, [node_id],
            future_components=tuple(
                n for n in after.members_of(node_id) if after.effective(n) == "component"
            ),
        )
    if not moved and was == "container" and will == "system":
        sites = list(own.get(node_id, ()))
        units = after.units_under(node_id)
        # Внутри бывшего контейнера держат площадки только новые единицы: составные
        # компоненты стали системами, а их собственные экземпляры (спящие) снимаются.
        out = {n: [] for n in subtree}
        for unit in units:
            out[unit] = list(sites)
        return Relocation(
            "container_to_system", out, [node_id], units, former_container=node_id
        )
    return NOTHING


def _apply_own(own: Own, change: Relocation) -> dict[uuid.UUID, list[uuid.UUID]]:
    """Экземпляры после правки: затронутые узлы — новые наборы, прочие — как были."""
    result = {n: list(sites) for n, sites in own.items()}
    result.update(change.own_after)
    return result


def _patched(
    rows: Sequence[ElementRow], node_id: uuid.UUID, row_of: Callable[[ElementRow], ElementRow]
) -> list[ElementRow]:
    """Записи дерева, где запись одного узла заменена (row_of — подмена полей)."""
    return [row_of(r) if r.id == node_id else r for r in rows]


@dataclass
class _State:
    """Экземпляры проекта и порядок площадок — общее у превью и применения."""

    own: dict[uuid.UUID, list[uuid.UUID]]
    rank: dict[uuid.UUID, int]
    site_names: dict[uuid.UUID, str]


def _state(db: Session, project_id: uuid.UUID) -> _State:
    sites = project_sites(db, project_id)
    pairs = ordered_instances(db, project_id, sites) if sites else []
    return _State(
        own=own_by_node(pairs),
        rank={site.id: i for i, site in enumerate(sites)},
        site_names={site.id: site.name for site in sites},
    )


def _rows_out(
    units: Sequence[uuid.UUID],
    own: Own,
    names: Mapping[uuid.UUID, str],
    state: _State,
) -> list[PlacementRowOut]:
    """Строки таблицы окна: только объекты с непустыми площадками, без повторов."""
    out: list[PlacementRowOut] = []
    for node_id in dict.fromkeys(units):
        sites = [state.site_names[s] for s in own.get(node_id, ()) if s in state.site_names]
        if sites:
            out.append(PlacementRowOut(node_id=node_id, name=names.get(node_id, ""), sites=sites))
    return out


def _docs_names(db: Session, change: Relocation, names: Mapping[uuid.UUID, str]) -> list[str]:
    """Объекты, чья документация останется на месте и попадёт в рекомендации: будущие
    компоненты со спецификацией или конфигурацией (AL36) или контейнер, ставший
    системой, со своими схемами, спецификацией или конфигурацией (AL24)."""
    if change.former_container is not None:
        node_id = change.former_container
        has = (
            db.query(Node.id).filter(Node.id == node_id, Node.openapi_spec.isnot(None),
                                      Node.openapi_spec != "").first() is not None
            or db.query(ConfigParam.id).filter(ConfigParam.node_id == node_id).first() is not None
            or db.query(NodeDoc.id).filter(NodeDoc.node_id == node_id).first() is not None
        )
        return [names[node_id]] if has else []
    ids = list(change.future_components)
    if not ids:
        return []
    with_spec = {
        nid for (nid,) in db.query(Node.id).filter(
            Node.id.in_(ids), Node.openapi_spec.isnot(None), Node.openapi_spec != ""
        )
    }
    with_config = {
        nid for (nid,) in db.query(ConfigParam.node_id).filter(ConfigParam.node_id.in_(ids)).distinct()
    }
    return [names[n] for n in ids if n in with_spec or n in with_config]


def preview(
    db: Session,
    project: Project,
    node: Node,
    *,
    element: str | None = None,
    parent_id: uuid.UUID | None = None,
    moved: bool,
) -> ElementChangePreview:
    """Превью правки БЕЗ записи: смена элемента на element (moved=False) или перенос под
    parent_id (moved=True). Отказы правил — на вызывающем (роутер проверяет теми же
    функциями, что PATCH)."""
    rows = project_element_rows(db, project.id)
    names = {r.id: r.name for r in rows}
    after_rows = (
        _patched(rows, node.id, lambda r: r._replace(parent_id=parent_id))
        if moved
        else _patched(rows, node.id, lambda r: r._replace(element=element))
    )
    state = _state(db, project.id)
    change = relocation(
        build_elements(rows), build_elements(after_rows), node.id, state.own, state.rank,
        moved=moved,
    )
    own_after = _apply_own(state.own, change)
    return ElementChangePreview(
        kind=change.kind,
        before=_rows_out(change.before_units, state.own, names, state),
        after=_rows_out(change.after_units, own_after, names, state),
        docs_names=_docs_names(db, change, names),
        container_name=names.get(change.holder) if change.holder is not None else None,
    )


def apply(
    db: Session,
    project: Project,
    node: Node,
    *,
    old_parent: uuid.UUID | None,
    old_shape: str,
    old_name: str,
    old_element: str | None,
    moved: bool,
    element_changed: bool,
) -> int:
    """Перенести размещение по уже присвоенной правке узла (routers/nodes.update_node).
    Перенос и смена элемента в одном запросе применяются последовательно: сначала
    родитель, потом элемент. Возвращает число добавленных и снятых экземпляров (0 —
    курсоры двигать не нужно). Коммит — на вызывающей стороне."""
    if not (moved or element_changed):
        return 0
    db.flush()
    final = project_element_rows(db, project.id)
    # Промежуточное дерево — перенос уже сделан, элемент прежний; исходное — всё прежнее.
    middle = _patched(final, node.id, lambda r: r._replace(element=old_element))
    start = _patched(
        middle, node.id,
        lambda r: r._replace(parent_id=old_parent, shape=old_shape, name=old_name),
    )
    state = _state(db, project.id)
    own = state.own
    if moved:
        own = _apply_own(own, relocation(
            build_elements(start), build_elements(middle), node.id, own, state.rank, moved=True,
        ))
    if element_changed:
        own = _apply_own(own, relocation(
            build_elements(middle), build_elements(final), node.id, own, state.rank, moved=False,
        ))
    return _write(db, project, state.own, own)


def _write(
    db: Session,
    project: Project,
    before: Own,
    after: Mapping[uuid.UUID, Sequence[uuid.UUID]],
) -> int:
    """Записать разницу наборов экземпляров (как app/deployment.set_placements)."""
    touched = [n for n in after if set(after[n]) != set(before.get(n, ()))]
    if not touched:
        return 0
    have: dict[uuid.UUID, dict[uuid.UUID, DeploymentInstance]] = {}
    for inst in db.query(DeploymentInstance).filter(DeploymentInstance.node_id.in_(touched)):
        have.setdefault(inst.node_id, {})[inst.site_id] = inst
    changed = 0
    for node_id in touched:
        want = set(after[node_id])
        current = have.get(node_id, {})
        for site_id, inst in current.items():
            if site_id not in want:
                db.delete(inst)
                changed += 1
        # Порядок вставки — по id: детерминизм ради тестов и одинаковых ответов.
        for site_id in sorted(want - current.keys(), key=str):
            db.add(DeploymentInstance(project_id=project.id, node_id=node_id, site_id=site_id))
            changed += 1
    db.flush()
    return changed
