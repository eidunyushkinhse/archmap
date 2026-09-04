"""Догрузка знания в ЖИВОЙ проект: N архивов доливаются с мерджем (Ф3,
docs/plan-unified-import.md).

Конвейер тот же, что у создания, — и это главное решение фазы: текущий проект
едет ВХОДОМ №0 (его собственный архив, build_archive_ordered в память), а дальше
работает уже написанное ядро (build_unified_plan): C4 сливается по identity, семьи
фактов переезжают на смердженные узлы, равные тела дедуплицируются молча, разные
становятся спором с кандидатами. Второго матчера и второй конфликтной модели у
догрузки нет.

Отличий от создания ровно три::

  1. КАРТА «узел входа №0 → живая запись». Строится по ПОРЯДКУ экспорта
     (build_export_ordered), а не по путям: тёзки в одном родителе легальны, и путь
     адресует двоих. Расхождение порядка с разбором — не «поправим на месте», а
     ошибка плана: перепутанная карта писала бы поля в чужие узлы.
  2. ДЕФОЛТ СПОРА — «оставить моё» (решение груминга п.2): догрузка аддитивна,
     живая запись перетирается ТОЛЬКО явным выбором архивного кандидата. Кандидат
     входа №0 помечен current — фронту не надо угадывать «моё» по подписи.
  3. ПРИМЕНЕНИЕ — ДИФФ, а не запись с нуля: живой узел получает пустые поля
     (fill-only), новый создаётся, существующая связь пропускается, живая запись
     семьи трогается только если проиграла спор. НЕ УДАЛЯЕТСЯ НИЧЕГО и никогда —
     ни узел, ни колонка, ни поле сообщения: данные пользователя не наши.

Раскладка (view_layout) не трогается вовсе: существующие узлы не двигаются, новым
координаты построит конвейер (аксиома эпика архива).
"""

import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.orm import Session, undefer

from app.archive_export import build_archive_ordered
from app.channels_import import ChannelIn, apply_channels_plan, build_channels_plan
from app.config_import import ParamIn, apply_config_plan, build_config_plan
from app.data_import import TableIn, apply_data_plan, build_data_plan
from app.identity import known_key, source_ref_dict
from app.import_yaml import _ImpNode
from app.models.business_process import BusinessProcess
from app.models.config_param import ConfigParam
from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.project import Project
from app.process_import import apply_import as apply_process_import
from app.process_import import build_preview as build_process_preview
from app.processes import node_path
from app.schemas.channels_import import ChannelsImportReport
from app.schemas.config_import import ConfigImportReport
from app.schemas.data_import import DataImportReport
from app.schemas.node import NodeSource
from app.schemas.process_import import ProcessImportResult
from app.schemas.project import MergedNodeOut
from app.schemas.unified_import import (
    FamilyCandidateOut,
    FamilyConflictOut,
    IntoApplyOut,
    IntoPreviewOut,
    NewNodeOut,
    UnifiedFamilyCountsOut,
)

# Приватное соседей — осознанно, как у unified_apply с process_import: механика
# выбора победителей, свободного имени и переписывания адресов у создания и
# догрузки обязана быть ОДНОЙ И ТОЙ ЖЕ, иначе два сценария разъедутся в поведении.
from app.unified_apply import (
    _address_map,
    _choice_index,
    _free_name,
    _rewrite_doc_addresses,
    _synthetic_files,
    _Winner,
    _winners,
)
from app.unified_import import (
    MAX_ARCHIVES,
    DocIn,
    Family,
    FamilyCounts,
    UnifiedImportError,
    UnifiedPlan,
    _bump,
    build_unified_plan,
)
from app.view_state import bump_graph_rev, bump_meta_rev

# Как зовётся вход №0 в замечаниях и кандидатах спора. Пользователь видит его
# наравне с чипами архивов — «моё» должно называться человеческим словом.
SELF_LABEL = "Текущий проект"

# Сколько путей новых узлов кладём в превью: список нужен для понимания «что
# приедет», а не для чтения целиком (полное число рядом, в nodes_new).
MAX_PREVIEW_PATHS = 8

# Не-архив на входе догрузки. YAML к живому проекту заливается синком — это другая
# механика (якоря, create/update, пометки пропаж), и подменять её мерджем нельзя.
NOT_ARCHIVE = (
    "это не архив ArchMap; YAML в существующий проект заливается через "
    "«Импорт схемы» (синк)"
)

