"""Разведка точек входа сервиса: промпт → превью → применение (docs/plan-recon.md).

Нулевой шаг документирования монолита: агент обходит репозиторий и возвращает не
документацию, а ПЕРЕЧЕНЬ операций и фоновых процессов. Перечень приезжает одним
файлом, и его строки становятся заглушками — схемами с пустым телом.

Путь тот же, что у дозаливки данных и каналов, но своя сущность и своя политика:
поля overwrite нет вовсе, применение только создаёт (Р13 плана). Роутер тонкий:
разбор и план живут в app/recon_import.py, промпт — в app/recon_prompt.py.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_project, require_project_editor, touch_project
from app.docs_import import _node_paths
from app.models.node import Node
from app.models.project import Project
from app.models.user import User
from app.recon_import import ReconPlan, apply_recon_plan, build_recon_plan
from app.recon_prompt import build_recon_prompt
from app.schemas.recon import ReconImportIn, ReconImportReport, ReconPromptOut
from app.skeptic_prompt import PromptVariant, prompt_for_variant
from app.view_state import bump_meta_rev

router = APIRouter(prefix="/recon", tags=["recon"])


@router.get("/prompt", response_model=ReconPromptOut)
def recon_prompt(
    node_id: uuid.UUID,
    variant: PromptVariant = "builder",
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_project_editor),
) -> ReconPromptOut:
    """Промпт агенту на разведку точек входа узла.

    node_id ОБЯЗАТЕЛЕН: перечень принадлежит объекту, разведка без адреса бессмысленна,
    а необязательный параметр дал бы лишнюю ветку и лишний класс ошибок. Узла нет в
    проекте — 404, как у промпта доков.

    ⚠ Ни среза схемы, ни ранее разведанного перечня промпт НЕ несёт (решение
    пользователя, §3 плана): разведка всегда идёт от кода, иначе второй заход
    унаследует пропуски первого. Единственная подстановка — адрес узла.

    variant — строительный промпт (дефолт), обёртка с аудитом или один аудит. У
    оркестраторной обёртки разведки петля своя (два независимых прогона в разные файлы
    и объединение), поэтому ей передаётся ГЕНЕРАТОР промпта по пути результата, а не
    готовый текст: пути прогонов знает обёртка.
    """
    nodes = db.query(Node).filter(Node.project_id == project.id).all()
    flat, fulls, _by_bare, _by_path = _node_paths(nodes)
    найден = next((fulls[i] for i, n in enumerate(flat) if n.id == node_id), None)
    if найден is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Узел не найден")
    node_path: str = найден
    return ReconPromptOut(
        prompt=prompt_for_variant(
            variant,
            "recon",
            build_recon_prompt(node_path),
            recon_builder=lambda путь: build_recon_prompt(node_path, result_path=путь),
        )
    )


def _plan(db: Session, project: Project, payload: ReconImportIn) -> ReconPlan:
    nodes = db.query(Node).filter(Node.project_id == project.id).all()
    return build_recon_plan(
        db, nodes, [(f.name, f.content) for f in payload.files], payload.node_id
    )


@router.post("/preview", response_model=ReconImportReport)
def recon_import_preview(
    payload: ReconImportIn,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_project_editor),
) -> ReconImportReport:
    """Dry-run: план без записи (build_recon_plan БД только читает).

    Он же дифф повторной разведки: строки «уже описана» и «исчезла из кода» видны
    здесь, до всякой записи.
    """
    return _plan(db, project, payload).report


@router.post("/apply", response_model=ReconImportReport)
def recon_import_apply(
    payload: ReconImportIn,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> ReconImportReport:
    """Применение: план пересчитывается на живом состоянии (между превью и применением
    мир мог измениться); при errors не пишется ничего."""
    plan = _plan(db, project, payload)
    if plan.report.errors:
        return plan.report  # applied=False — окно показывает ошибки
    apply_recon_plan(db, plan)
    if plan.report.created:
        bump_meta_rev(db, project)  # схемы логики — мета узла: поллинг страницы увидит
    touch_project(db, project, user.id)
    db.commit()
    return plan.report
