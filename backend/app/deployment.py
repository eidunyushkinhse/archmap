"""Размещение объектов на площадках развёртывания (docs/tasks/deployment-view.md;
единица размещения — эпик docs/plan-c4-elements.md, решение Р16).

Домен без HTTP: запись набора экземпляров, размещение системы целиком, вычисляемое
поле NodeResponse.sites, правило разбора объявлений импорта и проверка вложенности
площадок. Роутеры (routers/deployment, routers/nodes) переводят отказы PlacementError
в 404/422.

ЕДИНИЦА РАЗМЕЩЕНИЯ — узел с действующим элементом «контейнер» (app/element.py): лист
вне контейнера или контейнер с компонентами. Экземпляры хранятся только у единиц.
- У компонента размещения НЕ БЫВАЕТ — не «унаследовано», а «не бывает»: запись ему
  отказывается 422 (COMPONENT_DETAIL). Тихого перенаправления в контейнер нет нигде:
  оно вернуло бы наследование с другой стороны (ошибка 2026-10, ТЗ §2а п. 14).
- Система размещения не хранит. Записать ей набор площадок значит записать его каждой
  её единице, а её размещение — производное от единиц: площадки, где стоят все, и где
  — часть (partial). Обход вниз останавливается на единице (компоненты контейнера не
  обходятся) и идёт сквозь вложенные системы.
- «Пользователь» живёт вне системы — размещения у него нет.
Экземпляры у компонента или системы (прежние данные, перенос узла — эпик, Ф5) —
«спящие»: размещение их не считает, площадки компонента видит алерт AL36 (has_sites).
При элементе null во всём проекте (узел с детьми — система, лист — контейнер) единица —
лист: ровно правило 2026-10-27.

Элементы (app/element.Elements) — обязательный аргумент всех функций без дефолта
(камень 2 плана эпика): забытый аргумент молча вернул бы прежнюю семантику «единица —
лист».
"""

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.element import Elements
from app.element_marks import build_elements, project_element_rows
from app.models.deployment_instance import DeploymentInstance
from app.models.deployment_site import DeploymentSite
from app.models.node import Node
from app.models.project import Project
from app.schemas.node import NodeSiteOut

PERSON_DETAIL = "У пользователя нет размещения — он живёт вне системы"
EMPTY_CONTAINER = "В «{name}» нет объектов, которые можно разместить"
# Внешняя система (Р42: внешний лист-сервис без элемента) — чёрный ящик: единиц у неё нет
# и не ждут, отказ — без «пустоты», которую надо заполнить.
EXTERNAL_SYSTEM = "«{name}» — внешняя система, её размещение не ведётся"
COMPONENT_DETAIL = "Площадки задаются контейнеру: «{name}» — компонент контейнера «{container}»"
CONTAINER_LEVEL = (
    "Внутри контейнера «{name}» отдельного размещения нет: компоненты развёртываются вместе с ним"
)
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
    """Площадка в размещении узла. partial — только у системы: на площадке стоит часть
    её единиц, а не все."""

    site_id: uuid.UUID
    partial: bool = False


ParentOf = Mapping[uuid.UUID, uuid.UUID | None]


def placeable_units(elements: Elements[uuid.UUID], root_id: uuid.UUID) -> list[uuid.UUID]:
    """Единицы размещения узла root_id: единица — она сама; система — единицы её
    поддерева (сквозь вложенные системы, вниз до первой единицы, без «Пользователей»);
    компонент и «Пользователь» — пусто. Порядок — обход в глубину, дети по имени; обход
    с seen (данные снимков и импорта бывают циклическими) — это Elements.units_under,
    второй реализации обхода здесь нет."""
    return elements.units_under(root_id)


