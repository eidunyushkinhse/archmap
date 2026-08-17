"""CRUD конфигурации сервиса — параметры и переменные окружения.

Устройство — зеркало db_docs.py и broker_channels.py (записи, CAS, бамп meta_rev),
но БЕЗ проверки формы узла на мутациях, и это осознанное расхождение с каналами:

  • у каналов форма энфорсится на входе, потому что «канал без брокера» бессмыслен и
    интерфейс их у не-брокера не покажет вовсе;
  • конфигурация же ведёт себя как СХЕМЫ ЛОГИКИ и спека — принадлежит сервису, а у
    неподходящей формы показывается legacy-механикой (с предупреждением и без кнопок
    добавления), то есть «применённое-но-невидимое» не возникает и запрещать нечего.
    Ровно поэтому node_docs.py форму тоже не проверяет.

Мутации — только архитектору, чтение — обеим ролям. Каждая мутация бампает meta_rev:
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

from app.auth import get_current_user, require_architect
from app.database import get_db
from app.deps import get_current_project, scoped_node, touch_project
from app.models.config_param import ConfigParam
from app.models.node import Node
from app.models.project import Project
from app.models.user import User
from app.schemas.config_param import (
    ConfigParamCreate,
    ConfigParamResponse,
    ConfigParamUpdate,
)
from app.view_state import bump_meta_rev

router = APIRouter(prefix="/nodes/{node_id}/config", tags=["config-docs"])


def _get_node(db: Session, node_id: uuid.UUID, project: Project) -> Node:
    node = scoped_node(db, node_id, project)
    if not node:
        raise HTTPException(status_code=404, detail="Узел не найден")
    return node


def _scoped_param(db: Session, node: Node, param_id: uuid.UUID) -> ConfigParam:
    param = db.get(ConfigParam, param_id)
    if param is None or param.node_id != node.id:
        raise HTTPException(status_code=404, detail="Параметр не найден")
    return param


def _name_taken(
    db: Session, node_id: uuid.UUID, name: str, except_id: uuid.UUID | None
) -> bool:
    """Пре-чек уникальности имени у узла — 409 вместо IntegrityError-500."""
    q = db.query(ConfigParam.id).filter(
        ConfigParam.node_id == node_id, ConfigParam.name == name
    )
    if except_id is not None:
        q = q.filter(ConfigParam.id != except_id)
    return db.query(q.exists()).scalar() or False


@router.get("", response_model=list[ConfigParamResponse])
def list_params(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> list[ConfigParam]:
    node = _get_node(db, node_id, project)
    return list(node.config_params)


@router.post("", response_model=ConfigParamResponse, status_code=status.HTTP_201_CREATED)
def create_param(
    node_id: uuid.UUID,
    payload: ConfigParamCreate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> ConfigParam:
    node = _get_node(db, node_id, project)
    if _name_taken(db, node.id, payload.name, None):
        raise HTTPException(status_code=409, detail="Параметр с таким именем уже есть")
    param = ConfigParam(node_id=node.id, **payload.model_dump())
    db.add(param)
    bump_meta_rev(db, project)
    touch_project(db, project, user.id)
    db.commit()
    db.refresh(param)
    return param


@router.patch("/{param_id}", response_model=ConfigParamResponse)
def update_param(
    node_id: uuid.UUID,
    param_id: uuid.UUID,
    payload: ConfigParamUpdate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> ConfigParam:
    node = _get_node(db, node_id, project)
    param = _scoped_param(db, node, param_id)
    data = payload.model_dump(exclude_unset=True)
    base_version = data.pop("base_version", None)
    if base_version is not None and base_version != param.version:
        raise HTTPException(status_code=409, detail="Параметр изменён в другой сессии")
    if data:
        new_name = data.get("name", param.name)
        if _name_taken(db, node.id, new_name, param.id):
            raise HTTPException(status_code=409, detail="Параметр с таким именем уже есть")
        for field, value in data.items():
            setattr(param, field, value)
        param.version += 1
        bump_meta_rev(db, project)
    touch_project(db, project, user.id)
    db.commit()
    db.refresh(param)
    return param


@router.delete("/{param_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_param(
    node_id: uuid.UUID,
    param_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> None:
    node = _get_node(db, node_id, project)
    param = _scoped_param(db, node, param_id)
    db.delete(param)
    bump_meta_rev(db, project)
    touch_project(db, project, user.id)
    db.commit()
