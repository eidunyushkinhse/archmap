"""Дозаливка доков от ИИ-агента в СУЩЕСТВУЮЩИЙ проект (этап 2 plan-agent-docs.md).

Три эндпоинта под require_project_editor (кнопка и применение — редактору проекта):
prompt — промпт со вложенным срезом схемы (весь проект или поддерево);
preview — dry-run плана без записи; apply — тот же план, пересчитанный на живом
состоянии, + запись (при errors ничего не пишется, отчёт с applied=false).
Структуру дозаливка НЕ меняет — только node_docs и openapi_spec существующих
узлов, поэтому этап B (мердж схемы) ей не нужен.
"""

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app import demo_limits, tree
from app.database import get_db
from app.deps import (
    commit_change,
    get_current_project,
    require_project_editor,
)
from app.docs_import import (
    DocsPlan,
    MmdOverride,
    apply_docs_plan,
    entry_point_catalogs,
    plan_from_upload,
    prompt_name_catalogs,
)
from app.docs_prompt import build_docs_prompt
from app.element_marks import build_elements, element_rows_of
from app.export import build_export
from app.models.edge import Edge
from app.models.node import Node
from app.models.project import Project
from app.models.user import User
from app.node_ref import NodeIndex
from app.schemas.docs_import import (
    DocsImportIn,
    DocsImportReport,
    DocsInclude,
    DocsLogicItem,
    DocsPromptOut,
    DocsSpecItem,
)
from app.skeptic_prompt import PromptVariant, prompt_for_variant
from app.view_state import bump_meta_rev

router = APIRouter(prefix="/docs-import", tags=["docs-import"])






@router.get("/prompt", response_model=DocsPromptOut)
def docs_prompt(
    node_id: uuid.UUID | None = None,
    include: DocsInclude = "both",
    lang: str = Query("ru", max_length=8),
    hints: str | None = Query(None, max_length=4000),
    target: str | None = Query(None, max_length=256),
    variant: PromptVariant = "builder",
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_project_editor),
) -> DocsPromptOut:
    """Промпт агенту со вложенным срезом схемы: node_id — поддерево (агенту
    одного сервиса хватает его контейнера), без node_id — весь проект.
    target — гранулярный режим «по одной схеме»: фокусирует агента на одном
    воркере/эндпоинте (крупные монолиты, которые не переварить за один заход).
    variant — строительный промпт (дефолт), обёртка с аудитом или один аудит
    (docs/plan-skeptic-audit.md)."""
    nodes = db.query(Node).filter(Node.project_id == project.id).all()
    edges = db.query(Edge).filter(Edge.project_id == project.id).all()
    # Куда уезжает спецификация главного узла среза, если не к нему самому (Р12
    # docs/plan-c4-elements.md): у компонента — его контейнеру (путь от корня проекта:
    # контейнер лежит вне среза), у системы — никуда, своего API у неё нет; у внешней
    # системы без вложенных (Р42) — к ней самой: агент описывает чужое API. Элементы
    # считаются по всем узлам проекта: элемент узла зависит от его предков. Те же
    # элементы печатают тип каждого сервиса в выписке (build_export typed) — и у среза
    # поддерева: контейнер над его корнем делает узлы среза компонентами. (Не в
    # докстринге: он уезжает в OpenAPI и в api.gen.ts.)
    elements = build_elements(element_rows_of(nodes))
    spec_owner: tuple[Literal["component", "system"], str] | None = None
    if node_id is not None:
        by_id = {n.id: n for n in nodes}
        if node_id not in by_id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Узел не найден")
        element = elements.effective(node_id)
        holder = elements.container_of(node_id)
        if element == "system" and not elements.external_system(node_id):
            spec_owner = ("system", by_id[node_id].name)
        elif element == "component" and holder in by_id:
            # Узел в цикле родителей до корня не доходит, и полного пути у него нет —
            # тогда хватает имени.
            path = NodeIndex.of(nodes).path_by_id().get(holder, by_id[holder].name)
            spec_owner = ("component", path)
        sub_ids = tree.subtree_ids(by_id, node_id)
        nodes = [by_id[i] for i in sub_ids]
        edges = [e for e in edges if e.source_id in sub_ids and e.target_id in sub_ids]
    export_slice = build_export(nodes, edges, root_id=node_id, typed=elements)
    tables, channels, params = prompt_name_catalogs(db, project.id, {n.id for n in nodes})
    described, pending = entry_point_catalogs(db, nodes)
    return DocsPromptOut(
        prompt=prompt_for_variant(
            variant,
            "docs",
            build_docs_prompt(
                export_slice, include, lang, hints, target, tables, channels,
                described, pending, param_catalog=params, spec_owner=spec_owner,
            ),
        )
    )




def _plan(db: Session, project: Project, payload: DocsImportIn) -> DocsPlan:
    # Демо-стенд: файл больше предела — 413 до разбора (docs/tasks/demo-mode.md).
    demo_limits.check_texts((f.name, f.content) for f in payload.files)
    overrides = {o.file: MmdOverride(name=o.name, kind=o.kind, node=o.node) for o in payload.overrides}
    return plan_from_upload(
        db, project.id, [(f.name, f.content) for f in payload.files], overrides,
        payload.only, payload.node_id, payload.overwrite,
    )


def _report(plan: DocsPlan) -> DocsImportReport:
    # kind типизирован Literal-ом вида схемы (app/domain_types); action/origin —
    # строки плана, их значения проставляет строитель плана (build_docs_plan /
    # parse_manifest) из того же набора, что Literal схемы, а сверяет Pydantic.
    return DocsImportReport(
        logic=[
            DocsLogicItem(
                node_path=a.node_path,
                source=a.source,
                name=a.name,
                kind=a.kind,
                operation=a.operation,
                action=a.action,
                mermaid=a.mermaid,
            )
            for a in plan.logic
        ],
        specs=[
            DocsSpecItem(
                node_path=s.node_path,
                source=s.source,
                origin=s.origin,
                action=s.action,
                valid_yaml=s.valid_yaml,
                looks_openapi=s.looks_openapi,
                oas_version=s.oas_version,
            )
            for s in plan.specs
        ],
        errors=plan.errors,
        warnings=plan.warnings,
        conflicts=plan.conflicts,
        # Числа пометок пакета — и в превью, и в применении: окно сравнивает их
        # между попытками агента (ампутация пометок должна быть видна).
        data_refs_total=plan.data_refs_total,
        channel_refs_total=plan.channel_refs_total,
    )


@router.post("/preview", response_model=DocsImportReport)
def docs_import_preview(
    payload: DocsImportIn,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_project_editor),
) -> DocsImportReport:
    """Dry-run: план без записи (build_docs_plan БД только читает)."""
    return _report(_plan(db, project, payload))


@router.post("/apply", response_model=DocsImportReport)
def docs_import_apply(
    payload: DocsImportIn,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> DocsImportReport:
    """Применение: план пересчитывается на живом состоянии (между превью и
    применением мир мог измениться); при errors не пишется ничего."""
    plan = _plan(db, project, payload)
    report = _report(plan)
    if plan.errors:
        return report  # applied=False — фронт показывает ошибки
    done = apply_docs_plan(db, plan)
    if any(done):
        bump_meta_rev(db, project)  # доки/спеки — мета узла: поллинг страницы увидит
    commit_change(db, project, user.id)
    report.applied = True
    report.created_docs = done.created
    report.filled_docs = done.filled
    report.updated_docs = done.updated
    report.specs_written = done.specs
    return report
