"""Хелперы версий конкурентности (этап 0, docs/archive/plan-concurrency.md).

Версия ВИДА (view_state) — fence+мьютекс записей раскладки: берётся FOR UPDATE
до применения батча, инкрементируется каждой мутацией мира вида. Курсор ПРОЕКТА
(projects.graph_rev) — «что-то поменялось», двигается любой мутацией
узлов/рёбер/раскладки (поллинг этапа 1). Commit — на вызывающей стороне.
"""

import uuid

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Query, Session

from app.models.project import Project
from app.models.view_layout import ViewLayoutItem
from app.models.view_state import ViewState


def _view_query(db: Session, project_id: uuid.UUID, view_id: uuid.UUID | None) -> Query[ViewState]:
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


def bump_process_rev(db: Session, project: Project) -> None:
    """Инкремент курсора изменений ПРОЦЕССОВ (Д9) — тем же атомарным UPDATE.
    Свой курсор: meta_rev дал бы ложный тост странице объекта, graph_rev — ложный
    рефетч уровня канвасу. Поллит страница процесса."""
    db.query(Project).filter(Project.id == project.id).update(
        {Project.process_rev: Project.process_rev + 1}, synchronize_session=False
    )
    db.expire(project, ["process_rev"])


def reset_view_layout(db: Session, project: Project, container_id: uuid.UUID | None) -> None:
    """Сбрасывает ручной layout вида в авто (own-on-first-render, Ф2):
    удаляем строки view_layout этого вида — позиции локалов/гостей/контейнеров
    и геометрию пучков разом (R3: единое хранилище). Строки с флагом expanded
    СОХРАНЯЕМ без координат: раскрытия переживают сброс (решение 2026-08-05 —
    «Переразложить» расставляет видимые узлы на авто-позиции, но контейнеры не
    сворачивает; до фикса раскрытия держались лишь эфемерно в сессии и терялись
    при перезагрузке). После сброса уровень выглядит как при первом открытии
    (ELK + кольца + авто-маршруты + пере-засев владения) с сохранёнными
    раскрытиями. Скоуп строго по виду: соседние уровни и другие виды нетронуты.
    Коммит — на вызывающей стороне."""
    view_filter = (
        ViewLayoutItem.view_id.is_(None)
        if container_id is None
        else ViewLayoutItem.view_id == container_id
    )
    for it in (
        db.query(ViewLayoutItem)
        .filter(ViewLayoutItem.project_id == project.id, view_filter)
        .all()
    ):
        if isinstance(it.payload, dict) and it.payload.get("expanded") is True:
            it.payload = {"expanded": True}
        else:
            db.delete(it)
    # relayout меняет мир вида: fence должен отсечь отставшие батчи (например,
    # дроп драга из сессии, не видевшей перераскладку), поллинг — увидеть сброс
    bump_view_version(db, project.id, container_id)
    bump_graph_rev(db, project)
