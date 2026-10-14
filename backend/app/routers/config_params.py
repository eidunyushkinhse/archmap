"""CRUD конфигурации сервиса — параметры и переменные окружения.

Устройство — зеркало db_docs.py и broker_channels.py (записи, CAS, бамп meta_rev),
но БЕЗ проверки формы узла на мутациях, и это осознанное расхождение с каналами:

  • у каналов форма энфорсится на входе, потому что «канал без брокера» бессмыслен и
    интерфейс их у не-брокера не покажет вовсе;
  • конфигурация же ведёт себя как СХЕМЫ ЛОГИКИ и спека — принадлежит сервису, а у
    неподходящей формы показывается legacy-механикой (с предупреждением и без кнопок
    добавления), то есть «применённое-но-невидимое» не возникает и запрещать нечего.
    Ровно поэтому node_docs.py форму тоже не проверяет.

Мутации — редактору проекта, чтение — всем с доступом. Каждая мутация бампает meta_rev:
конфигурация это МЕТА узла (видна на его странице, не на схеме), и поллинг страницы
обязан отличать её от изменений схемы (graph_rev).

Обращений к параметрам («какая развилка от него зависит») своих записей здесь нет:
их истина — пометки «зависит от:» в текстах схем логики, разбор и резолв на чтении
(docs/plan-config-docs.md §5). Обратный индекс их только РАЗВОРАЧИВАЕТ, ничего не
храня, — появится вместе с резолвом.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.data_refs import catalog_for_project, doc_ref_hits
from app.database import get_db
from app.deps import (
    check_cas,
    commit_change,
    get_current_project,
    name_taken,
    node_or_404,
    owned_or_404,
    require_project_editor,
)
from app.models.config_param import ConfigParam
from app.models.node import Node
from app.models.project import Project
from app.models.user import User
from app.schemas.config_param import (
    ConfigParamCreate,
    ConfigParamResponse,
    ConfigParamUpdate,
    ConfigParamUsage,
)
from app.view_state import bump_meta_rev

router = APIRouter(prefix="/nodes/{node_id}/config", tags=["config-docs"])


def _scoped_param(db: Session, node: Node, param_id: uuid.UUID) -> ConfigParam:
    return owned_or_404(db, ConfigParam, param_id, "node_id", node.id, "Параметр не найден")


def _name_taken(
    db: Session, node_id: uuid.UUID, name: str, except_id: uuid.UUID | None
) -> bool:
    return name_taken(
        db,
        ConfigParam.id,
        except_id,
        ConfigParam.node_id == node_id,
        ConfigParam.name == name,
    )


@router.get("", response_model=list[ConfigParamResponse])
def list_params(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> list[ConfigParam]:
    node = node_or_404(db, node_id, project)
    return list(node.config_params)


@router.get("/usage", response_model=list[ConfigParamUsage])
def list_usage(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> list[ConfigParamUsage]:
    """Какие схемы логики этого объекта зависят от его параметров.

    Разворот пометок «зависит от:» из текстов СВОИХ схем — чужие сюда попасть не
    могут по построению резолва. Источник — сам текст доков: разбор и резолв на
    чтении, хранения обращений нет.

    ОБЪЯВЛЕН ДО путей с {param_id}: иначе «usage» поехало бы в разбор uuid.
    """
    node = node_or_404(db, node_id, project)
    catalog = catalog_for_project(db, project.id)
    owner_params = catalog.params_by_node.get(node.id, {})
    if not owner_params:
        return []
    by_id = {pid: name for name, pid in owner_params.items()}

    rows: list[ConfigParamUsage] = []
    seen: set[tuple[uuid.UUID, uuid.UUID]] = set()
    # Только СВОИ схемы: «зависит от:» резолвится среди параметров владельца схемы.
    for hit in doc_ref_hits(db, project.id, catalog, node_id=node.id):
        ref = hit.ref
        # Индекс отвечает за ФАКТЫ: непонятая пометка живёт в алертах (AL33) и в
        # плашке редактора, а сюда не попадает. Пометки чужих семей отсеиваются
        # сами — param_id у них пуст.
        if ref.status != "ok" or ref.param_id is None:
            continue
        key = (hit.doc_id, ref.param_id)
        if key in seen:
            continue
        seen.add(key)
        rows.append(
            ConfigParamUsage(
                param_id=ref.param_id,
                param_name=by_id[ref.param_id],
                doc_id=hit.doc_id,
                doc_name=hit.doc_name,
            )
        )
    rows.sort(key=lambda u: (u.param_name, u.doc_name))
    return rows


@router.post("", response_model=ConfigParamResponse, status_code=status.HTTP_201_CREATED)
def create_param(
    node_id: uuid.UUID,
    payload: ConfigParamCreate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> ConfigParam:
    node = node_or_404(db, node_id, project)
    if _name_taken(db, node.id, payload.name, None):
        raise HTTPException(status_code=409, detail="Параметр с таким именем уже есть")
    param = ConfigParam(node_id=node.id, **payload.model_dump())
    db.add(param)
    commit_change(db, project, user.id, meta=True)
    db.refresh(param)
    return param


@router.patch("/{param_id}", response_model=ConfigParamResponse)
def update_param(
    node_id: uuid.UUID,
    param_id: uuid.UUID,
    payload: ConfigParamUpdate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> ConfigParam:
    node = node_or_404(db, node_id, project)
    param = _scoped_param(db, node, param_id)
    data = payload.model_dump(exclude_unset=True)
    base_version = data.pop("base_version", None)
    check_cas(param.version, base_version, "Параметр изменён в другой сессии")
    if data:
        new_name = data.get("name", param.name)
        if _name_taken(db, node.id, new_name, param.id):
            raise HTTPException(status_code=409, detail="Параметр с таким именем уже есть")
        for field, value in data.items():
            setattr(param, field, value)
        param.version += 1
        bump_meta_rev(db, project)
    commit_change(db, project, user.id)
    db.refresh(param)
    return param


@router.delete("/{param_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_param(
    node_id: uuid.UUID,
    param_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> None:
    node = node_or_404(db, node_id, project)
    param = _scoped_param(db, node, param_id)
    db.delete(param)
    commit_change(db, project, user.id, meta=True)