_FIELD_RU: dict[str, str] = {
    "description": "описание",
    "role": "роль",
    "technology": "технология",
    "shape": "форма",
    "status": "статус",
}
# Поля, которые ДОЛИВАЮТСЯ в пустое живое место. Остальные (форма, статус) только
# сверяются: у них нет «пусто», а тихая смена формы переставила бы секции на
# странице объекта (структура БД видна только у database).
_FILLABLE = ("description", "role", "technology")


@dataclass
class IntoPlan:
    """План догрузки: обычный план ввоза + карта на живые записи и сводка диффа.

    plan=None — до ядра дело не дошло (вход не архив): показывать нечего, кроме
    ошибок, адресованных чипам."""

    plan: UnifiedPlan | None
    ok: bool
    errors: list[str]
    base_graph_rev: int
    base_meta_rev: int
    # merged-узел → ЖИВОЙ узел (вклад входа №0). Отсутствие ключа = узел новый.
    live_of: dict[int, Node] = field(default_factory=dict)
    # merged-узлы, в которые слилось НЕСКОЛЬКО живых (тёзки одного родителя): их поля
    # смешаны из разных записей, и доливать по ним нельзя — ни в одну из них.
    ambiguous: set[int] = field(default_factory=set)
    new_nodes: list[int] = field(default_factory=list)  # индексы merged-узлов к созданию
    new_edges: list[int] = field(default_factory=list)  # индексы merged-связей к созданию
    new_processes: list[int] = field(default_factory=list)  # индексы plan.processes к ввозу
    counts: FamilyCounts = field(default_factory=FamilyCounts)  # НОВОЕ при дефолтах
    warnings: list[str] = field(default_factory=list)


# ── Построение плана ─────────────────────────────────────────────────────────


def _cut(text: str | None, limit: int = 60) -> str:
    """Значение поля в строке отчёта: длинное описание целиком там не нужно."""
    s = (text or "").strip().replace("\n", " ")
    return s if len(s) <= limit else s[: limit - 1] + "…"


def build_into_plan(db: Session, project: Project, inputs: list[tuple[str, bytes]]) -> IntoPlan:
    """План догрузки архивов к живому проекту. БД не меняет.

    UnifiedImportError — запрос невозможен целиком (пусто, превышен кап). Беда
    отдельного входа (не архив, кривой zip, неразобранный C4) ответ не роняет, а
    едет ошибкой, адресованной чипу: пользователь уберёт его и повторит."""
    if not inputs:
        raise UnifiedImportError("Не передан ни один файл")
    if len(inputs) > MAX_ARCHIVES:
        raise UnifiedImportError(f"Больше {MAX_ARCHIVES} архивов за раз не принимаем")

    graph_rev, meta_rev = project.graph_rev, project.meta_rev

    def failed(plan: UnifiedPlan | None, errors: list[str]) -> IntoPlan:
        return IntoPlan(plan=plan, ok=False, errors=errors, base_graph_rev=graph_rev,
                        base_meta_rev=meta_rev)

    # Тип входа — по содержимому (магия zip), как у создания: имя файла может врать.
    not_archives = [
        f"{label or f'вход {i + 1}'}: {NOT_ARCHIVE}"
        for i, (label, payload) in enumerate(inputs)
        if not payload.startswith(b"PK")
    ]
    if not_archives:
        return failed(None, not_archives)

    self_bytes, node_order = build_archive_ordered(db, project)
    plan = build_unified_plan([(SELF_LABEL, self_bytes), *inputs])
    if not plan.ok or plan.merged is None:
        return failed(plan, _addressed_errors(plan))

    live_by_id = {n.id: n for n in db.query(Node).filter(Node.project_id == project.id).all()}
    live_order = [live_by_id[nid] for nid in node_order]
    mismatch = _order_mismatch(plan, live_order, live_by_id)
    if mismatch:
        # Карта не сошлась — писать по ней значит писать в чужие узлы. Стоп.
        return failed(plan, [mismatch])

    warnings: list[str] = []
    live_of: dict[int, Node] = {}
    ambiguous: set[int] = set()
    for m, contribs in enumerate(plan.report.node_contribs):
        mine = [ni for fi, ni in contribs if fi == 0]
        if not mine:
            continue
        live_of[m] = live_order[mine[0]]
        if len(mine) > 1:
            ambiguous.add(m)
        for ni in mine[1:]:
            # Тёзки одного родителя слились в один merged-узел: знание приедет к
            # первому, второй останется как был (переклеивать и удалять нельзя).
            warnings.append(
                f"узлы-тёзки «{plan.node_paths[m]}» слились в один — знание приедет к "
                f"первому из них, второй ({live_order[ni].name}) остался как был"
            )

    _mark_current(plan)
    new_processes = _kept_processes(plan)
    counts = FamilyCounts()
    for w in _winners(plan, {}):  # дефолты: у спора с живым это «оставить моё»
        if w.origin != 0:
            _bump(counts, w.family, 1)
    counts.processes = len(new_processes)
    warnings.extend(_merge_notes(plan))
    warnings.extend(_process_notes(plan, new_processes))

    return IntoPlan(
        plan=plan,
        ok=True,
        errors=[],
        base_graph_rev=graph_rev,
        base_meta_rev=meta_rev,
        live_of=live_of,
        ambiguous=ambiguous,
        new_nodes=[m for m in range(len(plan.merged.nodes)) if m not in live_of],
        new_edges=[i for i, files in enumerate(plan.report.edge_files) if 0 not in files],
        new_processes=new_processes,
        counts=counts,
        warnings=warnings,
    )


