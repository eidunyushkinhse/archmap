"""Версии документации объекта — HTTP (docs/tasks/doc-versions.md §6).

Две группы ручек на одном коде: /nodes/{node_id}/versions… — версии объекта (с его
поддеревом), /versions… — версии всего проекта (страница проекта — корень дерева, у
него node_id версии — NULL). Чем различаются группы — одной зависимостью «объект
среза»; всё остальное общее (_register).

Права: чтение — всем с доступом к проекту (и читателю: ему история нужна не меньше),
фиксация — редактору, удаление версии — только владельцу проекта. Домен —
app/versions.py; здесь коды ответа, перевод доменных отказов и коммит.
"""

import re
import uuid
from collections.abc import Callable, Iterable

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app import versions
from app.auth import get_current_user
from app.database import get_db
from app.deps import (
    get_current_project,
    node_or_404,
    require_project_editor,
    require_project_owner,
)
from app.models.node import Node
from app.models.node_version import NodeVersion
from app.models.project import Project
from app.models.user import User
from app.schemas.versions import (
    VersionCreate,
    VersionDiff,
    VersionItemDetail,
    VersionList,
    VersionOut,
    VersionRef,
    VersionSnapshot,
    VersionStats,
    VersionText,
)
from app.versions_diff import diff_items

VERSION_NOT_FOUND = "Версия не найдена"
ITEM_NOT_FOUND = "Такого элемента в дельте нет"
BAD_BASE = "С чем сравнивать: prev, live или номер версии"
_NUMBER = re.compile(r"^\d{1,9}$")

# «Стало» — текущее состояние документации, а не версия.
_LIVE = VersionRef(number=None, comment=None, created_at=None)


def _node_scope(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
) -> Node | None:
    """Объект среза — узел проекта из пути (чужой или несуществующий — 404)."""
    return node_or_404(db, node_id, project)


def _project_scope() -> Node | None:
    """Объект среза — весь проект: версии корня, node_id версии — NULL."""
    return None


def _authors(db: Session, rows: Iterable[NodeVersion]) -> dict[uuid.UUID, str]:
    """Имена авторов версий одним запросом."""
    ids = {r.created_by_id for r in rows if r.created_by_id is not None}
    if not ids:
        return {}
    return {u.id: u.username for u in db.query(User).filter(User.id.in_(ids))}


def _out(row: NodeVersion, authors: dict[uuid.UUID, str]) -> VersionOut:
    author = None if row.created_by_id is None else authors.get(row.created_by_id)
    return VersionOut(
        number=row.number,
        comment=row.comment,
        kind=row.kind,
        restored_from=row.restored_from,
        created_at=row.created_at,
        author=author,
        stats=VersionStats.model_validate(row.stats),
    )


def _ref(row: NodeVersion | None) -> VersionRef | None:
    if row is None:
        return None
    return VersionRef(number=row.number, comment=row.comment, created_at=row.created_at)


def _version_or_404(
    db: Session, project: Project, node: Node | None, number: int
) -> NodeVersion:
    row = versions.get_version(db, project, node, number)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=VERSION_NOT_FOUND)
    return row


def _parse_base(base: str) -> versions.CompareBase:
    if base in ("prev", "live"):
        return "prev" if base == "prev" else "live"
    if _NUMBER.match(base):
        return int(base)
    raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=BAD_BASE)


def _comparison(
    db: Session, project: Project, node: Node | None, number: int, base: str
) -> versions.Comparison:
    """Стороны дельты версии number по base; 404 — нет версии number или base."""
    choice = _parse_base(base)
    row = _version_or_404(db, project, node, number)
    found = versions.comparison(db, project, node, row, choice)
    if found is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=VERSION_NOT_FOUND)
    return found


def _snapshot(db: Session, project: Project, node: Node | None, number: int) -> VersionSnapshot:
    """Снимок версии number объекта; версии нет — 404."""
    return versions.snapshot_of(_version_or_404(db, project, node, number))


def _text_or_404(text: VersionText | None, detail: str) -> VersionText:
    if text is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)
    return text


_BASE_DOC = (
    "С чем сравнивать: prev (умолчание) — от предыдущей версии к n, у первой — от "
    "пустого; live — от версии n («было») к текущему состоянию («стало», number = "
    "null): что изменилось с версии n; число m — от версии m к n."
)


