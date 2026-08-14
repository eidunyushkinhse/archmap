"""CRUD структуры брокера — каналы и поля сообщений.

Зеркало db_docs.py по устройству (структура записями, CAS, meta_rev), но с ДРУГИМ
правилом владения: каналы бывают только у shape="broker". У базы форму не проверяли
осознанно (интерфейс ведёт к структуре от БД, а агент мог прислать таблицы узлу с
чужой формой), здесь же наоборот — «канал» без брокера бессмысленен, и правило формы
энфорсится на ВХОДЕ, а не разбирается потом расхождением (урок находки Х1 №4).

Мутации — только архитектору, чтение — обеим ролям: как у node_docs. Каждая мутация
бампает meta_rev — структура это МЕТА узла (видна на его странице, не на схеме), и
поллинг страницы обязан отличать её от изменений схемы (graph_rev).

Обращений к каналам («кто публикует / кто потребляет») здесь нет и не будет: их
истина — пометки «публикует:/потребляет:» в тексте схем логики вызывающих, разбор и
резолв на чтении (пивот §1 docs/plan-broker-docs.md), обратный индекс — фаза Ф2.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth import get_current_user, require_architect
from app.database import get_db
from app.deps import get_current_project, scoped_node, touch_project
from app.models.broker_channel import BrokerChannel
from app.models.channel_field import ChannelField
from app.models.node import Node
from app.models.project import Project
from app.models.user import User
from app.schemas.broker_channel import (
    BrokerChannelCreate,
    BrokerChannelResponse,
    BrokerChannelUpdate,
    ChannelFieldCreate,
    ChannelFieldResponse,
    ChannelFieldUpdate,
)
from app.view_state import bump_meta_rev

router = APIRouter(prefix="/nodes/{node_id}/channels", tags=["broker-docs"])


def _get_node(db: Session, node_id: uuid.UUID, project: Project) -> Node:
    node = scoped_node(db, node_id, project)
    if not node:
        raise HTTPException(status_code=404, detail="Узел не найден")
    return node


def _broker_node(db: Session, node_id: uuid.UUID, project: Project) -> Node:
    """Узел-владелец каналов. Форма проверяется на КАЖДОЙ мутации, включая создание:
    иначе «каналы у сервиса» пришлось бы ловить постфактум, а страница их не покажет.
    Контейнер отсекается этой же проверкой — детей имеет только сервис (node.md N4)."""
    node = _get_node(db, node_id, project)
    if node.shape != "broker":
        raise HTTPException(
            status_code=400, detail="Каналы может иметь только узел-брокер"
        )
    return node


def _scoped_channel(db: Session, node: Node, channel_id: uuid.UUID) -> BrokerChannel:
    channel = db.get(BrokerChannel, channel_id)
    if channel is None or channel.node_id != node.id:
        raise HTTPException(status_code=404, detail="Канал не найден")
    return channel


def _scoped_field(db: Session, channel: BrokerChannel, field_id: uuid.UUID) -> ChannelField:
    field = db.get(ChannelField, field_id)
    if field is None or field.channel_id != channel.id:
        raise HTTPException(status_code=404, detail="Поле не найдено")
    return field


def _channel_taken(
    db: Session, node_id: uuid.UUID, group_name: str, name: str, except_id: uuid.UUID | None
) -> bool:
    """Пре-чек уникальности имени в группе — 409 вместо IntegrityError-500."""
    q = db.query(BrokerChannel.id).filter(
        BrokerChannel.node_id == node_id,
        BrokerChannel.group_name == group_name,
        BrokerChannel.name == name,
    )
    if except_id is not None:
        q = q.filter(BrokerChannel.id != except_id)
    return db.query(q.exists()).scalar() or False


def _field_taken(
    db: Session, channel_id: uuid.UUID, name: str, except_id: uuid.UUID | None
) -> bool:
    q = db.query(ChannelField.id).filter(
        ChannelField.channel_id == channel_id, ChannelField.name == name
    )
    if except_id is not None:
        q = q.filter(ChannelField.id != except_id)
    return db.query(q.exists()).scalar() or False


# ── Каналы ────────────────────────────────────────────────────────────────────


@router.get("", response_model=list[BrokerChannelResponse])
def list_channels(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> list[BrokerChannel]:
    # Чтение форму НЕ проверяет: если каналы у узла уже есть (например, форму сменили
    # в обход), спрятать их хуже, чем показать — «применённое-но-невидимое» и так
    # запрещено при смене типа (node.md N4а).
    node = _get_node(db, node_id, project)
    return list(node.broker_channels)


@router.post("", response_model=BrokerChannelResponse, status_code=status.HTTP_201_CREATED)
def create_channel(
    node_id: uuid.UUID,
    payload: BrokerChannelCreate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> BrokerChannel:
    node = _broker_node(db, node_id, project)
    if _channel_taken(db, node.id, payload.group_name, payload.name, None):
        raise HTTPException(status_code=409, detail="Канал с таким именем уже есть")
    channel = BrokerChannel(node_id=node.id, **payload.model_dump())
    db.add(channel)
    bump_meta_rev(db, project)
    touch_project(db, project, user.id)
    db.commit()
    db.refresh(channel)
    return channel


@router.patch("/{channel_id}", response_model=BrokerChannelResponse)
def update_channel(
    node_id: uuid.UUID,
    channel_id: uuid.UUID,
    payload: BrokerChannelUpdate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> BrokerChannel:
    node = _broker_node(db, node_id, project)
    channel = _scoped_channel(db, node, channel_id)
    data = payload.model_dump(exclude_unset=True)
    base_version = data.pop("base_version", None)
    if base_version is not None and base_version != channel.version:
        raise HTTPException(status_code=409, detail="Канал изменён в другой сессии")
    if data:
        new_name = data.get("name", channel.name)
        new_group = data.get("group_name", channel.group_name)
        if _channel_taken(db, node.id, new_group, new_name, channel.id):
            raise HTTPException(status_code=409, detail="Канал с таким именем уже есть")
        for field, value in data.items():
            setattr(channel, field, value)
        channel.version += 1
        bump_meta_rev(db, project)
    touch_project(db, project, user.id)
    db.commit()
    db.refresh(channel)
    return channel


@router.delete("/{channel_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_channel(
    node_id: uuid.UUID,
    channel_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> None:
    node = _broker_node(db, node_id, project)
    channel = _scoped_channel(db, node, channel_id)
    db.delete(channel)
    bump_meta_rev(db, project)
    touch_project(db, project, user.id)
    db.commit()


# ── Поля сообщений ────────────────────────────────────────────────────────────


@router.post(
    "/{channel_id}/fields",
    response_model=ChannelFieldResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_field(
    node_id: uuid.UUID,
    channel_id: uuid.UUID,
    payload: ChannelFieldCreate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> ChannelField:
    node = _broker_node(db, node_id, project)
    channel = _scoped_channel(db, node, channel_id)
    if _field_taken(db, channel.id, payload.name, None):
        raise HTTPException(status_code=409, detail="Поле с таким именем уже есть в канале")
    field = ChannelField(channel_id=channel.id, **payload.model_dump())
    db.add(field)
    bump_meta_rev(db, project)
    touch_project(db, project, user.id)
    db.commit()
    db.refresh(field)
    return field


@router.patch("/{channel_id}/fields/{field_id}", response_model=ChannelFieldResponse)
def update_field(
    node_id: uuid.UUID,
    channel_id: uuid.UUID,
    field_id: uuid.UUID,
    payload: ChannelFieldUpdate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> ChannelField:
    node = _broker_node(db, node_id, project)
    channel = _scoped_channel(db, node, channel_id)
    field = _scoped_field(db, channel, field_id)
    data = payload.model_dump(exclude_unset=True)
    if data:
        new_name = data.get("name")
        if new_name is not None and _field_taken(db, channel.id, new_name, field.id):
            raise HTTPException(
                status_code=409, detail="Поле с таким именем уже есть в канале"
            )
        for attr, value in data.items():
            setattr(field, attr, value)
        bump_meta_rev(db, project)
    touch_project(db, project, user.id)
    db.commit()
    db.refresh(field)
    return field


@router.delete(
    "/{channel_id}/fields/{field_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_field(
    node_id: uuid.UUID,
    channel_id: uuid.UUID,
    field_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> None:
    node = _broker_node(db, node_id, project)
    channel = _scoped_channel(db, node, channel_id)
    field = _scoped_field(db, channel, field_id)
    db.delete(field)
    bump_meta_rev(db, project)
    touch_project(db, project, user.id)
    db.commit()
