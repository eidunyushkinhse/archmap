"""Размещение объектов на площадках развёртывания (docs/tasks/deployment-view.md).

Домен без HTTP: действующее размещение с наследованием, проверка вложенности площадок,
запись набора экземпляров объекта и вычисляемое поле NodeResponse.sites. Роутеры
(routers/deployment, routers/nodes) переводят отказы PlacementError в 404/422.

Хранятся только СВОИ экземпляры объекта. Объект без своих стоит там же, где ближайший
предок со своими: контейнер ставят на площадку целиком, не перечисляя детей, — это и
есть «от контейнера «Витрина»» на странице объекта. «Пользователь» размещения не имеет
никогда: он живёт вне системы, своё ему не поставить и от контейнера оно не
наследуется.
"""

import uuid
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.models.deployment_instance import DeploymentInstance
from app.models.deployment_site import DeploymentSite
from app.models.node import Node
from app.models.project import Project
from app.schemas.node import NodeSiteOut

PERSON_DETAIL = "У пользователя нет размещения — он живёт вне системы"
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
class EffectiveInstance:
    """Действующий экземпляр объекта: площадка и предок, от которого он унаследован
    (None — экземпляр собственный)."""

    site_id: uuid.UUID
    inherited_from_id: uuid.UUID | None


def effective_instances(
    parent_of: Mapping[uuid.UUID, uuid.UUID | None],
    instances: Iterable[tuple[uuid.UUID, uuid.UUID]],
) -> dict[uuid.UUID, list[EffectiveInstance]]:
    """Действующее размещение КАЖДОГО узла карты parent_of (узел → его родитель).

    instances — свои экземпляры парами (узел, площадка); порядок пар сохраняется в
    ответе, поэтому вызывающий отдаёт их уже упорядоченными (по имени площадки). У
    узла со своими экземплярами действуют они (inherited_from_id = None), иначе —
    экземпляры ближайшего предка, у которого свои есть (inherited_from_id = id этого
    предка), иначе пусто.

    Один проход: от каждого узла поднимаемся по предкам до первого «решённого» узла,
    и результат записывается всей пройденной цепочке — каждый узел решается один раз.
    Подъём с seen: данные снимков и импорта бывают циклическими (урок аудита 2026-10),
    и цикл без своих экземпляров даёт пустое размещение, а не зависание.
    """
    own: dict[uuid.UUID, list[uuid.UUID]] = {}
    for node_id, site_id in instances:
        sites = own.setdefault(node_id, [])
        if site_id not in sites:
            sites.append(site_id)

    # Узел → узел, чьи СВОИ экземпляры у него действуют (он сам или предок), или None.
    source: dict[uuid.UUID, uuid.UUID | None] = {}
    for start in parent_of:
        if start in source:
            continue
        path: list[uuid.UUID] = []
        seen: set[uuid.UUID] = set()
        found: uuid.UUID | None = None
        cur: uuid.UUID | None = start
        while cur is not None and cur in parent_of:
            if cur in source:
                found = source[cur]
                break
            if cur in seen:
                break  # цикл родителей: своих экземпляров на нём не нашлось
            seen.add(cur)
            path.append(cur)
            if cur in own:
                found = cur
                break
            cur = parent_of[cur]
        for node_id in path:
            source[node_id] = found

    result: dict[uuid.UUID, list[EffectiveInstance]] = {}
    for node_id, src in source.items():
        if src is None:
            result[node_id] = []
            continue
        inherited = None if src == node_id else src
        result[node_id] = [EffectiveInstance(site_id, inherited) for site_id in own[src]]
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