def _addressed_errors(plan: UnifiedPlan) -> list[str]:
    """Ошибки входов, адресованные ИМЕНЕМ чипа, а не номером.

    Номера в текстах ядра считают вход №0 первым файлом («вход 2» — это первый
    архив пользователя), и показывать их человеку нельзя. Имена берём из плана."""
    out: list[str] = []
    for fi, msgs in sorted(plan.report.file_errors.items()):
        label = plan.labels[fi] if fi < len(plan.labels) else f"вход {fi + 1}"
        out.extend(f"{label}: {m}" for m in msgs)
    out.extend(plan.report.errors)  # схемные (лимиты слияния) — без виновника
    return out or list(plan.errors)


def _order_mismatch(
    plan: UnifiedPlan, live_order: list[Node], live_by_id: dict[uuid.UUID, Node]
) -> str | None:
    """Сверка карты «порядок экспорта = нумерация разбора» по путям узлов.

    Инвариант держится по построению (обход один и тот же), но цена его нарушения —
    запись в ЧУЖОЙ узел, поэтому он проверяется, а не подразумевается."""
    mine = plan.origin_paths[0] if plan.origin_paths else []
    if len(mine) != len(live_order):
        return (
            f"Архив текущего проекта не сошёлся с его схемой ({len(live_order)} узлов "
            f"против {len(mine)} разобранных) — догрузка отменена, сообщите разработчику"
        )
    for ni, path in enumerate(mine):
        if node_path(live_by_id, live_order[ni].id) != path:
            return (
                f"Архив текущего проекта не сошёлся с его схемой (узел «{path}») — "
                "догрузка отменена, сообщите разработчику"
            )
    return None


def _mark_current(plan: UnifiedPlan) -> None:
    """Пометить кандидатов входа №0 и переставить дефолты споров на «оставить моё».

    У спора ТОЛЬКО привозимых архивов между собой живого конкурента нет — его дефолт
    остаётся прежним (как при создании): выбирать там можно лишь между двумя чужими
    телами, и «моего» среди них не существует."""
    for c in plan.conflicts:
        live_idx: int | None = None
        for i, cand in enumerate(c.candidates):
            cand.current = cand.origin == 0
            if cand.current and live_idx is None:
                live_idx = i
        if live_idx is not None:
            c.default = f"cand:{live_idx}"


def _merge_notes(plan: UnifiedPlan) -> list[str]:
    """Замечания слияния и входов — человеку, с адресацией именами чипов.

    Тексты слияния нумеруют файлы («оставлено … (файл 1)»), и вход №0 сдвинул эту
    нумерацию на единицу — поэтому впереди едет легенда, а не молчание."""
    out: list[str] = []
    merge_lines = [*plan.report.conflicts, *plan.report.warnings]
    if merge_lines:
        if any("файл " in ln for ln in merge_lines):
            legend = ", ".join(f"файл {i + 1} — {label}" for i, label in enumerate(plan.labels))
            out.append(f"нумерация файлов в замечаниях слияния: {legend}")
        out.extend(merge_lines)
    # plan.warnings — замечания ядра о тёзках процессов; догрузка считает их сама
    # (_process_notes), потому что копию живого процесса она узнаёт и не ввозит.
    for i, remarks in enumerate(plan.input_remarks):
        label = plan.labels[i] if i < len(plan.labels) else f"вход {i + 1}"
        out.extend(f"{label}: {r}" for r in remarks)
    return out


