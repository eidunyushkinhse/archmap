"""План синхронизации схемы с прогоном агента (Фаза 1, docs/plan-arch-sync.md).

Чем отличается от импорта: импорт СОЗДАЁТ проект с нуля, синк накладывает свежий
прогон на ЖИВОЙ проект, где уже есть раскладка, схемы логики, спеки, процессы и
ручные правки. Поэтому здесь не «записать», а «посчитать, что изменится»:
build_sync_plan — чистая функция (БД не трогает, узлы и рёбра получает списками),
её результат показывается человеку и только потом применяется (Фаза 2).

Матчинг импортированного узла на живой — двухступенчатый, как в merge_imports:
1. ЯКОРЬ (nodes.source_ref ∈ ключи импортного узла) — переживает переименование
   сервиса, ради него и делалась Фаза 0;
2. ИМЯ среди детей уже смэтченного родителя — прежний способ, с тем же
   предохранителем: тёзка с ПРОТИВОРЕЧАЩИМ якорем не матчится.
Порядок важен: путь строится от смэтченного родителя, иначе переименование
контейнера оторвало бы от живых узлов всё его поддерево.

Политики — защита от того, что прогон агента недетерминирован (см. анализ дыр):
проза и имена дрейфуют, состав слоя компонентов нестабилен, а пропажа узла из
одного прогона ещё не значит, что сервиса больше нет. Поэтому по умолчанию синк
консервативен: обновляет структуру и пустые поля, ничего не удаляет, прозу и
имена не трогает. Агрессивные режимы включаются явными галочками.
"""

import uuid
from dataclasses import dataclass, field

from app.identity import compare_identity
from app.import_yaml import ParsedImport, _ImpNode
from app.models.edge import Edge
from app.models.node import Node

# Глубина дерева импорта: 1 — корень-система, 2 — контейнеры, 3+ — компоненты.
# Слой компонентов вне синка по умолчанию (его состав меняется от прогона к прогону).
_CONTAINER_DEPTH = 2


@dataclass
class SyncPolicies:
    """Что синку разрешено трогать. Дефолты — самый консервативный режим."""

    # Перезаписывать описания живых узлов прозой прогона. Выключено: description
    # дрейфует между прогонами и мог быть выправлен руками.
    update_descriptions: bool = False
    # Переименовывать живые узлы по прогону. Выключено по той же причине: имя —
    # такая же ручная правка, как описание (переименование ВИДНО в плане и без
    # применения, потому что якорь уже связал узлы).
    update_names: bool = False
    # Синхронизировать слой компонентов (глубина 3+). Выключено: состав слоя
    # нестабилен и утопил бы настоящий diff в шуме.
    sync_components: bool = False
    # Пропавшим из прогона узлам ставить status=deprecated. Выключено: пропажа
    # может означать, что репозиторий просто не прогнали. УДАЛЕНИЯ НЕТ НИКОГДА.
    mark_missing_deprecated: bool = False
    # Снимать «устаревший» с узлов, которые снова появились в YAML. Симметрично
    # пометке: пометили по галочке — снимаем по галочке. Выключено, потому что
    # ArchMap не знает, КТО поставил статус: пометку могли сделать руками, и
    # снимать её молча значит переигрывать решение человека. Сам факт возвращения
    # виден в плане ВСЕГДА, независимо от галочки (находка проверки-2 №1).
    restore_returned: bool = False


@dataclass
class SyncNodeAction:
    path: str  # путь узла в прогоне («Система / payments»)
    action: str  # create | update | unchanged | missing
    node_id: uuid.UUID | None  # живой узел (для update/unchanged/missing)
    source_ref: str | None  # якорь, который будет записан
    fields: list[str] = field(default_factory=list)  # какие поля меняет update
    matched_by: str | None = None  # source | name (чем опознан живой узел)
    # Ссылки для МЕХАНИЧЕСКОГО применения (Фаза 2): значения полей apply берёт из
    # разобранного прогона по imp_idx, родителя создаваемого узла — по parent_path
    # (к тому моменту он уже создан или смэтчен). Так решения принимает один
    # build_sync_plan, а apply остаётся исполнителем и матчинг не дублирует.
    imp_idx: int | None = None
    parent_path: str | None = None
    # Узел был помечен устаревшим, а в YAML он снова есть. Показываем ВСЕГДА,
    # даже когда статус не трогаем: иначе вернувшийся объект не упоминался бы в
    # плане ни строкой (он попадал в unchanged, а неизменные скрыты).
    returned: bool = False