def set_placements(
    db: Session, project: Project, nodes: Sequence[Node], site_ids: set[uuid.UUID]
) -> int:
    """Задать КАЖДОМУ узлу ровно набор площадок site_ids: недостающие экземпляры
    добавить, лишние снять; пустой набор — снять всё своё размещение. Узлы — уже
    проверенные на принадлежность проекту (node_or_404 в роутере).

    Отказы — до любой записи, поэтому частично применённого набора не бывает:
    «Пользователь» среди узлов — 422, площадка не из проекта — 404. Возвращает число
    добавленных и снятых экземпляров (0 — набор уже был таким, курсоры двигать не
    нужно). Коммит — на вызывающей стороне.
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

    have: dict[uuid.UUID, dict[uuid.UUID, DeploymentInstance]] = {}
    for inst in db.query(DeploymentInstance).filter(
        DeploymentInstance.node_id.in_([n.id for n in nodes])
    ):
        have.setdefault(inst.node_id, {})[inst.site_id] = inst

    changed = 0
    for node in nodes:
        current = have.get(node.id, {})
        for site_id, inst in current.items():
            if site_id not in site_ids:
                db.delete(inst)
                changed += 1
        # Порядок вставки — по id: детерминизм ради тестов и одинаковых ответов.
        for site_id in sorted(site_ids - current.keys(), key=str):
            db.add(DeploymentInstance(project_id=project.id, node_id=node.id, site_id=site_id))
            changed += 1
    db.flush()
    return changed


def site_refs(
    node: Node,
    effective: Sequence[EffectiveInstance],
    sites_by_id: Mapping[uuid.UUID, DeploymentSite],
    node_names: Mapping[uuid.UUID, str],
) -> list[NodeSiteOut]:
    """Действующее размещение узла строками NodeResponse.sites. «Пользователь» — всегда
    пусто: наследовать размещение контейнера ему тоже не с чего (импорт мог положить
    его внутрь системы — это ловит алерт AL25, а не размещение). node_names — имена
    узлов проекта: подпись предка, от которого размещение унаследовано."""
    if node.shape == "person":
        return []
    out: list[NodeSiteOut] = []
    for e in effective:
        site = sites_by_id.get(e.site_id)
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
                inherited_from_id=e.inherited_from_id,
                inherited_from_name=(
                    None if e.inherited_from_id is None else node_names.get(e.inherited_from_id)
                ),
            )
        )
    return out


def project_sites(db: Session, project_id: uuid.UUID) -> list[DeploymentSite]:
    """Площадки проекта в порядке имени (затем id) — единый порядок для списка, графа и
    строк размещения: от него зависит и порядок действующих экземпляров объекта."""
    return (
        db.query(DeploymentSite)
        .filter(DeploymentSite.project_id == project_id)
        .order_by(DeploymentSite.name, DeploymentSite.id)
        .all()
    )


def ordered_instances(
    db: Session, project_id: uuid.UUID, sites: Sequence[DeploymentSite]
) -> list[tuple[uuid.UUID, uuid.UUID]]:
    """Свои экземпляры проекта парами (узел, площадка), упорядоченные как площадки
    в sites, — вход effective_instances."""
    rank = {site.id: i for i, site in enumerate(sites)}
    pairs = [
        (node_id, site_id)
        for node_id, site_id in db.query(
            DeploymentInstance.node_id, DeploymentInstance.site_id
        ).filter(DeploymentInstance.project_id == project_id)
    ]
    pairs.sort(key=lambda pair: (rank.get(pair[1], len(rank)), str(pair[0])))
    return pairs


def mark_sites(db: Session, project_id: uuid.UUID, nodes: Sequence[Node]) -> None:
    """Проставляет вычисляемый Node.sites на экземплярах перед отдачей NodeResponse.

    Выборка экземпляров проекта — одна на вызов; площадки и карта родителей узлов
    читаются, только если экземпляры в проекте есть: проект без размещения платит
    одним лёгким запросом. Родители нужны по всему проекту — размещение наследуется
    от предка любой глубины; имена — той же выборкой, для подписи «от контейнера».
    """
    if not nodes:
        return
    sites = project_sites(db, project_id)
    pairs = ordered_instances(db, project_id, sites) if sites else []
    if not pairs:
        for n in nodes:
            n.sites = []
        return
    rows = db.query(Node.id, Node.parent_id, Node.name).filter(Node.project_id == project_id).all()
    parent_of = {nid: pid for nid, pid, _name in rows}
    node_names = {nid: name for nid, _pid, name in rows}
    effective = effective_instances(parent_of, pairs)
    sites_by_id = {site.id: site for site in sites}
    for n in nodes:
        n.sites = site_refs(n, effective.get(n.id, []), sites_by_id, node_names)