def _kept_processes(plan: UnifiedPlan) -> list[int]:
    """Индексы привозимых процессов, которые действительно приедут.

    Процессы не сливаются никогда (решение груминга) — но БАЙТ-В-БАЙТ ТА ЖЕ
    диаграмма под тем же именем это не второй процесс, а копия уже живущего
    (типовой случай: догружают архив этого же проекта). Такую копию пропускаем
    молча — тем же правилом, каким ядро схлопывает равные тела фактов. Копии
    ищем только против СВОИХ процессов: спор двух архивов между собой догрузка
    решает ровно так же, как создание (тёзка едет с суффиксом)."""
    mine = {(p.name.strip(), p.text.strip()) for p in plan.processes if p.origin == 0}
    return [
        i
        for i, p in enumerate(plan.processes)
        if p.origin != 0 and (p.name.strip(), p.text.strip()) not in mine
    ]


def _process_notes(plan: UnifiedPlan, kept: list[int]) -> list[str]:
    """Предупреждение о тёзках среди тех процессов, что ПРИЕДУТ.

    Ядро считает своё (_warn_process_namesakes), но оно не знает про копии живых —
    и обещало бы суффикс там, где не приедет вообще ничего."""
    taken = {p.name for p in plan.processes if p.origin == 0}
    out: list[str] = []
    for i in kept:
        p = plan.processes[i]
        if p.name in taken:
            out.append(
                f"процесс «{p.name}» из входа «{p.origin_label}» — тёзка уже имеющегося: "
                "процессы не сливаются, приедет с суффиксом « (2)»"
            )
        taken.add(p.name)
    return out


def _anchor_of(plan: UnifiedPlan, m: int) -> NodeSource | None:
    """Якорь merged-узла в виде контракта — «будет ли он у нового объекта».

    Ключ снятого вида (архив прежней модели якоря) якорем не притворяется:
    source_ref_dict вернёт пусто, и превью честно скажет «без якоря» — ровно то,
    что запишет применение (гвард known_key на точках записи)."""
    if plan.merged is None:
        return None
    keys = plan.merged.nodes[m].source_keys
    d = source_ref_dict(keys[0]) if keys else {}
    return NodeSource(**d) if d else None


def into_preview(into: IntoPlan) -> IntoPreviewOut:
    """План догрузки → ответ превью (то же самое человеку и фронту)."""
    plan = into.plan
    paths = [plan.node_paths[m] for m in into.new_nodes] if plan else []
    conflicts = plan.conflicts if (plan and into.ok) else []
    # Живые узлы, К КОТОРЫМ ЧТО-ТО ЕДЕТ: у них вклад не только свой (вход №0), но и
    # хотя бы одного архива. Узел, который нашёл сам себя и больше ничей, — это не
    # находка догрузки, а вся остальная схема: перечислять её значит топить дифф.
    matched = (
        [m for m in sorted(into.live_of) if len(plan.report.node_contribs[m]) > 1]
        if plan and into.ok
        else []
    )
    return IntoPreviewOut(
        ok=into.ok,
        errors=into.errors,
        nodes_new=len(into.new_nodes),
        nodes_new_paths=paths[:MAX_PREVIEW_PATHS],
        new_nodes=[
            NewNodeOut(path=plan.node_paths[m], source=_anchor_of(plan, m))
            for m in into.new_nodes[:MAX_PREVIEW_PATHS]
        ] if plan else [],
        nodes_matched=len(matched),
        # Основание берём из отчёта мерджа — того же, каким сделана склейка.
        matched_nodes=[
            MergedNodeOut(
                path=plan.node_paths[m],
                basis=plan.report.node_basis[m] or "name",  # type: ignore[arg-type]
            )
            for m in matched[:MAX_PREVIEW_PATHS]
        ] if plan else [],
        edges_new=len(into.new_edges),
        families=UnifiedFamilyCountsOut(
            docs=into.counts.docs,
            specs=into.counts.specs,
            tables=into.counts.tables,
            channels=into.counts.channels,
            params=into.counts.params,
            processes=into.counts.processes,
        ),
        family_conflicts=[
            FamilyConflictOut(
                id=c.id,
                family=c.family,
                node_path=c.node_path,
                key=c.key,
                candidates=[
                    FamilyCandidateOut(
                        origin=k.origin,
                        origin_label=k.origin_label,
                        summary=k.summary,
                        body=k.body,
                        truncated=k.truncated,
                        current=k.current,
                    )
                    for k in c.candidates
                ],
                default=c.default,
                allow_all=c.allow_all,
            )
            for c in conflicts
        ],
        warnings=into.warnings,
        base_graph_rev=into.base_graph_rev,
        base_meta_rev=into.base_meta_rev,
    )