def unit_placements(
    parent_of: ParentOf,
    declared: Mapping[uuid.UUID, Sequence[uuid.UUID]],
    elements: Elements[uuid.UUID],
) -> dict[uuid.UUID, list[uuid.UUID]]:
    """Правило импорта: объявленные площадки узла достаются единицам. Единица берёт
    своё объявление, без него — объявление ближайшей системы над ней (система
    размещается целиком: её объявление получает каждая её единица, контейнер с
    компонентами — целиком, а не его компоненты). Объявления компонентов и
    «Пользователей» не используются: у них размещения не бывает (ввоз замечает это
    раньше — app/import_element). Возвращает только единицы с непустым набором.
    Подъём с seen: цикл родителей без объявления даёт пустое размещение, а не зависание."""
    out: dict[uuid.UUID, list[uuid.UUID]] = {}
    for node_id in parent_of:
        if elements.effective(node_id) != "container":
            continue
        seen: set[uuid.UUID] = set()
        cur: uuid.UUID | None = node_id
        while cur is not None and cur in parent_of and cur not in seen:
            if declared.get(cur) and (cur == node_id or elements.effective(cur) == "system"):
                out[node_id] = list(dict.fromkeys(declared[cur]))
                break
            seen.add(cur)
            cur = parent_of[cur]
    return out


def placement_map(
    parent_of: ParentOf,
    own: Mapping[uuid.UUID, Sequence[uuid.UUID]],
    site_rank: Mapping[uuid.UUID, int],
    elements: Elements[uuid.UUID],
) -> dict[uuid.UUID, list[SitePlace]]:
    """Размещение КАЖДОГО узла карты parent_of. Единица — свои экземпляры (own, в порядке
    площадок); система — площадки её единиц: где стоят все — обычные, где часть —
    partial; без единиц — пусто. Компонент и «Пользователь» — пусто: их экземпляры
    (спящие, прежние данные) не в счёт, как и экземпляры у самой системы."""
    result: dict[uuid.UUID, list[SitePlace]] = {}
    for node_id in parent_of:
        element = elements.effective(node_id)
        if element == "container":
            places = sorted(dict.fromkeys(own.get(node_id, ())), key=lambda s: site_rank.get(s, len(site_rank)))
            result[node_id] = [SitePlace(s) for s in places]
            continue
        units = placeable_units(elements, node_id) if element == "system" else []
        if not units:
            result[node_id] = []
            continue
        counts: dict[uuid.UUID, int] = {}
        for unit in units:
            for site_id in dict.fromkeys(own.get(unit, ())):
                counts[site_id] = counts.get(site_id, 0) + 1
        ordered = sorted(counts, key=lambda s: site_rank.get(s, len(site_rank)))
        result[node_id] = [SitePlace(s, partial=counts[s] < len(units)) for s in ordered]
    return result


def level_refusal(elements: Elements[uuid.UUID], node: Node, has_children: bool) -> str | None:
    """Почему уровень node не открывается на холсте развёртывания; None — открывается.
    Контейнер с компонентами — единица: он стоит на площадках сам, а его компоненты
    отдельно не развёртываются, поэтому внутри него холсту рисовать нечего."""
    if has_children and elements.effective(node.id) == "container":
        return CONTAINER_LEVEL.format(name=node.name)
    return None


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


def project_tree(
    db: Session, project_id: uuid.UUID
) -> tuple[dict[uuid.UUID, uuid.UUID | None], Elements[uuid.UUID]]:
    """Карта «узел → родитель» и действующие элементы всего проекта одной лёгкой
    выборкой (app/element_marks.project_element_rows): по ним считаются единицы системы
    и выводится её размещение."""
    rows = project_element_rows(db, project_id)
    return {r.id: r.parent_id for r in rows}, build_elements(rows)


