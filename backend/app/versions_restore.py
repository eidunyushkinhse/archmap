"""Откат документации объекта к версии (docs/tasks/doc-versions.md §5).

Откат пишет историю вперёд: незафиксированное сохраняется автоматической версией
«Перед откатом к vN», затем документация поддерева приводится к снимку vN, итог
фиксируется версией «Откат к vN». Ничего не стирается: к состоянию до отката можно
вернуться откатом к «Перед откатом».

Что откатывается — проекция versions_diff.restorable: всё, что несёт снимок, кроме
процессов (они общие с другими объектами) и статуса страницы (им управляет человек).
Сторож — тест-фикспойнт: зафиксировать, изменить всё, откатить, сравнить проекции.

Сопоставление строк — по id, как у дельты; «живая» строка — существующая в проекте,
а не только в нынешнем поддереве: объект или схему могли унести из среза после
версии, и вставка с тем же id упала бы на первичном ключе. Порядок применения выбран
ради уникальных индексов (имя схемы у объекта, таблица, канал, параметр, колонка,
поле) и внешних ключей, которые БД проверяет сразу:

1. лишние строки уцелевших объектов (схемы, факты, связи, экземпляры размещения,
   которых в снимке нет) удаляются первыми — освобождают имена и пары «объект,
   площадка»;
2. уцелевшие строки снимка получают его поля; те, чей ключ уникальности меняется,
   сперва проходят через временное имя (иначе обмен именами двух схем упёрся бы в
   индекс); ссылка на строку, которой ещё нет, откладывается;
3. недостающие строки воссоздаются с исходными id механикой app/restore.py (Undo
   удаления) — она же проверяет чужие ссылки, циклы и дубли имён;
4. отложенные ссылки проставляются, решается родитель корня среза;
5. объекты, которых в снимке нет, удаляются ПОСЛЕДНИМИ — вместе с документацией и
   связями (БД-каскад, как у удаления узла). Раньше нельзя: под таким объектом могли
   оказаться объекты и схемы снимка (их перенесли туда после версии), и каскад унёс бы
   их вместе с привязками процессов, раскладкой и историей версий.

Размещение откатывается экземплярами по снимку; площадки в версию не входят (общая
сущность проекта), и экземпляр на площадке, которой больше нет, пропускается с
замечанием — как связь к исчезнувшему объекту.

Уникальных имён у самих объектов нет (тёзки-братья допустимы), а у схем и фактов
ключ — внутри объекта-владельца, и все владельцы строк снимка — объекты среза. Поэтому
тёзка вне среза откату помешать не может; дубль внутри снимка ловит restore
(RestoreError 409) — на данных версии он невозможен, отказ остаётся страховкой.

Домен без HTTP и без коммита: роутер переводит отказы (VersionError → 422,
restore.RestoreError → его status) и коммитит с курсорами схемы и меты.
"""

import uuid
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import or_
from sqlalchemy.orm import Session, undefer

from app import processes, reparent, restore, versions
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
from app.models.project import Project
from app.models.user import User
from app.schemas.restore import (
    DeletionSnapshot,
    DeploymentInstanceSnapshot,
    EdgeSnapshot,
    NodeSnapshot,
)
from app.schemas.versions import RestoreOut, RestorePreview, VersionSnapshot
from app.transition import cleanup_layout
from app.versions_diff import object_path, restorable
from app.versions_snapshot import content_hash
from app.view_state import bump_view_version

NOTHING_TO_RESTORE = "Нечего восстанавливать: документация совпадает с v{number}"
PARENT_KEPT = "объект остаётся у текущего родителя: {reason}"
PARENT_TOP = "объект перенесён на верхний уровень: {reason}"
PARENT_GONE = "прежнего больше нет"


# ── План узлов ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class _NodePlan:
    """Узлы отката. parents — нынешние родители всех узлов проекта; inside — узлы,
    которые окажутся в срезе после отката (у узлов снимка родители из снимка, у
    прочих — нынешние); delete — живые узлы из inside, которых в снимке нет: созданы
    после версии или внесены в срез извне."""

    snap_nodes: dict[uuid.UUID, NodeSnapshot]
    parents: dict[uuid.UUID, uuid.UUID | None]
    inside: set[uuid.UUID]
    delete: set[uuid.UUID]

    @property
    def alive(self) -> set[uuid.UUID]:
        """Узлы, которые будут существовать после отката."""
        return (self.parents.keys() - self.delete) | self.snap_nodes.keys()


