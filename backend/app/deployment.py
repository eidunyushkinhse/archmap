"""Размещение объектов на площадках развёртывания (docs/tasks/deployment-view.md).

Домен без HTTP: запись набора экземпляров, размещение контейнера целиком, вычисляемое
поле NodeResponse.sites, правило разбора объявлений импорта и проверка вложенности
площадок. Роутеры (routers/deployment, routers/nodes) переводят отказы PlacementError
в 404/422.

Размещение хранится только у ОБЪЕКТОВ — листьев дерева (узлов без детей), кроме
«Пользователя»: он живёт вне системы. Контейнер размещается целиком: записать ему
набор площадок значит записать его каждому объекту внутри, а его собственное
размещение — производное от объектов (площадки, где стоят все они, и где — часть).
Наследования как отдельного понятия нет (решение 2026-10-27): у объекта внутри
размещённого контейнера своя галочка на той же площадке, что и у контейнера.
"""

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.models.deployment_instance import DeploymentInstance
from app.models.deployment_site import DeploymentSite
from app.models.node import Node
from app.models.project import Project
from app.schemas.node import NodeSiteOut

PERSON_DETAIL = "У пользователя нет размещения — он живёт вне системы"
EMPTY_CONTAINER = "В «{name}» нет объектов, которые можно разместить"
SITE_NOT_FOUND = "Площадка не найдена"
PARENT_NOT_FOUND = "Родительская площадка не найдена"


class PlacementError(ValueError):
    """Размещение записать нельзя: роутер переводит в HTTP с этим статусом
    (404 — площадки нет в проекте, 422 — правило предметной области)."""

    def __init__(self, detail: str, status: int = 422) -> None:
        super().__init__(detail)
        self.detail = detail
        self.status = status


@dataclass(frozen=True)
class SitePlace:
    """Площадка в размещении узла. partial — только у контейнера: на площадке стоит
    часть его объектов, а не все."""

    site_id: uuid.UUID
    partial: bool = False


ParentOf = Mapping[uuid.UUID, uuid.UUID | None]
Shapes = Mapping[uuid.UUID, str]


def _children(parent_of: ParentOf) -> dict[uuid.UUID, list[uuid.UUID]]:
    kids: dict[uuid.UUID, list[uuid.UUID]] = {}
    for node_id, parent_id in parent_of.items():
        if parent_id is not None and parent_id != node_id:
            kids.setdefault(parent_id, []).append(node_id)
    return kids


def placeable_leaves(parent_of: ParentOf, shapes: Shapes, root_id: uuid.UUID) -> list[uuid.UUID]:
    """Объекты узла root_id, у которых есть размещение: он сам, если он лист (не
    «Пользователь»), иначе листья его поддерева без «Пользователей». Порядок — обход
    в глубину; с seen: данные снимков и импорта бывают циклическими."""
    kids = _children(parent_of)
    out: list[uuid.UUID] = []
    seen: set[uuid.UUID] = set()
    stack = [root_id]
    while stack:
        cur = stack.pop()
        if cur in seen:
            continue
        seen.add(cur)
        children = kids.get(cur, [])
        if children:
            stack.extend(reversed(children))
        elif shapes.get(cur) != "person":
            out.append(cur)
    return out


def leaf_placements(
    parent_of: ParentOf, shapes: Shapes, declared: Mapping[uuid.UUID, Sequence[uuid.UUID]]
) -> dict[uuid.UUID, list[uuid.UUID]]:
    """Правило импорта: объявленные площадки узла достаются его объектам. Лист берёт
    своё объявление, без него — объявление ближайшего предка (контейнер размещается
    целиком). Возвращает только листья с непустым набором; «Пользователь» — никогда.
    Подъём с seen: цикл родителей без объявления даёт пустое размещение, а не зависание."""
    kids = _children(parent_of)
    out: dict[uuid.UUID, list[uuid.UUID]] = {}
    for node_id in parent_of:
        if node_id in kids or shapes.get(node_id) == "person":
            continue
        seen: set[uuid.UUID] = set()
        cur: uuid.UUID | None = node_id
        while cur is not None and cur in parent_of and cur not in seen:
            if declared.get(cur):
                out[node_id] = list(dict.fromkeys(declared[cur]))
                break
            seen.add(cur)
            cur = parent_of[cur]
    return out


