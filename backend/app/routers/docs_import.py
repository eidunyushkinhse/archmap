"""Дозаливка доков от ИИ-агента в СУЩЕСТВУЮЩИЙ проект (этап 2 plan-agent-docs.md).

Три эндпоинта под require_architect (кнопка и применение — только архитектор):
prompt — промпт со вложенным срезом схемы (весь проект или поддерево);
preview — dry-run плана без записи; apply — тот же план, пересчитанный на живом
состоянии, + запись (при errors ничего не пишется, отчёт с applied=false).
Структуру дозаливка НЕ меняет — только node_docs и openapi_spec существующих
узлов, поэтому этап B (мердж схемы) ей не нужен.
"""

import uuid
from typing import cast

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session, selectinload

from app import tree
from app.auth import require_architect
from app.data_refs import catalog_for_project
from app.database import get_db
from app.deps import get_current_project, touch_project
from app.docs_import import (
    DocsPlan,
    MmdOverride,
    ParsedPkg,
    _node_paths,
    apply_docs_plan,
    build_docs_plan,
    pkg_from_mmd,
    pkg_from_spec,
    spec_check,
)
from app.docs_prompt import build_docs_prompt
from app.export import build_export
from app.mmd_header import looks_like_mermaid
from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.project import Project
from app.models.user import User
from app.schemas.docs_import import (
    DocsAction,
    DocsImportIn,
    DocsImportReport,
    DocsInclude,
    DocsLogicItem,
    DocsPromptOut,
    DocsSpecItem,
    SpecOrigin,
)
from app.schemas.node_doc import NodeDocKind
from app.skeptic_prompt import PromptVariant, prompt_for_variant
from app.view_state import bump_meta_rev

router = APIRouter(prefix="/docs-import", tags=["docs-import"])


def _name_catalogs(
    db: Session, project_id: uuid.UUID
) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    """Каталоги имён для промпта: «путь узла → таблицы» и «путь узла → каналы».

    Имя пишется так, как его видит РЕЗОЛВЕР пометок: у таблицы с разделом и у канала
    с группой — «группа.имя». Каталог по всему проекту (а не по срезу node_id):
    пометка адресует любую базу и любой брокер проекта, и урезанный перечень отправил
    бы агента чинить верные имена (находка №1 docs/qa-zulip-brokers.md).
    """
    tables, channels, _params, node_paths = catalog_for_project(db, project_id)
    table_catalog: dict[str, list[str]] = {}
    for t in tables:
        path = node_paths.get(t.node_id)
        if path is not None:
            table_catalog.setdefault(path, []).append(
                f"{t.schema_name}.{t.name}" if t.schema_name else t.name
            )
    channel_catalog: dict[str, list[str]] = {}
    for c in channels:
        path = node_paths.get(c.node_id)
        if path is not None:
            channel_catalog.setdefault(path, []).append(
                f"{c.group_name}.{c.name}" if c.group_name else c.name
            )
    return table_catalog, channel_catalog


def _entry_point_catalogs(
    db: Session, nodes: list[Node]
) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    """Точки входа среза, разделённые надвое: описанные и ждущие описания (Ф3).

    Каталог — по узлам СРЕЗА (а не всего проекта): адреса в нём должны совпадать с
    путями из вложенного среза схемы, иначе агент увидит перечень для объектов,
    которых в срезе нет.

    Тела схем НЕ грузим: у монолита их две сотни, а вопрос тут булев — тянуть ради
    него мегабайты mermaid нельзя. «Описана» считает выражение в БД (NodeDoc.described,
    длина тела после trim), тем же способом, что признак в мете витрины.
    """
    _flat, fulls, _bare, _paths = _node_paths(nodes)
    path_by_id = {n.id: fulls[i] for i, n in enumerate(_flat)}
    described: dict[str, list[str]] = {}
    pending: dict[str, list[str]] = {}
    rows = (
        db.query(NodeDoc.node_id, NodeDoc.name, NodeDoc.operation, NodeDoc.described)
        .filter(
            NodeDoc.node_id.in_(path_by_id),
            # Обзорная схема точкой входа не является — в перечень разведки она не
            # входит по природе, и объявлять её «неописанной работой» неверно.
            NodeDoc.kind.in_(("operation", "worker")),
        )
        .all()
    )
    for node_id, name, operation, is_described in rows:
        path = path_by_id.get(node_id)
        if path is None:
            continue
        # Адрес операции показываем рядом с именем, когда они разошлись: агент назвал
        # схему по-человечески, и без адреса перечень не отвечает «что уже закрыто».
        подпись = f"{name} ({operation})" if operation and operation != name else name
        (described if is_described else pending).setdefault(path, []).append(подпись)
    return described, pending


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
    _: User = Depends(require_architect),
) -> DocsPromptOut:
    """Промпт агенту со вложенным срезом схемы: node_id — поддерево (агенту
    одного сервиса хватает его контейнера), без node_id — весь проект.
    target — гранулярный режим «по одной схеме»: фокусирует агента на одном
    воркере/эндпоинте (крупные монолиты, которые не переварить за один заход).
    variant — строительный промпт (дефолт), обёртка с аудитом или один аудит
    (docs/plan-skeptic-audit.md)."""
    nodes = db.query(Node).filter(Node.project_id == project.id).all()
    edges = db.query(Edge).filter(Edge.project_id == project.id).all()
    if node_id is not None:
        by_id = {n.id: n for n in nodes}
        if node_id not in by_id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Узел не найден")
        sub_ids = tree.subtree_ids(by_id, node_id)
        nodes = [by_id[i] for i in sub_ids]
        edges = [e for e in edges if e.source_id in sub_ids and e.target_id in sub_ids]
    export_slice = build_export(nodes, edges, root_id=node_id)
    tables, channels = _name_catalogs(db, project.id)
    described, pending = _entry_point_catalogs(db, nodes)
    return DocsPromptOut(
        prompt=prompt_for_variant(
            variant,
            "docs",
            build_docs_prompt(
                export_slice, include, lang, hints, target, tables, channels,
                described, pending,
            ),
        )
    )