# ── Применение ───────────────────────────────────────────────────────────────


def _live_lost(plan: UnifiedPlan, resolutions: dict[str, str]) -> set[tuple[Family, int, str]]:
    """Ключи, у которых ЖИВАЯ запись проиграла спор архиву.

    Только они дают перезапись. «Взять все» проигрышем не считается: живая запись
    остаётся на месте, а привозная тёзка получает суффикс — живут обе."""
    out: set[tuple[Family, int, str]] = set()
    for c in plan.conflicts:
        idx = _choice_index(c.id, resolutions.get(c.id, c.default), len(c.candidates), c.allow_all)
        chosen = c.candidates if idx is None else [c.candidates[idx]]
        if any(k.origin == 0 for k in c.candidates) and not any(k.origin == 0 for k in chosen):
            out.add((c.family, c.node_idx, c.key))
    return out


def _fill_node(live: Node, imp: _ImpNode, path: str, warnings: list[str]) -> bool:
    """FILL-ONLY: пустое живое поле долить, заполненное не трогать, расхождение — в
    отчёт. Догрузка не спорит с человеком о том, что он написал сам."""
    changed = False
    for fld in _FILLABLE:
        new_raw: str | None = getattr(imp, fld)
        new, cur = (new_raw or "").strip(), (getattr(live, fld) or "").strip()
        if not new or new == cur:
            continue
        if not cur:
            setattr(live, fld, new_raw)
            changed = True
            warnings.append(f"узел «{path}»: поле «{_FIELD_RU[fld]}» пустовало — залито из архива")
        else:
            warnings.append(
                f"узел «{path}»: поле «{_FIELD_RU[fld]}» в архиве другое («{_cut(new)}») — "
                f"оставлено живое («{_cut(cur)}»)"
            )
    # Якорь источника — не «поле», а идентичность узла для будущего синка: пустой
    # долить можно, занятый перевешивать нельзя (перевесил бы прогоны на чужой репо).
    if not live.source_ref and imp.source_keys:
        live.source_ref = known_key(imp.source_keys[0])
        changed = True
    for fld in ("shape", "status"):
        if getattr(imp, fld) != getattr(live, fld):
            warnings.append(
                f"узел «{path}»: поле «{_FIELD_RU[fld]}» в архиве другое "
                f"(«{getattr(imp, fld)}») — оставлено живое («{getattr(live, fld)}»)"
            )
    if changed:
        live.version += 1
    return changed


def _merge_report(a: Any, b: Any) -> Any:
    """Два прогона родного приёмника (новое + наложение) — один отчёт семьи.

    Счётчики складываются, перечни склеиваются: пользователю нужна одна сводка по
    семье, а не две половинки без объяснения, почему их две."""
    if a is None or b is None:
        return a or b
    data: dict[str, Any] = {}
    for name in type(a).model_fields:
        va, vb = getattr(a, name), getattr(b, name)
        if isinstance(va, list):
            data[name] = [*va, *vb]
        elif isinstance(va, bool):
            data[name] = va or vb
        elif isinstance(va, int):
            data[name] = va + vb
        else:
            data[name] = va or vb
    return type(a)(**data)


