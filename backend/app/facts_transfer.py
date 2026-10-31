"""Перенос фактов по элементу архитектуры: «Перенести документацию» и «Собрать с
компонентов» (Р19 эпика docs/plan-c4-elements.md).

Формула эпика: факт процесса (конфигурация, спецификация, площадки) — у ближайшего
контейнера, факт кода (схемы логики) — у листа или компонента. Смена элемента и перенос
узла автоматически переносят только площадки (app/element_change); документация
переезжает явными действиями отсюда, а до тех пор её отмечают рекомендации (AL24, AL36).

- Перенести документацию (вниз): собственные схемы логики узла — компоненту (в том числе
  составному) или объекту без вложенных вне контейнера; спецификация — потомку с элементом
  «контейнер»; все собственные параметры конфигурации — одному потомку-контейнеру.
  Получатели — сервисы в поддереве узла на любой глубине; система и контейнер с
  компонентами схемы логики не принимают, база, брокер и «Пользователь» — ничего.
- Превью переноса (transfer_preview): что у узла своего и кому в его составе это можно
  отдать — флаги получателей по тем же правилам, что проверяет перенос. Окно интерфейса и
  MCP получателей не отбирают сами: третья копия правил разошлась бы с первой.
- Собрать с компонентов (вверх): параметры и спецификация компонентов переезжают их
  контейнеру. Одноимённые параметры — один и тот же параметр контейнера: остаётся
  выбранный, остальные удаляются. Спецификация переезжает только выбранная; прочие
  остаются у компонентов (удалять документацию молча нельзя — их отметит AL36).

Домен без HTTP: отказы — FactsTransferError со статусом (404 — схема не своя, 409 —
занято имя, уже есть спецификация, получатель вне поддерева; 422 — правило элемента),
роутеры только переводят. Всё проверяется ДО записи: частично применённого переноса не
бывает. Коммит — на вызывающей стороне.
"""

import uuid

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.element_marks import ElementRow, build_elements, project_element_rows
from app.models.config_param import ConfigParam
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.project import Project
from app.schemas.node import (
    CollectCandidateOut,
    CollectClashOut,
    CollectComponentOut,
    CollectFactsIn,
    CollectFactsOut,
    CollectFactsPreview,
    CollectSpecOut,
    DistributeDocsIn,
    DistributeDocsOut,
    TransferDocOut,
    TransferDocsPreview,
    TransferReceiverOut,
)
from app.view_state import bump_meta_rev

NOTHING_INSIDE = "Внутри «{name}» нет объектов, поэтому переносить документацию некуда."
DOC_NOT_OWN = "Схема не найдена среди собственных схем объекта"
OUTSIDE = "Получатель не входит в состав объекта"
DOC_TAKEN = "У «{name}» уже есть схема «{doc}»"
NO_SPEC = "У «{name}» нет спецификации"
SPEC_TAKEN = "У «{name}» уже есть спецификация"
PARAM_TAKEN = "У «{name}» уже есть параметр «{param}»"
# Получатель не того элемента: схемы логики описывают код, спецификацию и конфигурацию
# читает запускаемое целиком.
DOCS_TARGET = (
    "Схемы логики переносятся компонентам и объектам без вложенных, а «{name}» — {what}."
)
SPEC_TARGET = "Спецификация переносится только контейнеру, а «{name}» — {what}."
PARAMS_TARGET = "Конфигурация переносится только контейнеру, а «{name}» — {what}."
NOT_CONTAINER = "Собирать можно только контейнеру с компонентами"
CHOOSE_PARAM = (
    "Параметр «{name}» есть у нескольких объектов. Выберите, какое описание оставить."
)
WRONG_CHOICE = "Для параметра «{name}» выбран объект, у которого его нет."
SPEC_NOT_COMPONENT = "Спецификацию можно взять только у компонента контейнера «{name}»"


class FactsTransferError(ValueError):
    """Перенести нельзя: роутер переводит в HTTP с этим статусом."""

    def __init__(self, detail: str, status: int) -> None:
        super().__init__(detail)
        self.detail = detail
        self.status = status