def _plan_from_files(db: Session, project: Project, payload: DocsImportIn) -> DocsPlan:
    """Разбор загруженных файлов пакета → план. Схема логики опознаётся ПО
    СОДЕРЖИМОМУ (расширение, шапка или начало диаграммы), остальное — кандидат в
    файл спеки. Ошибки блокируют план целиком: частичный план вводил бы в
    заблуждение кнопку «Применить»."""
    entries: list[tuple[str, ParsedPkg]] = []
    assets: dict[str, str] = {}
    errors: list[str] = []
    notes: list[str] = []
    overrides = {o.file: MmdOverride(name=o.name, kind=o.kind, node=o.node) for o in payload.overrides}
    for f in payload.files:
        if looks_like_mermaid(f.name, f.content):
            # Схема логики самодостаточна: метаданные — в её шапке.
            parsed_mmd, mmd_notes = pkg_from_mmd(f.name, f.content, overrides.get(f.name))
            entries.append((f.name, parsed_mmd))
            notes.extend(mmd_notes)
        else:
            # Всё остальное — ресурс (кандидат в файл спеки). Дубль имени: последний
            # побеждает молча (имена в одной папке уникальны по построению).
            assets[f.name] = f.content
    if payload.only == "api" and payload.node_id is not None and assets:
        # Окно спеки: пакет — сам файл спеки, конверт не нужен (объект известен
        # из окна, спека у него одна). Из нескольких файлов выбираем похожий на
        # OpenAPI; если таких несколько — спрашиваем, а не угадываем.
        # Условие НЕ «файлов больше нет»: пользователь вправе перетащить всю
        # папку archmap-docs целиком, и спеку в ней надо найти, а не потерять
        # среди схем логики.
        picked = [n for n, c in assets.items() if spec_check(c)[1]] or list(assets)
        if len(picked) == 1:
            entries.append((picked[0], pkg_from_spec(picked[0], assets[picked[0]])))
        elif len(picked) > 1:
            errors.append("в пакете несколько файлов спеки: " + ", ".join(sorted(picked)))
    if not entries and not errors:
        errors.append("среди загруженных файлов нет ни схемы (.mmd), ни файла спеки")
    if errors:
        plan = DocsPlan()
        plan.errors = errors
        return plan
    # Тела ЖИВЫХ схем здесь нужны: план сравнивает текст пакета с текущим
    # («unchanged» / заполнение заглушки), а тело — отложенная колонка. Без undefer
    # мердж вытянул бы их по одной на схему — у монолита это две сотни запросов.
    nodes = (
        db.query(Node)
        .options(selectinload(Node.docs).undefer(NodeDoc.content))
        .filter(Node.project_id == project.id)
        .all()
    )
    scope_ids = None
    if payload.node_id is not None:
        by_id = {n.id: n for n in nodes}
        scope_ids = tree.subtree_ids(by_id, payload.node_id) if payload.node_id in by_id else set()
    # db/project_id — только для резолва пометок данных в текстах схем (превью
    # обязано показывать битые «читает:/пишет:» так же, как плашка редактора).
    plan = build_docs_plan(
        nodes, entries, assets, payload.overwrite, payload.node_id, scope_ids,
        db=db, project_id=project.id,
    )
    plan.warnings.extend(notes)
    # Раздельные окна дозаливки: окно логики применяет только схемы логики, окно
    # спеки — только OpenAPI-спеки (сущности не смешиваются даже в смешанном манифесте).
    if payload.only == "logic":
        plan.specs = []
    elif payload.only == "api":
        plan.logic = []
    return plan


def _report(plan: DocsPlan) -> DocsImportReport:
    # kind/action/origin приходят из внутреннего плана (LogicAction/SpecAction)
    # как str, но их значения гарантированно из домена Literal — проставляются
    # парсером/строителем плана (build_docs_plan/parse_manifest). Безопасный cast
    # на границе сериализации вместо игнор-комментариев.
    return DocsImportReport(
        logic=[
            DocsLogicItem(
                node_path=a.node_path,
                source=a.source,
                name=a.name,
                kind=cast(NodeDocKind, a.kind),
                operation=a.operation,
                action=cast(DocsAction, a.action),
                mermaid=a.mermaid,
            )
            for a in plan.logic
        ],
        specs=[
            DocsSpecItem(
                node_path=s.node_path,
                source=s.source,
                origin=cast("SpecOrigin | None", s.origin),
                action=cast(DocsAction, s.action),
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
    _: User = Depends(require_architect),
) -> DocsImportReport:
    """Dry-run: план без записи (build_docs_plan БД только читает)."""
    return _report(_plan_from_files(db, project, payload))


@router.post("/apply", response_model=DocsImportReport)
def docs_import_apply(
    payload: DocsImportIn,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> DocsImportReport:
    """Применение: план пересчитывается на живом состоянии (между превью и
    применением мир мог измениться); при errors не пишется ничего."""
    plan = _plan_from_files(db, project, payload)
    report = _report(plan)
    if plan.errors:
        return report  # applied=False — фронт показывает ошибки
    created, updated, specs, filled = apply_docs_plan(db, plan)
    if created or updated or specs or filled:
        bump_meta_rev(db, project)  # доки/спеки — мета узла: поллинг страницы увидит
    touch_project(db, project, user.id)
    db.commit()
    report.applied = True
    report.created_docs = created
    report.filled_docs = filled
    report.updated_docs = updated
    report.specs_written = specs
    return report