def _descendants(
    parent_of: dict[uuid.UUID, uuid.UUID | None], root: uuid.UUID
) -> set[uuid.UUID]:
    """Корень и все потомки по карте «узел → родитель»; обход с seen — карта собрана из
    снимка и живых данных, и цикл в ней не должен вешать откат."""
    children: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
    for nid, pid in parent_of.items():
        if pid is not None:
            children[pid].append(nid)
    out: set[uuid.UUID] = set()
    stack = [root]
    while stack:
        cur = stack.pop()
        if cur in out:
            continue
        out.add(cur)
        stack.extend(children.get(cur, []))
    return out


def _node_plan(db: Session, project: Project, snap: VersionSnapshot) -> _NodePlan:
    """Какие узлы останутся, какие удалятся. Срез после отката считается по итоговой
    карте родителей, а не по нынешнему поддереву: узел снимка, унесённый из среза,
    вернётся вместе с детьми, появившимися у него после версии, — и эти дети тоже
    лишние. Родитель корня на состав среза не влияет."""
    parents = {nid: n.parent_id for nid, n in processes.load_nodes(db, project.id).items()}
    snap_nodes = {n.id: n for n in snap.nodes}
    final = dict(parents)
    for nid, n in snap_nodes.items():
        if nid != snap.root_id:
            final[nid] = n.parent_id
    inside = set(final) if snap.root_id is None else _descendants(final, snap.root_id)
    delete = {nid for nid in inside if nid in parents and nid not in snap_nodes}
    return _NodePlan(snap_nodes=snap_nodes, parents=parents, inside=inside, delete=delete)


# ── Строки снимка по семьям ────────────────────────────────────────────────────


@dataclass(frozen=True)
class _Family:
    """Строки одной модели в снимке: id → поля снимка без id. fks — внешние ключи
    (поле → модель цели): ссылка на строку, которой ещё нет, откладывается до
    воссоздания. unique — ключ уникальности вместе с владельцем (пусто — индекса нет)."""

    model: type[Base]
    rows: dict[uuid.UUID, dict[str, Any]]
    fks: dict[str, type[Base]]
    unique: tuple[str, ...] = ()


def _rows(items: Iterable[Any], exclude: Iterable[str] = ()) -> dict[uuid.UUID, dict[str, Any]]:
    """Строки снимка (схемы app/schemas/restore.py) — id → поля без id."""
    return {r.id: r.model_dump(exclude={"id", *exclude}) for r in items}


def _families(
    snap: VersionSnapshot,
    edges: list[EdgeSnapshot],
    instances: list[DeploymentInstanceSnapshot],
) -> dict[type[Base], _Family]:
    """Семьи строк снимка. Статус страницы (approval) из полей узла исключён — он не
    откатывается; родитель корня среза — тоже, его решает _restore_root_parent. Связи и
    экземпляры — только те, что можно вернуть (_Apply._edges, _Apply._instances).
    Площадка экземпляра (site_id) — ссылка без семьи: площадки в снимке нет, а
    экземпляры на удалённых площадках отфильтрованы раньше."""
    nodes = _rows(snap.nodes, {"approval"})
    if snap.root_id is not None:
        nodes[snap.root_id].pop("parent_id")
    families = [
        _Family(Node, nodes, {"parent_id": Node}),
        _Family(Edge, _rows(edges), {"source_id": Node, "target_id": Node}),
        _Family(NodeDoc, _rows(snap.node_docs), {"node_id": Node}, ("node_id", "name")),
        _Family(
            DbTable,
            _rows(snap.db_tables),
            {"node_id": Node},
            ("node_id", "schema_name", "name"),
        ),
        _Family(
            DbColumn,
            _rows(snap.db_columns),
            {"table_id": DbTable, "references_column_id": DbColumn},
            ("table_id", "name"),
        ),
        _Family(
            BrokerChannel,
            _rows(snap.broker_channels),
            {"node_id": Node},
            ("node_id", "group_name", "name"),
        ),
        _Family(
            ChannelField,
            _rows(snap.channel_fields),
            {"channel_id": BrokerChannel},
            ("channel_id", "name"),
        ),
        _Family(ConfigParam, _rows(snap.config_params), {"node_id": Node}, ("node_id", "name")),
        _Family(DeploymentInstance, _rows(instances), {"node_id": Node}, ("node_id", "site_id")),
    ]
    return {f.model: f for f in families}