def apply_into_plan(
    db: Session, project: Project, into: IntoPlan, resolutions: dict[str, str]
) -> IntoApplyOut:
    """Применить план догрузки к живому проекту. Коммит — на вызывающей стороне.

    Порядок тот же, что у создания (C4 → схемы логики → семьи → спеки → процессы):
    шаги процессов привязываются к уже существующим схемам, адреса семей — к уже
    созданным узлам."""
    plan = into.plan
    merged = plan.merged if plan else None
    if not into.ok or plan is None or merged is None:
        raise UnifiedImportError(
            "План непригоден к применению: " + ("; ".join(into.errors[:5]) or "неизвестно почему")
        )
    winners = _winners(plan, resolutions)  # валидация резолюций — ДО любой записи
    lost = _live_lost(plan, resolutions)
    warnings: list[str] = list(into.warnings)

    # ── C4: живому узлу — пустые поля, новому — рождение. Ничего не удаляем.
    node_of: list[Node] = []
    nodes_filled = 0
    for m, imp in enumerate(merged.nodes):
        live = into.live_of.get(m)
        if live is not None:
            node_of.append(live)
            # Смешанные поля тёзок не доливаем НИКОМУ: значение в merged-узле собрано
            # из нескольких живых записей, и записать его — значит переписать одну
            # чужими данными (замечание об этом уже в плане).
            if m not in into.ambiguous and _fill_node(live, imp, plan.node_paths[m], warnings):
                nodes_filled += 1
            continue
        # Родитель уже в списке: merged-узлы идут «родители раньше детей».
        parent = node_of[imp.parent_idx] if imp.parent_idx is not None else None
        node = Node(
            id=uuid.uuid4(),
            project_id=project.id,
            name=imp.name,
            description=imp.description,
            role=imp.role,
            technology=imp.technology,
            shape=imp.shape,
            status=imp.status,
            is_external=imp.is_external,
            source_ref=known_key(imp.source_keys[0]) if imp.source_keys else None,
            parent_id=parent.id if parent else None,
        )
        db.add(node)
        node_of.append(node)
    db.flush()

    for i in into.new_edges:
        e = merged.edges[i]
        db.add(
            Edge(
                id=uuid.uuid4(),
                project_id=project.id,
                source_id=node_of[e.source_idx].id,
                target_id=node_of[e.target_idx].id,
                label=e.label,
                technology=e.technology,
                channel=e.channel,
                is_synchronous=e.is_synchronous,
            )
        )
    db.flush()

    nodes = db.query(Node).filter(Node.project_id == project.id).all()
    by_id = {n.id: n for n in nodes}
    path_of = [node_path(by_id, n.id) for n in node_of]

    docs_created, docs_replaced, renamed, shared = _apply_docs(db, project, winners, lost, node_of)

    specs_applied = 0
    for w in winners:
        if w.family == "spec" and isinstance(w.value, str) and w.origin != 0:
            node_of[w.node_idx].openapi_spec = w.value
            node_of[w.node_idx].version += 1
            specs_applied += 1

    params_replaced = _replace_params(db, winners, lost, node_of, warnings)
    db.flush()

    # ── Семьи-записи: родными приёмниками, ДВА прогона с разными наборами файлов —
    #    новое кладём политикой «не трогать занятое», выигравшее спор накладываем
    #    поверх. Смешивать нельзя: overwrite на весь пакет перетёр бы и то, о чём
    #    пользователя не спрашивали.
    _warn_extra_parts(winners, lost, node_of, path_of, warnings)
    db_report = _run_family("table", build_data_plan, apply_data_plan,
                            db, nodes, winners, lost, path_of)
    channels_report = _run_family("channel", build_channels_plan, apply_channels_plan,
                                  db, nodes, winners, lost, path_of)
    config_report = _run_family("config", build_config_plan, apply_config_plan,
                                db, nodes, winners, lost, path_of, policies=(False,))

    process_results = _apply_processes(
        db, project, plan, into.new_processes, renamed, shared, path_of, warnings
    )

    # Курсоры поллинга: чужие сессии подтянут и схему (узлы/связи), и мету (доки,
    # факты, спеки) — догрузка трогает обе половины.
    bump_graph_rev(db, project)
    bump_meta_rev(db, project)
    return IntoApplyOut(
        project_id=project.id,
        nodes_created=len(into.new_nodes),
        nodes_filled=nodes_filled,
        edges_created=len(into.new_edges),
        docs_created=docs_created,
        docs_replaced=docs_replaced,
        specs_applied=specs_applied,
        params_replaced=params_replaced,
        db=db_report,
        channels=channels_report,
        config=config_report,
        processes=process_results,
        warnings=warnings,
        resolved_conflicts=len(plan.conflicts),
        graph_rev=project.graph_rev,
        meta_rev=project.meta_rev,
    )