def _register(router: APIRouter, scope: Callable[..., Node | None]) -> None:
    """Ручки версий на router; scope — зависимость «объект среза» (узел или проект)."""

    @router.get("", response_model=VersionList)
    def list_versions(
        node: Node | None = Depends(scope),
        db: Session = Depends(get_db),
        project: Project = Depends(get_current_project),
        _: User = Depends(get_current_user),
    ) -> VersionList:
        """Версии объекта (новые сверху) и pending — есть ли изменения с последней
        версии и какие (сравнение хэшей; версий нет — changed true, перечень пуст)."""
        rows = versions.list_versions(db, project, node)
        authors = _authors(db, rows)
        return VersionList(
            versions=[_out(r, authors) for r in rows],
            pending=versions.pending(db, project, node),
        )

    @router.post("", response_model=VersionOut, status_code=status.HTTP_201_CREATED)
    def create_version(
        payload: VersionCreate,
        node: Node | None = Depends(scope),
        db: Session = Depends(get_db),
        project: Project = Depends(get_current_project),
        user: User = Depends(require_project_editor),
    ) -> VersionOut:
        """Зафиксировать текущую документацию объекта версией с комментарием."""
        try:
            row = versions.create_version(db, project, user, node, payload.comment)
        except versions.VersionError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=exc.detail
            ) from None
        db.commit()
        db.refresh(row)
        return _out(row, {user.id: user.username})

    @router.delete("/{number}", status_code=status.HTTP_204_NO_CONTENT)
    def delete_version(
        number: int,
        node: Node | None = Depends(scope),
        db: Session = Depends(get_db),
        project: Project = Depends(get_current_project),
        _: User = Depends(require_project_owner),
    ) -> None:
        """Удалить версию (только владелец). Номера остальных не пересчитываются."""
        versions.delete_version(db, _version_or_404(db, project, node, number))
        db.commit()

    @router.get("/{number}/diff", response_model=VersionDiff)
    def version_diff(
        number: int,
        base: str = Query("prev", description=_BASE_DOC),
        node: Node | None = Depends(scope),
        db: Session = Depends(get_db),
        project: Project = Depends(get_current_project),
        _: User = Depends(get_current_user),
    ) -> VersionDiff:
        """Элементы дельты версии number. base: prev (умолчание) — от предыдущей
        версии к n, у первой — от пустого (base в ответе — null); live — от версии n
        к текущему состоянию (target.number — null): «что изменилось с версии n»;
        число m — от версии m к n. Нет версии — 404, base не из перечня — 422."""
        cmp = _comparison(db, project, node, number, base)
        return VersionDiff(
            base=_ref(cmp.base_version),
            target=_ref(cmp.target_version) or _LIVE,
            items=diff_items(cmp.base, cmp.target),
        )

    @router.get("/{number}/diff/{item_id}", response_model=VersionItemDetail)
    def version_item(
        number: int,
        item_id: str,
        base: str = Query("prev", description=_BASE_DOC),
        node: Node | None = Depends(scope),
        db: Session = Depends(get_db),
        project: Project = Depends(get_current_project),
        _: User = Depends(get_current_user),
    ) -> VersionItemDetail:
        """Один элемент дельты с тремя представлениями: изменения, было, стало. base —
        как у списка элементов; элемента в этой дельте нет — 404."""
        cmp = _comparison(db, project, node, number, base)
        detail = versions.item_detail(db, project, cmp.base, cmp.target, item_id)
        if detail is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=ITEM_NOT_FOUND)
        return detail

    @router.get("/{number}/doc/{doc_id}", response_model=VersionText)
    def version_doc(
        number: int,
        doc_id: uuid.UUID,
        node: Node | None = Depends(scope),
        db: Session = Depends(get_db),
        project: Project = Depends(get_current_project),
        _: User = Depends(get_current_user),
    ) -> VersionText:
        """Текст схемы логики на версии; в срезе версии её нет — 404."""
        snap = _snapshot(db, project, node, number)
        return _text_or_404(versions.doc_text(snap, doc_id), "Схемы логики в этой версии нет")

    @router.get("/{number}/spec/{spec_node_id}", response_model=VersionText)
    def version_spec(
        number: int,
        spec_node_id: uuid.UUID,
        node: Node | None = Depends(scope),
        db: Session = Depends(get_db),
        project: Project = Depends(get_current_project),
        _: User = Depends(get_current_user),
    ) -> VersionText:
        """Спека OpenAPI объекта spec_node_id на версии; нет объекта или спеки — 404."""
        snap = _snapshot(db, project, node, number)
        return _text_or_404(versions.spec_text(snap, spec_node_id), "Спеки в этой версии нет")

    @router.get("/{number}/process/{process_id}", response_model=VersionText)
    def version_process(
        number: int,
        process_id: uuid.UUID,
        node: Node | None = Depends(scope),
        db: Session = Depends(get_db),
        project: Project = Depends(get_current_project),
        _: User = Depends(get_current_user),
    ) -> VersionText:
        """Процесс на версии в mermaid; в срезе версии его нет — 404."""
        snap = _snapshot(db, project, node, number)
        return _text_or_404(
            versions.process_text(snap, process_id), "Процесса в этой версии нет"
        )


node_router = APIRouter(prefix="/nodes/{node_id}/versions", tags=["versions"])
project_router = APIRouter(prefix="/versions", tags=["versions"])
_register(node_router, _node_scope)
_register(project_router, _project_scope)