class _Tree:
    """Записи и элементы проекта — одна выборка на запрос."""

    def __init__(self, db: Session, project_id: uuid.UUID) -> None:
        rows: list[ElementRow] = project_element_rows(db, project_id)
        self.names = {r.id: r.name for r in rows}
        self.shapes = {r.id: r.shape for r in rows}
        self.parents = {r.id: r.parent_id for r in rows}
        self.elements = build_elements(rows)

    def path_from(self, root: uuid.UUID, node_id: uuid.UUID) -> str:
        """Путь потомка от узла root, без него самого: «orders / api». Подъём с seen —
        данные бывают циклическими."""
        parts: list[str] = []
        seen: set[uuid.UUID] = set()
        cur: uuid.UUID | None = node_id
        while cur is not None and cur != root and cur not in seen:
            seen.add(cur)
            parts.append(self.names[cur])
            cur = self.parents.get(cur)
        return " / ".join(reversed(parts))


# Формы, у которых документации процесса и кода не бывает: лист базы или брокера по
# элементу — контейнер (единица размещения), но схем, спецификации и конфигурации у него
# нет (страница их и не предлагает — shapeDocs).
_SHAPE_WORD = {"database": "база данных", "broker": "брокер"}


def _what(tree: _Tree, node_id: uuid.UUID) -> str:
    """Чем получатель является словами продукта (для отказа «а «X» — …»)."""
    word = _SHAPE_WORD.get(tree.shapes[node_id])
    if word is not None:
        return word
    elements = tree.elements
    element = elements.effective(node_id)
    if element is None:
        return "пользователь"
    if element == "component":
        return "компонент"
    if element == "system":
        return "система"
    return "контейнер с компонентами" if elements.descendants(node_id) else "контейнер"


def _docs_place(tree: _Tree, node_id: uuid.UUID) -> bool:
    """Схемы логики на месте: сервис-компонент (в том числе составной) или сервис-лист."""
    if tree.shapes[node_id] != "service":
        return False
    element = tree.elements.effective(node_id)
    return element == "component" or (
        element == "container" and not tree.elements.descendants(node_id)
    )


def _process_place(tree: _Tree, node_id: uuid.UUID) -> bool:
    """Спецификация и конфигурация на месте: сервис с элементом «контейнер»."""
    return tree.shapes[node_id] == "service" and tree.elements.effective(node_id) == "container"


def _has_spec(node: Node) -> bool:
    return bool((node.openapi_spec or "").strip())


class _Transfer:
    """Проверки «Перенести документацию» по семьям: каждая возвращает, что записать, и
    ничего не пишет сама."""

    def __init__(self, db: Session, project: Project, node: Node) -> None:
        self.db = db
        self.node = node
        self.tree = tree = _Tree(db, project.id)
        self.elements, self.names = tree.elements, tree.names
        self.inside = set(self.elements.descendants(node.id))
        if not self.inside:
            raise FactsTransferError(NOTHING_INSIDE.format(name=node.name), 409)

    def _recipient(self, target: uuid.UUID, template: str, ok: bool) -> None:
        """Получатель в поддереве и подходящего элемента, иначе отказ."""
        if target not in self.inside:
            raise FactsTransferError(OUTSIDE, 409)
        if not ok:
            raise FactsTransferError(
                template.format(name=self.names[target], what=_what(self.tree, target)), 422
            )

    def docs(self, payload: DistributeDocsIn) -> list[tuple[NodeDoc, uuid.UUID]]:
        moves: list[tuple[NodeDoc, uuid.UUID]] = []
        for a in payload.doc_assignments:
            doc = self.db.get(NodeDoc, a.doc_id)
            if doc is None or doc.node_id != self.node.id:
                raise FactsTransferError(DOC_NOT_OWN, 404)
            self._recipient(a.child_id, DOCS_TARGET, _docs_place(self.tree, a.child_id))
            taken = self.db.query(NodeDoc.id).filter(
                NodeDoc.node_id == a.child_id, NodeDoc.name == doc.name
            ).first()
            if taken is not None:
                raise FactsTransferError(
                    DOC_TAKEN.format(name=self.names[a.child_id], doc=doc.name), 409
                )
            moves.append((doc, a.child_id))
        return moves

    def spec(self, target: uuid.UUID | None) -> Node | None:
        if target is None:
            return None
        if not _has_spec(self.node):
            raise FactsTransferError(NO_SPEC.format(name=self.node.name), 409)
        self._recipient(target, SPEC_TARGET, _process_place(self.tree, target))
        holder = self.db.get(Node, target)
        if holder is not None and _has_spec(holder):
            raise FactsTransferError(SPEC_TAKEN.format(name=holder.name), 409)
        return holder

    def params(self, target: uuid.UUID | None) -> list[ConfigParam]:
        if target is None:
            return []
        self._recipient(target, PARAMS_TARGET, _process_place(self.tree, target))
        params = (
            self.db.query(ConfigParam).filter(ConfigParam.node_id == self.node.id)
            .order_by(ConfigParam.name).all()
        )
        there = {
            name for (name,) in self.db.query(ConfigParam.name).filter(ConfigParam.node_id == target)
        }
        for p in params:
            if p.name in there:
                raise FactsTransferError(
                    PARAM_TAKEN.format(name=self.names[target], param=p.name), 409
                )
        return params