@dataclass
class SyncEdgeAction:
    source_path: str
    target_path: str
    action: str  # create | unchanged | missing
    edge_id: uuid.UUID | None = None
    imp_idx: int | None = None  # индекс ребра в прогоне (label/technology для create)


@dataclass
class SyncPlan:
    nodes: list[SyncNodeAction] = field(default_factory=list)
    edges: list[SyncEdgeAction] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    # Политики, по которым план построен: применение читает их отсюда, а не
    # получает вторым путём — иначе план и его исполнение могли бы разойтись.
    policies: SyncPolicies = field(default_factory=SyncPolicies)

    @property
    def summary(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for a in self.nodes:
            counts[f"nodes_{a.action}"] = counts.get(f"nodes_{a.action}", 0) + 1
            if a.returned:
                counts["nodes_returned"] = counts.get("nodes_returned", 0) + 1
        for e in self.edges:
            counts[f"edges_{e.action}"] = counts.get(f"edges_{e.action}", 0) + 1
        return counts

    @property
    def is_noop(self) -> bool:
        """Ничего не изменится — критерий-фикспойнт: повторный план на том же
        входе обязан быть пустым (docs/plan-arch-sync.md, Фаза 2)."""
        return all(a.action == "unchanged" for a in self.nodes) and all(
            e.action == "unchanged" for e in self.edges
        )


def _is_return(live: Node, imp: _ImpNode) -> bool:
    """Узел был помечен устаревшим, а в YAML он снова есть — «вернулся в строй».

    Обратный переход deprecated → existing не проходил общее правило «не-дефолт
    бьёт дефолт»: в YAML статус почти всегда existing (дефолт схемы), поэтому
    условие никогда не выполнялось, и вернувшийся узел вдобавок попадал в
    unchanged — то есть не был виден в плане вовсе (находка проверки-2 №1)."""
    return live.status == "deprecated" and imp.status == "existing"


def _norm(name: str) -> str:
    return " ".join(name.split()).casefold()


def _live_keys(node: Node) -> list[str]:
    """Ключи живого узла: в БД хранится один — сильнейший на момент прогона."""
    return [node.source_ref] if node.source_ref else []


# Строки плана читает ПОЛЬЗОВАТЕЛЬ, а не мы: технический ключ вида
# «git:github.com/org/x» превращаем в «репозиторию github.com/org/x».
_SOURCE_KIND = {"git": "репозиторию", "img": "образу", "k8s": "деплойменту", "host": "сетевому имени"}


def _human_source(ref: str | None) -> str:
    if not ref:
        return "источнику"
    kind, _, value = ref.partition(":")
    return f"{_SOURCE_KIND.get(kind, 'источнику')} {value}" if value else "источнику"


class _Matcher:
    """Состояние одного построения плана (класс вместо связки словарей — тот же
    приём, что в _Merger)."""

    def __init__(self, nodes: list[Node], edges: list[Edge], policies: SyncPolicies):
        self.policies = policies
        self.plan = SyncPlan()
        self.by_id = {n.id: n for n in nodes}
        self.children: dict[uuid.UUID | None, list[Node]] = {}
        for n in nodes:
            parent = n.parent_id if n.parent_id in self.by_id else None
            self.children.setdefault(parent, []).append(n)
        for group in self.children.values():
            group.sort(key=lambda n: n.name)
        self.by_source: dict[str, Node] = {}
        for n in nodes:
            if n.source_ref:
                self.by_source.setdefault(n.source_ref, n)
        self.edges = edges
        # Пути живых узлов — для отчёта о пропавших связях (иначе в плане
        # мешались бы голые имена живых узлов и пути импортированных).
        self.live_paths: dict[uuid.UUID, str] = {}
        for root in self.children.get(None, []):
            self._index_paths(root, "")
        self.taken: set[uuid.UUID] = set()  # живые узлы, уже отданные импорту
        self.imp_to_live: dict[int, Node] = {}
        self.imp_paths: list[str] = []
        self.skipped: set[int] = set()  # компоненты вне синка (вместе с поддеревом)

    def _index_paths(self, node: Node, prefix: str) -> None:
        full = f"{prefix} / {node.name}" if prefix else node.name
        self.live_paths[node.id] = full
        for kid in self.children.get(node.id, []):
            self._index_paths(kid, full)

    # ── узлы ──────────────────────────────────────────────────────────────

    def _depth(self, parsed: ParsedImport, idx: int) -> int:
        depth = 1
        cur = parsed.nodes[idx].parent_idx
        while cur is not None:
            depth += 1
            cur = parsed.nodes[cur].parent_idx
        return depth

    def _match(self, imp: _ImpNode, parent_live: Node | None) -> tuple[Node | None, str | None]:
        """Живой узел для импортированного: сперва якорь, затем имя у смэтченного
        родителя. Уже занятый живой узел второй раз не отдаётся."""
        for k in imp.source_keys:
            cand = self.by_source.get(k)
            if cand is not None and cand.id not in self.taken:
                return cand, "source"
        siblings = self.children.get(parent_live.id if parent_live else None, [])
        for cand in siblings:
            if cand.id in self.taken or _norm(cand.name) != _norm(imp.name):
                continue
            # Предохранитель Фазы 0: тёзка с противоречащим якорем — другой узел.
            if compare_identity(_live_keys(cand), imp.source_keys) == "different":
                self.plan.warnings.append(
                    f"«{imp.name}»: в схеме уже есть объект с таким именем, но он относится "
                    f"к другому {_human_source(cand.source_ref)} — добавим отдельный объект"
                )
                continue
            return cand, "name"
        return None, None

    def _diff_fields(self, live: Node, imp: _ImpNode) -> list[str]:
        """Какие поля изменит update. «Богатое побеждает» для role/technology
        (заполняем только пустое — ручная правка не затирается), не-дефолт бьёт
        дефолт для shape/status, проза и имя — только по политике."""
        fields: list[str] = []
        if self.policies.update_names and _norm(live.name) != _norm(imp.name):
            fields.append("name")
        for attr, val in (("role", imp.role), ("technology", imp.technology)):
            cur = getattr(live, attr)
            if val and val.strip() and not (cur and cur.strip()):
                fields.append(attr)
        if self.policies.update_descriptions:
            new = (imp.description or "").strip()
            if new and new != (live.description or "").strip():
                fields.append("description")
        if imp.shape != "service" and live.shape != imp.shape:
            fields.append("shape")
        if imp.status != "existing" and live.status != imp.status:
            fields.append("status")
        elif self.policies.restore_returned and _is_return(live, imp):
            fields.append("status")
        # Якорь — не пользовательские данные: проставляем и обновляем всегда.
        new_ref = imp.source_keys[0] if imp.source_keys else None
        if new_ref and new_ref != live.source_ref:
            fields.append("source_ref")
        return fields

    def walk_import(self, parsed: ParsedImport) -> None:
        max_depth = 32 if self.policies.sync_components else _CONTAINER_DEPTH
        for i, imp in enumerate(parsed.nodes):
            parent_idx = imp.parent_idx
            prefix = self.imp_paths[parent_idx] if parent_idx is not None else ""
            self.imp_paths.append(f"{prefix} / {imp.name}" if prefix else imp.name)
            # Компоненты вне синка — пропускаем вместе с поддеревом (их родитель
            # уже пропущен, иначе они искались бы среди корней).
            if (parent_idx is not None and parent_idx in self.skipped) or self._depth(
                parsed, i
            ) > max_depth:
                self.skipped.add(i)
                continue
            parent_live = self.imp_to_live.get(parent_idx) if parent_idx is not None else None
            if parent_idx is not None and parent_live is None:
                # Родитель создаётся заново — ребёнок тоже новый, матчить не с чем.
                self.plan.nodes.append(
                    SyncNodeAction(
                        path=self.imp_paths[i],
                        action="create",
                        node_id=None,
                        source_ref=imp.source_keys[0] if imp.source_keys else None,
                        imp_idx=i,
                        parent_path=self.imp_paths[parent_idx],
                    )
                )
                continue
            live, how = self._match(imp, parent_live)
            if live is None:
                self.plan.nodes.append(
                    SyncNodeAction(
                        path=self.imp_paths[i],
                        action="create",
                        node_id=None,
                        source_ref=imp.source_keys[0] if imp.source_keys else None,
                        imp_idx=i,
                        parent_path=self.imp_paths[parent_idx] if parent_idx is not None else None,
                    )
                )
                continue
            self.taken.add(live.id)
            self.imp_to_live[i] = live
            if how == "source" and _norm(live.name) != _norm(imp.name):
                verb = (
                    "имя будет изменено"
                    if self.policies.update_names
                    else "имя в схеме оставляем как есть"
                )
                self.plan.conflicts.append(
                    f"«{live.name}»: в YAML этот объект назван «{imp.name}» "
                    f"(узнали по {_human_source(live.source_ref)}) — {verb}"
                )
            live_parent = live.parent_id if live.parent_id in self.by_id else None
            want_parent = parent_live.id if parent_live else None
            if live_parent != want_parent:
                self.plan.conflicts.append(
                    f"«{live.name}»: в YAML этот объект показан в другом месте "
                    f"({self.imp_paths[i]}) — переносить не будем, вложенность в схеме "
                    f"останется прежней"
                )
            fields = self._diff_fields(live, imp)
            self.plan.nodes.append(
                SyncNodeAction(
                    path=self.imp_paths[i],
                    action="update" if fields else "unchanged",
                    returned=_is_return(live, imp),
                    node_id=live.id,
                    source_ref=imp.source_keys[0] if imp.source_keys else live.source_ref,
                    fields=fields,
                    matched_by=how,
                    imp_idx=i,
                    parent_path=self.imp_paths[parent_idx] if parent_idx is not None else None,
                )
            )

    def collect_missing(self) -> None:
        """Живые узлы зоны синка, которых прогон не показал. Зона — поддеревья
        смэтченных корней: узлы чужих корней и ручные ветки глубже порога синк не
        касается. Действие информативно, пока не включён mark_missing_deprecated."""
        matched_roots = [
            n for n in self.children.get(None, []) if n.id in self.taken
        ]
        max_depth = 32 if self.policies.sync_components else _CONTAINER_DEPTH

        def walk(node: Node, path: str, depth: int) -> None:
            if depth > max_depth:
                return
            if node.id not in self.taken:
                self.plan.nodes.append(
                    SyncNodeAction(path=path, action="missing", node_id=node.id, source_ref=node.source_ref)
                )
            for kid in self.children.get(node.id, []):
                walk(kid, f"{path} / {kid.name}", depth + 1)

        for root in matched_roots:
            for kid in self.children.get(root.id, []):
                walk(kid, f"{root.name} / {kid.name}", 2)

    # ── рёбра ─────────────────────────────────────────────────────────────

    def walk_edges(self, parsed: ParsedImport) -> None:
        """Ребро прогона существует, если между теми же живыми концами уже есть
        связь. Концы вне зоны синка (пропущенные компоненты) ребро выбрасывают —
        синк не выдумывает связи к тому, чего не рассматривал."""
        live_pairs: dict[tuple[uuid.UUID, uuid.UUID], Edge] = {}
        for live_edge in self.edges:
            live_pairs.setdefault((live_edge.source_id, live_edge.target_id), live_edge)
        seen: set[tuple[uuid.UUID, uuid.UUID]] = set()

        for ei, ie in enumerate(parsed.edges):
            if ie.source_idx in self.skipped or ie.target_idx in self.skipped:
                continue
            src_live = self.imp_to_live.get(ie.source_idx)
            dst_live = self.imp_to_live.get(ie.target_idx)
            sp, tp = self.imp_paths[ie.source_idx], self.imp_paths[ie.target_idx]
            if src_live is None or dst_live is None:
                # Хотя бы один конец — новый узел: связь тоже новая.
                self.plan.edges.append(SyncEdgeAction(sp, tp, "create", imp_idx=ei))
                continue
            hit = live_pairs.get((src_live.id, dst_live.id))
            if hit is None:
                self.plan.edges.append(SyncEdgeAction(sp, tp, "create", imp_idx=ei))
            else:
                seen.add((src_live.id, dst_live.id))
                self.plan.edges.append(
                    SyncEdgeAction(sp, tp, "unchanged", edge_id=hit.id, imp_idx=ei)
                )

        # Пропавшие: живые связи МЕЖДУ СМЭТЧЕННЫМИ узлами, которых прогон не дал.
        # Связь, чей конец сам помечен missing, сюда НЕ попадает намеренно: узел
        # не удаляется (в худшем случае помечается deprecated), значит связь в него
        # остаётся валидной, и звать её пропавшей — вводить в заблуждение.
        for (src, dst), live_edge in live_pairs.items():
            if (src, dst) in seen or src not in self.taken or dst not in self.taken:
                continue
            self.plan.edges.append(
                SyncEdgeAction(
                    self.live_paths.get(src, self.by_id[src].name),
                    self.live_paths.get(dst, self.by_id[dst].name),
                    "missing",
                    edge_id=live_edge.id,
                )
            )


def build_sync_plan(
    nodes: list[Node],
    edges: list[Edge],
    parsed: ParsedImport,
    policies: SyncPolicies | None = None,
) -> SyncPlan:
    """Свежий прогон агента × живая схема → что изменится. БД не трогает."""
    m = _Matcher(nodes, edges, policies or SyncPolicies())
    m.plan.policies = m.policies
    m.walk_import(parsed)
    m.collect_missing()
    m.walk_edges(parsed)
    return m.plan