def _temp_name(row_id: uuid.UUID) -> str:
    """Временное имя строки, чей ключ уникальности меняется: на время отката оно
    освобождает прежнее имя и не совпадает ни с чьим настоящим."""
    return f"~откат~{row_id.hex}"


# ── Применение ─────────────────────────────────────────────────────────────────


@dataclass
class _Apply:
    """Состояние одного отката: снимок, план узлов, семьи строк и замечания."""

    db: Session
    project: Project
    snap: VersionSnapshot
    plan: _NodePlan
    remarks: list[str] = field(default_factory=list)
    # Узлы снимка, сменившие родителя, с прежним родителем — раскладка во внешних видах.
    moved: list[tuple[uuid.UUID, uuid.UUID | None]] = field(default_factory=list)

    def run(self) -> None:
        edges = self._edges()
        families = _families(self.snap, edges, self._instances())
        self._drop_extra_rows(families)
        live = {model: self._load(model, fam.rows) for model, fam in families.items()}
        missing = {model: fam.rows.keys() - live[model].keys() for model, fam in families.items()}
        self._drop_dead_references(families[DbColumn])
        deferred = self._update(families, live, missing)
        self._create(families, missing)
        for obj, values in deferred:
            self._assign(obj, values)
        self._restore_root_parent()
        self.db.flush()
        self._fence_views(missing[Node])
        self._delete_nodes()

    # ── Связи ──

    def _edges(self) -> list[EdgeSnapshot]:
        """Связи снимка, которые можно вернуть: оба конца будут существовать. Связь, чей
        другой конец (вне среза) больше не существует, пропускается с замечанием. Пути
        концов — только для показа: строкой снимка удаления они не нужны."""
        alive = self.plan.alive
        out: list[EdgeSnapshot] = []
        for e in self.snap.edges:
            ends = ((e.source_id, e.source_path), (e.target_id, e.target_path))
            gone = [path for nid, path in ends if nid not in alive]
            if gone:
                self.remarks.append(
                    f"связь «{e.source_path} → {e.target_path}» не восстановлена: "
                    f"объекта «{gone[0]}» больше нет"
                )
                continue
            fields = set(EdgeSnapshot.model_fields)
            out.append(EdgeSnapshot.model_validate(e.model_dump(include=fields)))
        return out

    # ── Размещение ──

    def _instances(self) -> list[DeploymentInstanceSnapshot]:
        """Экземпляры снимка, которые можно вернуть: площадка ещё есть в проекте.
        Площадка в версию не входит (общая сущность проекта), удалённую откат не
        вернёт — размещение на ней пропускается с замечанием. Объект экземпляра — узел
        снимка, после отката он будет всегда. Путь площадки — только для показа:
        строкой снимка удаления он не нужен."""
        site_ids = {i.site_id for i in self.snap.instances}
        alive: set[uuid.UUID] = set()
        if site_ids:
            alive = {
                sid
                for (sid,) in self.db.query(DeploymentSite.id).filter(
                    DeploymentSite.id.in_(site_ids), DeploymentSite.project_id == self.project.id
                )
            }
        fields = set(DeploymentInstanceSnapshot.model_fields)
        out: list[DeploymentInstanceSnapshot] = []
        for inst in self.snap.instances:
            if inst.site_id not in alive:
                self.remarks.append(
                    f"размещение «{object_path(self.snap, inst.node_id)}» на площадке "
                    f"«{inst.site_path}» не восстановлено: площадки больше нет"
                )
                continue
            out.append(DeploymentInstanceSnapshot.model_validate(inst.model_dump(include=fields)))
        return out

    # ── Шаг 1: лишние строки уцелевших объектов ──

    def _drop_extra_rows(self, families: dict[type[Base], _Family]) -> None:
        """Удалить схемы, факты, связи и экземпляры размещения уцелевших объектов
        снимка, которых в снимке нет: они освобождают имена для строк снимка. Колонки и
        поля — у таблиц и каналов снимка; лишние таблицы и каналы уносят свои колонки и
        поля сами (каскад). Связь снимка, которую вернуть нельзя (другого конца больше
        нет), остаётся как есть: сопоставление по id, а она в снимке есть.

        Экземпляр, поставленный после версии на ту же площадку заново (та же пара
        «объект, площадка», другой id), удаляется здесь же — его id не в keep, — и пара
        освобождается до воссоздания экземпляра снимка с исходным id."""
        db = self.db
        owners = list(self.plan.parents.keys() & self.plan.snap_nodes.keys())
        tables = list(families[DbTable].rows.keys())
        channels = list(families[BrokerChannel].rows.keys())
        owned: list[Any] = [
            *db.query(NodeDoc).filter(NodeDoc.node_id.in_(owners)),
            *db.query(DbTable).filter(DbTable.node_id.in_(owners)),
            *db.query(BrokerChannel).filter(BrokerChannel.node_id.in_(owners)),
            *db.query(ConfigParam).filter(ConfigParam.node_id.in_(owners)),
            *db.query(DeploymentInstance).filter(DeploymentInstance.node_id.in_(owners)),
            *db.query(DbColumn).filter(DbColumn.table_id.in_(tables)),
            *db.query(ChannelField).filter(ChannelField.channel_id.in_(channels)),
            *db.query(Edge).filter(or_(Edge.source_id.in_(owners), Edge.target_id.in_(owners))),
        ]
        # id строк уникальны глобально (uuid), поэтому «что оставить» — одно множество
        # на все семьи; связи — все связи снимка, включая те, что вернуть нельзя.
        keep = {e.id for e in self.snap.edges}.union(*(f.rows.keys() for f in families.values()))
        doomed = [r for r in owned if r.id not in keep]
        for row in doomed:
            db.delete(row)
        db.flush()
        # Каскады БД (SET NULL у ссылок колонок и шагов процессов) в памяти сессии не
        # видны: дальше всё читается заново.
        db.expire_all()

    def _load(self, model: type[Base], ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, Any]:
        """Живые строки модели по id — одним запросом; тело схемы — сразу, иначе
        сравнение с текстом снимка ходило бы за каждой."""
        wanted = list(ids)
        if not wanted:
            return {}
        query: Any = self.db.query(model).filter(model.id.in_(wanted))  # type: ignore[attr-defined]
        if model is NodeDoc:
            query = query.options(undefer(NodeDoc.content))
        return {r.id: r for r in query}

    def _drop_dead_references(self, columns: _Family) -> None:
        """Внешний ключ колонки снимка на колонку, которой после отката не будет (её
        таблицу удалили вне среза или её объект удаляет сам откат), гасится с
        замечанием — так же, как погасил бы его ON DELETE SET NULL самой БД."""
        refs = {
            v["references_column_id"] for v in columns.rows.values()
        } - {None} - columns.rows.keys()
        alive: set[uuid.UUID] = set()
        if refs:
            found = (
                self.db.query(DbColumn.id, DbTable.node_id)
                .join(DbTable, DbTable.id == DbColumn.table_id)
                .join(Node, Node.id == DbTable.node_id)
                .filter(DbColumn.id.in_(refs), Node.project_id == self.project.id)
            )
            alive = {cid for cid, node_id in found if node_id not in self.plan.delete}
        tables = {t.id: t.name for t in self.snap.db_tables}
        for values in columns.rows.values():
            ref = values["references_column_id"]
            if ref is None or ref in columns.rows or ref in alive:
                continue
            values["references_column_id"] = None
            name = f"{tables.get(values['table_id'], '?')}.{values['name']}"
            self.remarks.append(f"внешний ключ «{name}» не восстановлен: целевой колонки больше нет")

    # ── Шаг 2: уцелевшие строки снимка ──

    def _update(
        self,
        families: dict[type[Base], _Family],
        live: dict[type[Base], dict[uuid.UUID, Any]],
        missing: dict[type[Base], set[uuid.UUID]],
    ) -> list[tuple[Any, dict[str, Any]]]:
        """Поля снимка — уцелевшим строкам. Строки со сменой ключа уникальности сперва
        получают временное имя (отдельный flush: иначе обмен именами упёрся бы в
        индекс). Строка со ссылкой на ещё не воссозданную возвращается отложенной —
        её поля целиком проставит run после воссоздания.

        Временное имя — только у ключей с именем. У экземпляра размещения ключ — пара
        «объект, площадка», и правимых полей у него нет: строка с тем же id несёт ту же
        пару, а живая строка с той же парой и другим id удалена шагом 1."""
        db = self.db
        for model, fam in families.items():
            for rid, values in fam.rows.items():
                obj = live[model].get(rid)
                if obj is not None and "name" in fam.unique and any(
                    getattr(obj, k) != values[k] for k in fam.unique
                ):
                    obj.name = _temp_name(rid)
        db.flush()
        deferred: list[tuple[Any, dict[str, Any]]] = []
        for model, fam in families.items():
            for rid, values in fam.rows.items():
                obj = live[model].get(rid)
                if obj is None:
                    continue
                if any(values.get(f) in missing[target] for f, target in fam.fks.items()):
                    deferred.append((obj, values))
                else:
                    self._assign(obj, values)
        db.flush()
        return deferred

    def _assign(self, obj: Any, values: dict[str, Any]) -> None:
        """Поля снимка — строке; CAS-версия строки растёт, если что-то изменилось: правка,
        начатая в другой сессии до отката, обязана получить 409, а не затереть его."""
        changed = [(f, v) for f, v in values.items() if getattr(obj, f) != v]
        if not changed:
            return
        if isinstance(obj, Node) and "parent_id" in values and obj.parent_id != values["parent_id"]:
            self.moved.append((obj.id, self.plan.parents.get(obj.id)))
        for f, v in changed:
            setattr(obj, f, v)
        if hasattr(obj, "version"):
            obj.version += 1

    # ── Шаг 3: недостающие строки ──

    def _create(
        self, families: dict[type[Base], _Family], missing: dict[type[Base], set[uuid.UUID]]
    ) -> None:
        """Воссоздать строки снимка, которых нет, с исходными id — механикой Undo
        удаления (restore.apply_snapshot): узлы родителями раньше детей, колонки в два
        прохода из-за ссылок, проверка чужих ссылок, циклов и дублей имён."""

        def rows(model: type[Base]) -> list[Any]:
            schema = restore.SNAPSHOT_PLAN[model]
            fam = families[model]
            return [schema(id=rid, **fam.rows[rid]) for rid in sorted(missing[model], key=str)]

        nodes = [self.plan.snap_nodes[nid] for nid in sorted(missing[Node], key=str)]
        snapshot = DeletionSnapshot(
            nodes=nodes,
            edges=rows(Edge),
            layout_items=[],
            node_docs=rows(NodeDoc),
            db_tables=rows(DbTable),
            db_columns=rows(DbColumn),
            broker_channels=rows(BrokerChannel),
            channel_fields=rows(ChannelField),
            config_params=rows(ConfigParam),
            instances=rows(DeploymentInstance),
        )
        if any(getattr(snapshot, name) for name in DeletionSnapshot.model_fields):
            restore.apply_snapshot(self.db, snapshot, self.project.id)

    # ── Шаг 4: родитель корня среза ──

    def _restore_root_parent(self) -> None:
        """Перенос объекта — тоже документация: корень среза возвращается к прежнему
        родителю, если тот жив и переносу не мешают правила вложенности
        (reparent.validate_reparent). Иначе объект остаётся, где есть, с замечанием. Если
        нынешний родитель удаляется откатом или оказался внутри самого среза (объект
        переносили под собственного бывшего потомка), оставаться негде — объект уходит на
        верхний уровень."""
        root_id = self.snap.root_id
        if root_id is None:
            return
        self.db.flush()  # проверка переноса читает дерево из БД
        root = self.db.get(Node, root_id)
        if root is None:
            return
        want = self.plan.snap_nodes[root_id].parent_id
        current = root.parent_id
        if want == current:
            return
        gone = want is not None and want not in self.plan.alive
        reason = PARENT_GONE if gone else reparent.validate_reparent(
            self.db, self.project, root, want
        )
        if reason is None:
            self._assign(root, {"parent_id": want})
            return
        reason = reason[:1].lower() + reason[1:]
        if current is not None and (current in self.plan.delete or current in self.plan.inside):
            self._assign(root, {"parent_id": None})
            self.remarks.append(PARENT_TOP.format(reason=reason))
        else:
            self.remarks.append(PARENT_KEPT.format(reason=reason))

    # ── Раскладка и удаление ──

    def _fence_views(self, created: set[uuid.UUID]) -> None:
        """Виды, чей состав изменился: родители воссозданных объектов (раскладка новых —
        по правилу own-on-first-render) и оба родителя перенесённых; у перенесённых
        позиции во внешних видах снимаются, как у переноса из интерфейса."""
        db = self.db
        for vid in {self.plan.snap_nodes[nid].parent_id for nid in created} - created:
            bump_view_version(db, self.project.id, vid)
        for nid, old_parent in self.moved:
            node = db.get(Node, nid)
            if node is not None:
                reparent.strip_layout(db, self.project, node, old_parent)
                db.flush()

    def _delete_nodes(self) -> None:
        """Шаг 5: удалить объекты, которых в снимке нет, — верхние из удаляемых, остальное
        уносит БД-каскад вместе с документацией и связями (как routers.nodes.delete_node).

        Перед удалением сессия сбрасывается: загруженная коллекция узла (схемы логики —
        selectin) помнила бы состав до отката, и ORM-каскад удалил бы схему, которую
        откат только что вернул прежнему владельцу. Сейчас удаляемые узлы после первого
        сброса (_drop_extra_rows) не грузятся, и сброс здесь — страховка от будущей
        правки, которая их загрузит."""
        db = self.db
        delete = self.plan.delete
        db.flush()
        db.expire_all()
        tops = [nid for nid in delete if self.plan.parents.get(nid) not in delete]
        for nid in sorted(tops, key=str):
            node = db.get(Node, nid)
            if node is None:
                continue
            cleanup_layout(db, self.project, node)
            db.delete(node)
        db.flush()
        db.expire_all()