def transfer_docs(
    db: Session, project: Project, node: Node, payload: DistributeDocsIn
) -> DistributeDocsOut:
    """«Перенести документацию»: схемы, спецификация и параметры узла — потомкам по
    семьям фактов. Узел уже проверен на принадлежность проекту. Сначала все проверки,
    потом запись."""
    check = _Transfer(db, project, node)
    moves = check.docs(payload)
    spec_target = check.spec(payload.spec_child_id)
    params = check.params(payload.params_target_id)

    for doc, target_id in moves:
        doc.node_id = target_id
        doc.version += 1
    if spec_target is not None:
        spec_target.openapi_spec = node.openapi_spec
        node.openapi_spec = None
        spec_target.version += 1
        node.version += 1
    if payload.params_target_id is not None:
        for p in params:
            p.node_id = payload.params_target_id
            p.version += 1
    if moves or spec_target is not None or params:
        bump_meta_rev(db, project)
    return DistributeDocsOut(
        moved_docs=len(moves), spec_moved=spec_target is not None, moved_params=len(params)
    )


def transfer_preview(db: Session, project: Project, node: Node) -> TransferDocsPreview:
    """«Перенести документацию» без записи: своя документация узла (схемы логики,
    спецификация, число параметров) и все потомки в обходе в глубину с флагами — что
    каждый примет. Флаги — те же _docs_place и _process_place, что проверяет
    transfer_docs. Узел без вложенных — 422 тем же текстом, что у переноса."""
    tree = _Tree(db, project.id)
    inside = tree.elements.descendants(node.id)
    if not inside:
        raise FactsTransferError(NOTHING_INSIDE.format(name=node.name), 422)
    process = [m for m in inside if _process_place(tree, m)]
    # Спецификации — только у контейнеров (остальным она не переносится): тексты не
    # тянем ради всего поддерева. «Есть» — по тому же правилу, что отказ SPEC_TAKEN.
    with_spec = {
        nid
        for nid, spec in (
            db.query(Node.id, Node.openapi_spec).filter(Node.id.in_(process)).all()
            if process else []
        )
        if (spec or "").strip()
    }
    docs = db.query(NodeDoc).filter(NodeDoc.node_id == node.id).order_by(NodeDoc.name).all()
    params = db.query(func.count(ConfigParam.id)).filter(ConfigParam.node_id == node.id).scalar()
    return TransferDocsPreview(
        node_id=node.id,
        name=node.name,
        element_effective=tree.elements.effective(node.id),
        docs=[
            TransferDocOut(doc_id=d.id, name=d.name, kind=d.kind, operation=d.operation)
            for d in docs
        ],
        has_spec=_has_spec(node),
        params=params or 0,
        receivers=[
            TransferReceiverOut(
                node_id=m,
                path=tree.path_from(node.id, m),
                element_effective=tree.elements.effective(m),
                takes_docs=_docs_place(tree, m),
                takes_process_facts=m in process,
                has_spec=m in with_spec,
            )
            for m in inside
        ],
    )