def placement_map(
    parent_of: ParentOf,
    shapes: Shapes,
    own: Mapping[uuid.UUID, Sequence[uuid.UUID]],
    site_rank: Mapping[uuid.UUID, int],
) -> dict[uuid.UUID, list[SitePlace]]:
    """Размещение КАЖДОГО узла карты parent_of. Лист — свои экземпляры (own, в порядке
    площадок); контейнер — площадки его объектов: где стоят все — обычные, где часть —
    partial; без объектов — пусто. Экземпляры у самого контейнера (данные прежней
    модели) не в счёт — его размещение всегда выводится из объектов."""
    kids = _children(parent_of)
    result: dict[uuid.UUID, list[SitePlace]] = {}
    for node_id in parent_of:
        if shapes.get(node_id) == "person":
            result[node_id] = []
            continue
        if node_id not in kids:
            places = sorted(dict.fromkeys(own.get(node_id, ())), key=lambda s: site_rank.get(s, len(site_rank)))
            result[node_id] = [SitePlace(s) for s in places]
            continue
        leaves = placeable_leaves(parent_of, shapes, node_id)
        if not leaves:
            result[node_id] = []
            continue
        counts: dict[uuid.UUID, int] = {}
        for leaf in leaves:
            for site_id in dict.fromkeys(own.get(leaf, ())):
                counts[site_id] = counts.get(site_id, 0) + 1
        ordered = sorted(counts, key=lambda s: site_rank.get(s, len(site_rank)))
        result[node_id] = [SitePlace(s, partial=counts[s] < len(leaves)) for s in ordered]
    return result


def check_site_parent(
    sites_by_id: Mapping[uuid.UUID, DeploymentSite],
    site: DeploymentSite,
    new_parent_id: uuid.UUID | None,
) -> str | None:
    """Почему площадку site нельзя вложить в new_parent_id; None — можно.

    sites_by_id — площадки проекта. Цикл ловится подъёмом от нового родителя: если
    по дороге встретилась сама площадка, родитель — её же вложенная. Подъём с seen:
    цикл в данных (его отсекает эта же проверка, но страховка дешевле зависания) не
    вешает обход.
    """
    if new_parent_id is None:
        return None
    if new_parent_id == site.id:
        return "Площадку нельзя вложить в саму себя"
    if new_parent_id not in sites_by_id:
        return PARENT_NOT_FOUND
    seen: set[uuid.UUID] = set()
    cur: uuid.UUID | None = new_parent_id
    while cur is not None and cur in sites_by_id and cur not in seen:
        if cur == site.id:
            return "Площадку нельзя вложить в её же вложенную площадку"
        seen.add(cur)
        cur = sites_by_id[cur].parent_id
    return None


def project_tree(db: Session, project_id: uuid.UUID) -> tuple[dict[uuid.UUID, uuid.UUID | None], dict[uuid.UUID, str]]:
    """Карты «узел → родитель» и «узел → форма» всего проекта одним лёгким запросом:
    по ним считаются объекты контейнера и выводится его размещение."""
    rows = db.query(Node.id, Node.parent_id, Node.shape).filter(Node.project_id == project_id).all()
    return {nid: pid for nid, pid, _shape in rows}, {nid: shape for nid, _pid, shape in rows}


def set_placements(
    db: Session, project: Project, nodes: Sequence[Node], site_ids: set[uuid.UUID]
) -> int:
    """Задать КАЖДОМУ объекту узлов nodes ровно набор площадок site_ids: недостающие
    экземпляры добавить, лишние снять; пустой набор — снять размещение. Контейнер
    размещается целиком: объекты — листья его поддерева без «Пользователей». Узлы —
    уже проверенные на принадлежность проекту (node_or_404 в роутере).

    Отказы — до любой записи, поэтому частично применённого набора не бывает:
    «Пользователь» среди узлов или контейнер без объектов — 422, площадка не из
    проекта — 404. Возвращает число добавленных и снятых экземпляров (0 — набор уже
    был таким, курсоры двигать не нужно). Коммит — на вызывающей стороне.
    """
    if any(n.shape == "person" for n in nodes):
        raise PlacementError(PERSON_DETAIL)
    if site_ids:
        found = {
            sid
            for (sid,) in db.query(DeploymentSite.id).filter(
                DeploymentSite.id.in_(site_ids), DeploymentSite.project_id == project.id
            )
        }
        if site_ids - found:
            raise PlacementError(SITE_NOT_FOUND, 404)
    if not nodes:
        return 0

    parent_of, shapes = project_tree(db, project.id)
    targets: dict[uuid.UUID, None] = {}
    for node in nodes:
        leaves = placeable_leaves(parent_of, shapes, node.id)
        if not leaves:
            raise PlacementError(EMPTY_CONTAINER.format(name=node.name))
        for leaf in leaves:
            targets[leaf] = None

    have: dict[uuid.UUID, dict[uuid.UUID, DeploymentInstance]] = {}
    for inst in db.query(DeploymentInstance).filter(DeploymentInstance.node_id.in_(list(targets))):
        have.setdefault(inst.node_id, {})[inst.site_id] = inst

    changed = 0
    for node_id in targets:
        current = have.get(node_id, {})
        for site_id, inst in current.items():
            if site_id not in site_ids:
                db.delete(inst)
                changed += 1
        # Порядок вставки — по id: детерминизм ради тестов и одинаковых ответов.
        for site_id in sorted(site_ids - current.keys(), key=str):
            db.add(DeploymentInstance(project_id=project.id, node_id=node_id, site_id=site_id))
            changed += 1
    db.flush()
    return changed