def set_placements(
    db: Session, project: Project, nodes: Sequence[Node], site_ids: set[uuid.UUID]
) -> int:
    """Задать КАЖДОЙ единице узлов nodes ровно набор площадок site_ids: недостающие
    экземпляры добавить, лишние снять; пустой набор — снять размещение. Единица
    (контейнер, в том числе лист) пишется сама; система размещается целиком — набор
    получает каждая её единица. Узлы — уже проверенные на принадлежность проекту
    (node_or_404 в роутере).

    Отказы — до любой записи, поэтому частично применённого набора не бывает:
    «Пользователь» или компонент среди узлов, система без единиц (пустая или внешняя,
    Р39/Р42) — 422, площадка не из проекта — 404. Возвращает число добавленных и снятых экземпляров (0 — набор уже
    был таким, курсоры двигать не нужно). Коммит — на вызывающей стороне.

    Дерево читается из БД после flush: PATCH узла применяет элемент, форму и родителя
    до размещения (routers/nodes), и набор должен лечь по уже итоговому дереву — сессия
    без autoflush иначе отдала бы прежнее.
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

    db.flush()
    _parent_of, elements = project_tree(db, project.id)
    for node in nodes:
        if elements.effective(node.id) == "component":
            holder_id = elements.container_of(node.id) or node.parent_id
            holder = db.get(Node, holder_id) if holder_id is not None else None
            raise PlacementError(
                COMPONENT_DETAIL.format(name=node.name, container="" if holder is None else holder.name)
            )
    targets: dict[uuid.UUID, None] = {}
    for node in nodes:
        units = placeable_units(elements, node.id)
        if not units:
            text = EXTERNAL_SYSTEM if elements.external_system(node.id) else EMPTY_CONTAINER
            raise PlacementError(text.format(name=node.name))
        for unit in units:
            targets[unit] = None

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
    (импорт мог положить его внутрь системы — это ловит алерт AL25, а не размещение);
    компонент — тоже: placement_map его экземпляры не считает."""
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
    строк размещения: от него зависит и порядок экземпляров единицы."""
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


def unit_instance_counts(db: Session, project_id: uuid.UUID) -> dict[uuid.UUID, int]:
    """Число экземпляров ЕДИНИЦ на каждой площадке проекта (SiteOut.instance_count: окно
    удаления площадки называет, чьё размещение снимется). Спящие экземпляры — у компонента,
    системы, «Пользователя» (прежние данные, перенос узла, правило 5 D34) — не в счёт:
    размещение их не считает, и ни одна строка «Размещение» их не показывает. Проект без
    экземпляров платит одним лёгким запросом, как mark_sites."""
    pairs = (
        db.query(DeploymentInstance.node_id, DeploymentInstance.site_id)
        .filter(DeploymentInstance.project_id == project_id)
        .all()
    )
    if not pairs:
        return {}
    _parent_of, elements = project_tree(db, project_id)
    counts: dict[uuid.UUID, int] = {}
    for node_id, site_id in pairs:
        if elements.effective(node_id) == "container":
            counts[site_id] = counts.get(site_id, 0) + 1
    return counts


def mark_sites(db: Session, project_id: uuid.UUID, nodes: Sequence[Node]) -> None:
    """Проставляет вычисляемый Node.sites на экземплярах перед отдачей NodeResponse.

    Выборка экземпляров проекта — одна на вызов; площадки и дерево с элементами
    читаются, только если экземпляры в проекте есть: проект без размещения платит одним
    лёгким запросом. Дерево нужно всё — размещение системы выводится из единиц любой
    глубины внутри неё, а элемент узла зависит от всех его предков.
    """
    if not nodes:
        return
    sites = project_sites(db, project_id)
    pairs = ordered_instances(db, project_id, sites) if sites else []
    if not pairs:
        for n in nodes:
            n.sites = []
        return
    parent_of, elements = project_tree(db, project_id)
    rank = {site.id: i for i, site in enumerate(sites)}
    places = placement_map(parent_of, own_by_node(pairs), rank, elements)
    sites_by_id = {site.id: site for site in sites}
    for n in nodes:
        n.sites = site_refs(n, places.get(n.id, []), sites_by_id)