class _Collect:
    """Что лежит у контейнера и его компонентов: компоненты в обходе в глубину (дети по
    имени), узлы и параметры по владельцам."""

    def __init__(self, db: Session, project: Project, node: Node) -> None:
        tree = _Tree(db, project.id)
        elements = tree.elements
        components = [
            m for m in elements.members_of(node.id) if elements.effective(m) == "component"
        ]
        if not components:
            raise FactsTransferError(NOT_CONTAINER, 422)
        self.container = node
        self.components = components
        holders = [node.id, *components]
        self.nodes = {n.id: n for n in db.query(Node).filter(Node.id.in_(holders))}
        self.nodes[node.id] = node
        self.params: dict[uuid.UUID, list[ConfigParam]] = {h: [] for h in holders}
        for p in (
            db.query(ConfigParam).filter(ConfigParam.node_id.in_(holders))
            .order_by(ConfigParam.name).all()
        ):
            self.params[p.node_id].append(p)
        # Одноимённые: имя → держатели в порядке «контейнер, затем компоненты».
        self.by_name: dict[str, list[ConfigParam]] = {}
        for h in holders:
            for p in self.params[h]:
                self.by_name.setdefault(p.name, []).append(p)

    def clashes(self) -> list[tuple[str, list[ConfigParam]]]:
        return sorted(
            ((name, ps) for name, ps in self.by_name.items() if len(ps) > 1),
            key=lambda item: item[0],
        )

    def name_of(self, node_id: uuid.UUID) -> str:
        return self.nodes[node_id].name


def collect_preview(db: Session, project: Project, node: Node) -> CollectFactsPreview:
    """«Собрать с компонентов» без записи: компоненты с фактами, одноимённые параметры,
    держатели спецификации. 422 — узел не контейнер с компонентами."""
    c = _Collect(db, project, node)
    components = [
        CollectComponentOut(
            node_id=m, name=c.name_of(m), params=len(c.params[m]), has_spec=_has_spec(c.nodes[m]),
        )
        for m in c.components
        if c.params[m] or _has_spec(c.nodes[m])
    ]
    clashes = [
        CollectClashOut(name=name, candidates=[
            CollectCandidateOut(node_id=p.node_id, node_name=c.name_of(p.node_id), description=p.description)
            for p in ps
        ])
        for name, ps in c.clashes()
    ]
    specs = [
        CollectSpecOut(node_id=h, name=c.name_of(h))
        for h in (node.id, *c.components)
        if _has_spec(c.nodes[h])
    ]
    return CollectFactsPreview(components=components, param_clashes=clashes, specs=specs)


def collect_facts(
    db: Session, project: Project, node: Node, payload: CollectFactsIn
) -> CollectFactsOut:
    """«Собрать с компонентов»: параметры компонентов — контейнеру (одноимённые — по
    выбору, остальные из группы удаляются), спецификация выбранного компонента —
    контейнеру (прежняя заменяется)."""
    c = _Collect(db, project, node)
    choices = {ch.name: ch.node_id for ch in payload.param_choices}

    # ── Проверки: всё до записи ──
    keep: dict[str, ConfigParam] = {}
    for name, ps in c.clashes():
        chosen = choices.get(name)
        if chosen is None:
            raise FactsTransferError(CHOOSE_PARAM.format(name=name), 422)
        match = next((p for p in ps if p.node_id == chosen), None)
        if match is None:
            raise FactsTransferError(WRONG_CHOICE.format(name=name), 422)
        keep[name] = match
    spec_source: Node | None = None
    if payload.spec_from is not None and payload.spec_from != node.id:
        if payload.spec_from not in c.components:
            raise FactsTransferError(SPEC_NOT_COMPONENT.format(name=node.name), 422)
        spec_source = c.nodes[payload.spec_from]
        if not _has_spec(spec_source):
            raise FactsTransferError(NO_SPEC.format(name=spec_source.name), 422)

    # ── Запись: сначала удаления (уникальность имени у контейнера), потом переезд ──
    survivors: list[ConfigParam] = []
    for name, ps in c.by_name.items():
        kept = keep.get(name, ps[0])
        for p in ps:
            if p is not kept:
                db.delete(p)
        survivors.append(kept)
    db.flush()
    moved = 0
    for p in sorted(survivors, key=lambda p: p.name):
        if p.node_id != node.id:
            p.node_id = node.id
            p.version += 1
            moved += 1
    spec_moved = False
    if spec_source is not None:
        node.openapi_spec = spec_source.openapi_spec
        spec_source.openapi_spec = None
        node.version += 1
        spec_source.version += 1
        spec_moved = True
    if moved or spec_moved or len(survivors) != sum(len(ps) for ps in c.by_name.values()):
        bump_meta_rev(db, project)
    return CollectFactsOut(moved_params=moved, spec_moved=spec_moved)