def site_refs(
    node: Node,
    places: Sequence[SitePlace],
    sites_by_id: Mapping[uuid.UUID, DeploymentSite],
) -> list[NodeSiteOut]:
    """Размещение узла строками NodeResponse.sites. «Пользователь» — всегда пусто
    (импорт мог положить его внутрь системы — это ловит алерт AL25, а не размещение)."""
    if node.shape == "person":
        return []
    out: list[NodeSiteOut] = []
    for p in places:
        site = sites_by_id.get(p.site_id)
        if site is None:
            continue
        parent = sites_by_id.get(site.parent_id) if site.parent_id is not None else None
        out.append(
            NodeSiteOut(
                id=site.id,
                name=site.name,
                kind=site.kind,
                parent_id=site.parent_id,
                parent_name=None if parent is None else parent.name,
                partial=p.partial,
            )
        )
    return out


def project_sites(db: Session, project_id: uuid.UUID) -> list[DeploymentSite]:
    """Площадки проекта в порядке имени (затем id) — единый порядок для списка, графа и
    строк размещения: от него зависит и порядок экземпляров объекта."""
    return (
        db.query(DeploymentSite)
        .filter(DeploymentSite.project_id == project_id)
        .order_by(DeploymentSite.name, DeploymentSite.id)
        .all()
    )


def ordered_instances(
    db: Session, project_id: uuid.UUID, sites: Sequence[DeploymentSite]
) -> list[tuple[uuid.UUID, uuid.UUID]]:
    """Экземпляры проекта парами (узел, площадка), упорядоченные как площадки в sites."""
    rank = {site.id: i for i, site in enumerate(sites)}
    pairs = [
        (node_id, site_id)
        for node_id, site_id in db.query(
            DeploymentInstance.node_id, DeploymentInstance.site_id
        ).filter(DeploymentInstance.project_id == project_id)
    ]
    pairs.sort(key=lambda pair: (rank.get(pair[1], len(rank)), str(pair[0])))
    return pairs


def own_by_node(pairs: Sequence[tuple[uuid.UUID, uuid.UUID]]) -> dict[uuid.UUID, list[uuid.UUID]]:
    """Пары (узел, площадка) → площадки каждого узла в порядке пар."""
    own: dict[uuid.UUID, list[uuid.UUID]] = {}
    for node_id, site_id in pairs:
        own.setdefault(node_id, []).append(site_id)
    return own


def mark_sites(db: Session, project_id: uuid.UUID, nodes: Sequence[Node]) -> None:
    """Проставляет вычисляемый Node.sites на экземплярах перед отдачей NodeResponse.

    Выборка экземпляров проекта — одна на вызов; площадки и карта дерева читаются,
    только если экземпляры в проекте есть: проект без размещения платит одним лёгким
    запросом. Дерево нужно всё — размещение контейнера выводится из объектов любой
    глубины внутри него.
    """
    if not nodes:
        return
    sites = project_sites(db, project_id)
    pairs = ordered_instances(db, project_id, sites) if sites else []
    if not pairs:
        for n in nodes:
            n.sites = []
        return
    parent_of, shapes = project_tree(db, project_id)
    rank = {site.id: i for i, site in enumerate(sites)}
    places = placement_map(parent_of, shapes, own_by_node(pairs), rank)
    sites_by_id = {site.id: site for site in sites}
    for n in nodes:
        n.sites = site_refs(n, places.get(n.id, []), sites_by_id)
