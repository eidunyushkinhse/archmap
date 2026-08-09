"""Хелперы версий конкурентности (этап 0, docs/archive/plan-concurrency.md).

Версия ВИДА (view_state) — fence+мьютекс записей раскладки: берётся FOR UPDATE
до применения батча, инкрементируется каждой мутацией мира вида. Курсор ПРОЕКТА
(projects.graph_rev) — «что-то поменялось», двигается любой мутацией
узлов/рёбер/раскладки (поллинг этапа 1). Commit — на вызывающей стороне.
"""

import uuid

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.project import Project
from app.models.view_state import ViewState


def _view_query(db: Session, project_id: uuid.UUID, view_id: uuid.UUID | None):
    return db.query(ViewState).filter(
        ViewState.project_id == project_id,
        ViewState.view_id.is_(None) if view_id is None else ViewState.view_id == view_id,
    )


def current_version(db: Session, project_id: uuid.UUID, view_id: uuid.UUID | None) -> int:
    """Текущая версия вида; отсутствие строки = 0 (вид ещё никто не менял)."""
    row = _view_query(db, project_id, view_id).first()
    return row.version if row is not None else 0


def lock_view_state(
    db: Session, project_id: uuid.UUID, view_id: uuid.UUID | None
) -> ViewState:
    """Строка версии вида под FOR UPDATE (get-or-create).

    Замок строки — мьютекс писателей вида: конкурентные батчи сериализуются, и
    гонка INSERT одного ключа view_layout (уникальный констрейнт → 500) исчезает.
    На SQLite тестов FOR UPDATE — no-op (однопоточные тесты, это ок). Гонку
    СОЗДАНИЯ самой строки версии закрывает savepoint: проигравший перечитывает
    строку победителя. Держится до commit/rollback вызывающей стороны.
    """
    row = _view_query(db, project_id, view_id).with_for_update().first()
    if row is not None:
        return row
    try:
        with db.begin_nested():
            row = ViewState(project_id=project_id, view_id=view_id, version=0)
            db.add(row)
            db.flush()
        return row
    except IntegrityError:
        row = _view_query(db, project_id, view_id).with_for_update().first()
        if row is None:  # конкурент вставил и тут же откатился — крайне маловероятно
            raise
        return row


def bump_view_version(
    db: Session, project_id: uuid.UUID, view_id: uuid.UUID | None
) -> int:
    """Инкремент версии вида (мутация мира вида вне батча раскладки:
    create/delete/перенос узла, relayout). Возвращает новую версию."""
    row = lock_view_state(db, project_id, view_id)
    row.version += 1
    return row.version


def bump_graph_rev(db: Session, project: Project) -> None:
    """Инкремент курсора изменений проекта — атомарным UPDATE (read-modify-write
    через ORM терял бы конкурентные инкременты). Свежее значение подгрузится при
    следующем обращении к project.graph_rev (expire)."""
    db.query(Project).filter(Project.id == project.id).update(
        {Project.graph_rev: Project.graph_rev + 1}, synchronize_session=False
    )
    db.expire(project, ["graph_rev"])


def bump_meta_rev(db: Session, project: Project) -> None:
    """Инкремент курсора изменений МЕТЫ (атрибуты узла, доки, openapi) — тем же
    атомарным UPDATE. Поллинг страницы объекта отличает мету от схемы: мета
    двигает meta_rev, схема (узлы/рёбра/раскладка) — graph_rev."""
    db.query(Project).filter(Project.id == project.id).update(
        {Project.meta_rev: Project.meta_rev + 1}, synchronize_session=False
    )
    db.expire(project, ["meta_rev"])