# ── Вход ───────────────────────────────────────────────────────────────────────


def _has_pending(db: Session, project: Project, node: Node | None, live: VersionSnapshot) -> bool:
    """Есть ли незафиксированное с последней версии объекта. Хэш последней пересчитан
    по её снимку, а не взят из колонки: проекция могла уточниться с её фиксации."""
    last = versions.last_version(db, project, node)
    return last is None or content_hash(live) != content_hash(versions.snapshot_of(last))


def restore_preview(
    db: Session, project: Project, node: Node | None, version: NodeVersion
) -> RestorePreview:
    """Что сделает откат к version — для окна подтверждения, ничего не меняя."""
    snap = versions.snapshot_of(version)
    live = versions.live_snapshot(db, project, node)
    return RestorePreview(
        pending=_has_pending(db, project, node, live),
        deleted_nodes=len(_node_plan(db, project, snap).delete),
        has_processes=bool(snap.processes or live.processes),
    )


def restore_version(
    db: Session, project: Project, user: User, node: Node | None, version: NodeVersion
) -> RestoreOut:
    """Вернуть документацию объекта (или всего проекта, node — None) к version; без
    коммита.

    Документация уже совпадает с версией (по проекции restorable) — VersionError
    «Нечего восстанавливать»: «Откат к vN», ничего не изменивший, был бы шумом в
    истории, а фронт в этом случае кнопку выключает (последняя версия без изменений).
    Различие только в процессах или статусе страницы — тоже «нечего»: их откат не
    трогает."""
    snap = versions.snapshot_of(version)
    live = versions.live_snapshot(db, project, node)
    if restorable(live) == restorable(snap):
        raise versions.VersionError(NOTHING_TO_RESTORE.format(number=version.number))
    number = version.number
    created: list[int] = []
    if _has_pending(db, project, node, live):
        pre = versions.create_version(
            db, project, user, node, f"Перед откатом к v{number}", kind="pre_restore"
        )
        created.append(pre.number)

    job = _Apply(db=db, project=project, snap=snap, plan=_node_plan(db, project, snap))
    job.run()

    row = versions.create_version(
        db, project, user, node, f"Откат к v{number}", kind="restore", restored_from=number
    )
    created.append(row.number)
    return RestoreOut(created=created, deleted_nodes=len(job.plan.delete), remarks=job.remarks)
