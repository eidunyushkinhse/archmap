"""Превью единого импорта — то же самое человеку и фронту. Вынесено из
app/unified_import.py (аудит Q-19)."""

from dataclasses import asdict

from app.merge_report import (
    count_without_anchor,
    merged_with_basis,
    split_remarks,
)
from app.schemas.project import FileRemarksOut, ImportPreviewOut, MergedNodeOut
from app.schemas.unified_import import (
    FamilyCandidateOut,
    FamilyConflictOut,
    UnifiedFamilyCountsOut,
    UnifiedPreviewOut,
)
from app.unified_import import (
    MAX_ARCHIVES,
    MAX_INPUTS,
    DocIn,
    FamilyCandidate,
    FamilyConflict,
    FamilyCounts,
    FamilyItem,
    ProcessItem,
    UnifiedImportError,
    UnifiedPlan,
    build_unified_plan,
)
from app.unified_remarks import (
    RemainderIndex,
    apply_unfixable,
    friendly_apply_note,
    friendly_process_note,
    friendly_remark,
    remainder_from_plan,
    remainder_with_index,
    source_label,
)

# ── Превью (то же самое человеку и фронту) ───────────────────────────────────


def family_candidate_out(
    plan: UnifiedPlan, k: FamilyCandidate, current: int | None = None
) -> FamilyCandidateOut:
    """Кандидат спора семьи наружу. Один сборщик на создание и догрузку: подпись
    источника (§4.7) у них обязана быть одной и той же."""
    return FamilyCandidateOut(
        origin=k.origin,
        origin_label=k.origin_label,
        source_label=source_label(plan, k.origin, current),
        summary=k.summary,
        body=k.body,
        truncated=k.truncated,
        current=k.current,
    )


def preview_from_plan(plan: UnifiedPlan) -> UnifiedPreviewOut:
    """План → ответ превью единой панели.

    Замечания семей доложены в ПОФАЙЛОВЫЕ корзины C4-отчёта по индексу входа: у
    пользователя один список на чип, а не два рядом. Схемные корзины остаются
    свойством слитой картины (split_remarks), как у обычного импорта."""
    file_remarks, schema_errors, schema_warnings = split_remarks(plan.report)
    remarks_out = [
        FileRemarksOut(
            file=f.file,
            errors=f.errors,
            warnings=[*f.warnings, *plan.input_remarks[i]],
        )
        for i, f in enumerate(file_remarks)
    ]
    merged = plan.merged
    c4 = ImportPreviewOut(
        ok=plan.ok,
        errors=plan.errors,
        node_count=len(merged.nodes) if merged else 0,
        edge_count=len(merged.edges) if merged else 0,
        roots=merged.roots[:8] if merged else [],
        files=len(plan.labels),
        merged_count=len(plan.report.merged_paths),
        merged=plan.report.merged_paths[:8],
        # Ф2 якорей: основание каждой склейки словами и счётчик узлов без якоря.
        merged_nodes=[
            MergedNodeOut(path=path, basis=basis)
            for path, basis in merged_with_basis(plan.report)
        ],
        nodes_without_anchor=count_without_anchor(merged) if merged else 0,
        conflicts=plan.report.conflicts,
        warnings=plan.report.warnings,
        dropped_edges=plan.report.dropped_edges,
        node_names=[n.name for n in merged.nodes] if merged else [],
        file_remarks=remarks_out,
        schema_errors=schema_errors,
        schema_warnings=schema_warnings,
    )
    return UnifiedPreviewOut(
        ok=plan.ok,
        errors=plan.errors,
        c4=c4,
        families=UnifiedFamilyCountsOut(**asdict(plan.counts)),
        family_conflicts=[
            FamilyConflictOut(
                id=c.id,
                family=c.family,
                node_path=c.node_path,
                key=c.key,
                candidates=[family_candidate_out(plan, k) for k in c.candidates],
                default=c.default,
                allow_all=c.allow_all,
            )
            for c in plan.conflicts
        ],
        remainder=remainder_from_plan(plan, None),
        warnings=plan.warnings,
        name_source=plan.name_source,
        manifest_name=plan.manifest_name,
        manifest_description=plan.manifest_description,
    )


__all__ = [
    "MAX_ARCHIVES",
    "MAX_INPUTS",
    "DocIn",
    "FamilyCandidate",
    "FamilyConflict",
    "FamilyCounts",
    "FamilyItem",
    "ProcessItem",
    "RemainderIndex",
    "UnifiedImportError",
    "UnifiedPlan",
    "apply_unfixable",
    "build_unified_plan",
    "family_candidate_out",
    "friendly_apply_note",
    "friendly_process_note",
    "friendly_remark",
    "preview_from_plan",
    "remainder_from_plan",
    "remainder_with_index",
    "source_label",
]