def _apply_docs(
    db: Session,
    project: Project,
    winners: list[_Winner],
    lost: set[tuple[Family, int, str]],
    node_of: list[Node],
) -> tuple[int, int, dict[tuple[int, int, str], str], dict[tuple[int, str], str]]:
    """Схемы логики: победитель входа №0 пропускается, привозной пишется.

    Тело живой схемы заменяется ТОЛЬКО если она проиграла спор; иначе привозная
    тёзка получает свободное имя (« (2)»), и живут обе. Возвращает карты
    переименований для привязок процессов — те же, что у создания."""
    created = replaced = 0
    live_docs = (
        db.query(NodeDoc)
        .join(Node, Node.id == NodeDoc.node_id)
        .filter(Node.project_id == project.id)
        .options(undefer(NodeDoc.content))
        .all()
    )
    by_key: dict[tuple[uuid.UUID, str], NodeDoc] = {(d.node_id, d.name): d for d in live_docs}
    taken: dict[uuid.UUID, set[str]] = {}
    for d in live_docs:
        taken.setdefault(d.node_id, set()).add(d.name)

    renamed: dict[tuple[int, int, str], str] = {}
    shared: dict[tuple[int, str], str] = {}
    for w in winners:
        if not isinstance(w.value, DocIn):
            continue
        node = node_of[w.node_idx]
        if w.origin == 0:
            # Запись уже живёт: адрес ЛЮБОГО входа с этим именем ведёт к ней.
            shared[(w.node_idx, w.value.name)] = w.value.name
            continue
        live = by_key.get((node.id, w.value.name))
        if live is not None and (w.family, w.node_idx, w.key) in lost:
            live.content = w.value.body
            live.kind = w.value.kind
            live.operation = w.value.operation
            live.version += 1
            replaced += 1
            renamed[(w.origin, w.node_idx, w.value.name)] = live.name
            shared[(w.node_idx, w.value.name)] = live.name
            continue
        names = taken.setdefault(node.id, set())
        actual = _free_name(w.value.name, names)
        names.add(actual)
        doc = NodeDoc(
            node_id=node.id,
            name=actual,
            kind=w.value.kind,
            operation=w.value.operation,
            content=w.value.body,
        )
        db.add(doc)
        by_key[(node.id, actual)] = doc
        created += 1
        renamed[(w.origin, w.node_idx, w.value.name)] = actual
        if not w.from_conflict:
            shared[(w.node_idx, w.value.name)] = actual
    db.flush()
    return created, replaced, renamed, shared


def _replace_params(
    db: Session,
    winners: list[_Winner],
    lost: set[tuple[Family, int, str]],
    node_of: list[Node],
    warnings: list[str],
) -> int:
    """Параметры, у которых живая запись проиграла спор: тело заменяется целиком.

    Именно целиком, а не «только заполненное пакетом» (политика overwrite родного
    приёмника): архив — ПОЛНЫЙ снимок записи, и пустой дефолт в нём значит «дефолта
    нет», а не «не видно из моего среза кода»."""
    replaced = 0
    for w in winners:
        if w.family != "config" or w.origin == 0 or not isinstance(w.value, ParamIn):
            continue
        if (w.family, w.node_idx, w.key) not in lost:
            continue  # новое кладёт родной приёмник синтетическим файлом
        param = (
            db.query(ConfigParam)
            .filter(
                ConfigParam.node_id == node_of[w.node_idx].id,
                ConfigParam.name == w.value.name,
            )
            .first()
        )
        if param is None:  # запись исчезла между расчётом и применением
            warnings.append(f"параметр «{w.value.name}»: живой записи уже нет — пропущен")
            continue
        param.value_type = w.value.value_type
        param.required = w.value.required
        param.default_value = w.value.default_value
        param.description = w.value.description
        param.version += 1
        replaced += 1
    return replaced


def _family_files(
    family: Family,
    winners: list[_Winner],
    lost: set[tuple[Family, int, str]],
    path_of: list[str],
    overwritten: bool,
) -> list[tuple[str, str]]:
    """Синтетические файлы одной семьи: либо только НОВОЕ, либо только выигравшее
    спор с живым. Два набора — два прогона приёмника с разной политикой."""
    chosen = [
        w
        for w in winners
        if w.family == family
        and w.origin != 0
        and (((w.family, w.node_idx, w.key) in lost) is overwritten)
    ]
    return _synthetic_files(family, chosen, path_of)


