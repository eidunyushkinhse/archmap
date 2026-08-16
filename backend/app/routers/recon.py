"""Разведка точек входа сервиса: промпт агенту (Ф0 docs/plan-recon.md).

Нулевой шаг документирования монолита: агент обходит репозиторий и возвращает не
документацию, а перечень операций и фоновых процессов. Ручка пока одна — выдача
промпта; приём перечня (превью и применение) появится следующей фазой, задела под
неё здесь нет.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth import require_architect
from app.database import get_db
from app.deps import get_current_project
from app.docs_import import _node_paths
from app.models.node import Node
from app.models.project import Project
from app.models.user import User
from app.recon_prompt import build_recon_prompt
from app.schemas.recon import ReconPromptOut
from app.skeptic_prompt import PromptVariant, prompt_for_variant

router = APIRouter(prefix="/recon", tags=["recon"])


@router.get("/prompt", response_model=ReconPromptOut)
def recon_prompt(
    node_id: uuid.UUID,
    variant: PromptVariant = "builder",
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_architect),
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
