"""Перенос узла на другой уровень вложенности (смена parent_id).

До 2026-08-12 переносить узел было нечем: `parent_id` проставлялся только при
СОЗДАНИИ, и алерт «Пользователи внутри контейнера» указывал на проблему, которую
интерфейс не давал починить. Здесь — доменная часть жеста: что переносить можно, и
что делать с раскладкой переехавшего поддерева.

Два правила, ради которых модуль и появился:

1. ЗАПРЕТЫ. Контракт `NodeUpdate` принимал ЛЮБОЙ parent_id — включая собственного
   потомка, то есть поддерево можно было оторвать от корня и потерять из дерева
   насовсем. Проверки чистые (без HTTP), возвращают текст причины; статус ставит
   роутер.

2. РАСКЛАДКА. Позиция узла живёт не «в виде его родителя», а В КАЖДОМ ВИДЕ, ГДЕ ЕГО
   ВИДНО: ребёнок раскрытой рамки показан на уровне-предке и позицию получает именно
   там (см. posView в MapEditorPage). После переезда все такие позиции бессмысленны —
   снимаем их и отдаём вызывающему СНИМКОМ, чтобы Undo вернул не только родителя, но и
   геометрию. А вот виды ВНУТРИ переезжающего поддерева трогать нельзя: внутренняя
   раскладка от того, где висит корень поддерева, не зависит.
"""

import uuid

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app import tree
from app.models.node import Node
from app.models.project import Project
from app.models.view_layout import ViewLayoutItem
from app.schemas.restore import DeletionSnapshot, ViewLayoutItemSnapshot
from app.view_state import bump_view_version

# Формы, внутрь которых можно вкладывать объекты. Зеркало фронтового
# canHaveChildren: у БД, брокера и человека детей не бывает.
CONTAINER_SHAPES = {"service"}


def validate_reparent(
    db: Session, project: Project, node: Node, new_parent_id: uuid.UUID | None
) -> str | None:
    """Причина, по которой переносить нельзя, либо None. Чистая проверка, без HTTP."""
    # Человек по C4 живёт на контекстном уровне, ЗА границей системы — именно это
    # нарушение и ловит алерт AL25. Запрет односторонний: вынести человека НАРУЖУ
    # (parent_id = None) можно всегда, иначе алерт снова стал бы тупиком.
    if node.shape == "person" and new_parent_id is not None:
        return "Пользователь живёт вне границ системы — его нельзя вложить в объект"
    if new_parent_id is None:
        return None
    if new_parent_id == node.id:
        return "Объект нельзя вложить в самого себя"
    parent = (
        db.query(Node)
        .filter(Node.id == new_parent_id, Node.project_id == project.id)
        .first()
    )
    if parent is None:
        return "Новый родитель не найден в проекте"
    if parent.shape not in CONTAINER_SHAPES:
        return "Внутрь этого объекта нельзя вкладывать другие — детей не бывает"
    if new_parent_id in tree.collect_subtree_ids_db(db, node.id):
        return "Объект нельзя перенести внутрь собственного потомка"
    return None


def _outside_rows(db: Session, project_id: uuid.UUID, node: Node) -> list[ViewLayoutItem]:
    """Строки раскладки поддерева в видах ЗА ПРЕДЕЛАМИ этого поддерева.

    Ключ item_id — строка без FK (в нём живут и uuid узлов, и легаси-ключи пучков
    «b:<src>><tgt>»), поэтому ищем вхождением, как это делает чистка при удалении.
    Виды самого поддерева исключаются: они переезжают вместе с ним и остаются верны.
    """
    subtree = tree.collect_subtree_ids_db(db, node.id)
    like = or_(*[ViewLayoutItem.item_id.like(f"%{sid}%") for sid in subtree])
    rows = (
        db.query(ViewLayoutItem)
        .filter(ViewLayoutItem.project_id == project_id, like)
        .all()
    )
    return [r for r in rows if r.view_id is None or r.view_id not in subtree]


def build_move_snapshot(db: Session, project: Project, node: Node) -> DeletionSnapshot:
    """Снимок раскладки, которую снимет перенос. Клиент берёт его ПЕРЕД переносом и
    возвращает через POST /nodes/restore при Undo — тем же путём, что и удаление
    (узлы/связи в снимке пусты: перенос ничего не сносит, кроме позиций)."""
    return DeletionSnapshot(
        nodes=[],
        edges=[],
        layout_items=[
            ViewLayoutItemSnapshot.model_validate(r)
            for r in _outside_rows(db, project.id, node)
        ],
    )


def strip_layout(db: Session, project: Project, node: Node, old_parent: uuid.UUID | None) -> None:
    """Снять позиции переехавшего поддерева во внешних видах и сдвинуть версии
    затронутых видов (fence конкурентных сессий: членство видов изменилось)."""
    rows = _outside_rows(db, project.id, node)
    touched: set[uuid.UUID | None] = {r.view_id for r in rows}
    for r in rows:
        db.delete(r)
    # Виды обоих родителей — даже если позиций в них не было (узел мог ни разу не
    # показываться): их СОСТАВ изменился, и соседняя сессия обязана перечитать уровень.
    touched.add(old_parent)
    touched.add(node.parent_id)
    for vid in touched:
        bump_view_version(db, project.id, vid)