def _run_family(
    family: Family,
    build: Callable[..., Any],  # родные build_*_plan семьи: планы у них разных типов
    apply: Callable[..., Any],
    db: Session,
    nodes: list[Node],
    winners: list[_Winner],
    lost: set[tuple[Family, int, str]],
    path_of: list[str],
    policies: tuple[bool, ...] = (False, True),
) -> DataImportReport | ChannelsImportReport | ConfigImportReport | None:
    """Прогон родного приёмника семьи: сначала новое (занятое не трогать), затем
    выигравшее спор (наложение). nodes — ВСЕ узлы проекта, уже с созданными.

    policies=(False,) — у семьи наложения не бывает: параметр конфигурации, проигравший
    спор, заменяется телом целиком (_replace_params), и второй проход задвоил бы
    правку (лишний bump version)."""
    report: DataImportReport | ChannelsImportReport | ConfigImportReport | None = None
    for overwrite in policies:
        files = _family_files(family, winners, lost, path_of, overwrite)
        if not files:
            continue
        family_plan = build(db, nodes, files, None, overwrite)
        apply(db, family_plan, overwrite)
        report = _merge_report(report, family_plan.report)
    return report


def _extra_kept(
    live_names: list[str], archive_names: list[str], what: str, whose: str, warnings: list[str]
) -> None:
    """Живые части записи, которых нет в архиве, остаются жить — и это говорится
    вслух: пользователь выбрал «взять из архива» и вправе ждать ровно архив.
    Удалять их нельзя, это его данные."""
    extra = [n for n in live_names if n not in set(archive_names)]
    if extra:
        warnings.append(
            f"{whose}: {what} {', '.join(f'«{n}»' for n in extra)} в архиве нет — "
            "оставлены (догрузка не удаляет данные)"
        )


def _warn_extra_parts(
    winners: list[_Winner],
    lost: set[tuple[Family, int, str]],
    node_of: list[Node],
    path_of: list[str],
    warnings: list[str],
) -> None:
    """Колонки и поля, которых в архиве нет: наложение их не удалит — говорим об
    этом, пока пользователь помнит, что выбирал «взять из архива»."""
    for w in winners:
        if w.origin == 0 or (w.family, w.node_idx, w.key) not in lost:
            continue
        node = node_of[w.node_idx]
        if isinstance(w.value, TableIn):
            live_t = next(
                (t for t in node.db_tables
                 if t.name == w.value.name and t.schema_name == w.value.schema_name),
                None,
            )
            if live_t is not None:
                _extra_kept(
                    [c.name for c in live_t.columns], [c.name for c in w.value.columns],
                    "колонок", f"таблица «{w.key}» узла «{path_of[w.node_idx]}»", warnings,
                )
        elif isinstance(w.value, ChannelIn):
            live_c = next(
                (c for c in node.broker_channels
                 if c.name == w.value.name and c.group_name == w.value.group_name),
                None,
            )
            if live_c is not None:
                _extra_kept(
                    [f.name for f in live_c.fields], [f.name for f in w.value.fields],
                    "полей", f"канал «{w.key}» узла «{path_of[w.node_idx]}»", warnings,
                )


def _apply_processes(
    db: Session,
    project: Project,
    plan: UnifiedPlan,
    kept: list[int],
    renamed: dict[tuple[int, int, str], str],
    shared: dict[tuple[int, str], str],
    path_of: list[str],
    warnings: list[str],
) -> list[ProcessImportResult]:
    """Процессы привозных архивов (kept — те, что план решил ввозить). Свои (вход
    №0) и их точные копии пропускаются: они уже живут, ввоз задвоил бы их.

    Процессы не сливаются никогда (решение груминга): тёзка живого получает
    свободное имя. Привязки шагов переписываются в координаты ЭТОГО проекта."""
    taken = {
        p.name
        for p in db.query(BusinessProcess).filter(BusinessProcess.project_id == project.id).all()
    }
    addresses = _address_map(plan, renamed, shared, path_of)
    results: list[ProcessImportResult] = []
    for i in kept:
        item = plan.processes[i]
        name = _free_name(item.name, taken)
        taken.add(name)
        if name != item.name:
            warnings.append(
                f"процесс «{item.name}» из входа «{item.origin_label}» приехал под именем "
                f"«{name}»: процессы не сливаются"
            )
        text = _rewrite_doc_addresses(item.text, addresses.get(item.origin, {}))
        preview = build_process_preview(db, project.id, text, name)
        mapping = {p.alias: p.node_id for p in preview.participants}
        _, result = apply_process_import(db, project.id, text, name, mapping)
        results.append(result)
    return results


__all__ = ["IntoPlan", "apply_into_plan", "build_into_plan", "into_preview"]
