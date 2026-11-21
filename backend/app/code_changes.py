"""Код ушёл вперёд документации: сигнал CI о слиянии в основную ветку репозитория
(замечание владельца 2026-11-21, пункт 3).

Не во всяком контуре есть LLM, поэтому CI ничего не собирает и не пишет: после слияния в
main он сообщает ArchMap адрес репозитория (POST /api/v1/code-changes, токен «только
сигнал CI»). ArchMap находит проекты, у объектов которых источник в этом репозитории
(nodes.source_ref «git:repo#path», app/identity), среди тех, что видит владелец токена, и
копит в них напоминание: человек увидит его при входе в проект и в рекомендациях, а
документацию обновит сам или с агентом (золотое правило владельца 2026-11-21).

Напоминание снимает обновление из кода, в прогоне которого есть объекты этого
репозитория (clear_for_sources), или кнопка «Документация актуальна» (dismiss).

Репозиторий сравнивается без порта: CI шлёт https-адрес, а у агента remote бывает
ssh://git@host:2222/org/repo, и normalize_repo оставляет порт в адресе.
"""

import re
import uuid
from collections.abc import Iterable, Sequence
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.access import visible_projects
from app.identity import normalize_repo
from app.models.code_change import CodeChange
from app.models.node import Node
from app.models.project import Project
from app.models.user import User
from app.schemas.alerts import CodeChangeAlert, CodeChangeNode
from app.schemas.code_changes import CodeChangeIn, CodeChangeOut, CodeChangeProject

EMPTY_REPO = "Не назван репозиторий: поле repo пустое"
NOT_FOUND = "Напоминания об изменениях в коде в этом проекте нет"

# Порт после хоста в нормализованном адресе: «host:2222/org/repo» → «host/org/repo».
_PORT = re.compile(r"^([^/:]+):\d+(?=/)")


class CodeChangeError(ValueError):
    """Отказ сигналу; текст — для журнала CI как есть."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


def repo_key(raw: str | None) -> str | None:
    """Адрес репозитория в любом виде git → ключ сравнения: normalize_repo без порта.
    Учётные данные в адресе (CI_REPOSITORY_URL у GitLab) normalize_repo отбрасывает."""
    repo = normalize_repo(raw)
    return _PORT.sub(r"\1", repo, count=1) if repo else None


def repo_of_source(ref: str | None) -> str | None:
    """Ключ репозитория у источника объекта «git:repo#path»; у имени зависимости None."""
    if not ref or not ref.startswith("git:"):
        return None
    return repo_key(ref[4:].partition("#")[0])


def _linked(db: Session, project_ids: Sequence[uuid.UUID], repo: str) -> dict[uuid.UUID, int]:
    """Сколько объектов с источником в репозитории у каждого из проектов. Префикс хоста
    сужает выборку в БД, точное сравнение — по ключу (порт в источнике допустим)."""
    if not project_ids:
        return {}
    host = repo.split("/", 1)[0]
    rows = (
        db.query(Node.project_id, Node.source_ref)
        .filter(
            Node.project_id.in_(project_ids),
            Node.source_ref.startswith(f"git:{host}", autoescape=True),
        )
        .all()
    )
    out: dict[uuid.UUID, int] = {}
    for project_id, ref in rows:
        if repo_of_source(ref) == repo:
            out[project_id] = out.get(project_id, 0) + 1
    return out


def record_merge(db: Session, user: User, payload: CodeChangeIn) -> CodeChangeOut:
    """Слияние в репозитории: напоминание каждому проекту с объектами из него среди тех,
    что видит владелец токена (архивные пропускаются). Ответ называет проекты: его
    видно в журнале CI. Без коммита."""
    repo = repo_key(payload.repo)
    if repo is None:
        raise CodeChangeError(EMPTY_REPO)
    projects = (
        visible_projects(db.query(Project), user)
        .filter(Project.archived_at.is_(None))
        .order_by(Project.name)
        .all()
    )
    linked = _linked(db, [p.id for p in projects], repo)
    now = datetime.now(UTC)
    commit = payload.commit.lower() if payload.commit else None
    branch = payload.branch or None
    out: list[CodeChangeProject] = []
    for p in projects:
        objects = linked.get(p.id, 0)
        if not objects:
            continue
        row = db.query(CodeChange).filter_by(project_id=p.id, repo=repo).first()
        if row is None:
            db.add(CodeChange(
                project_id=p.id, repo=repo, merges=1, first_at=now, last_at=now,
                first_commit=commit, last_commit=commit, branch=branch,
            ))
        else:
            row.merges += 1
            row.last_at = now
            row.last_commit = commit
            row.branch = branch
        out.append(CodeChangeProject(id=p.id, name=p.name, objects=objects))
    db.flush()
    return CodeChangeOut(repo=repo, projects=out)


def alerts(db: Session, project_id: uuid.UUID, nodes: Sequence[Node]) -> list[CodeChangeAlert]:
    """Напоминания проекта с объектами, чей источник в репозитории (AL37). Объекты
    считаются по живым источникам: напоминание, у которого объектов не осталось (их
    удалили или сменили источник), не показывается."""
    rows = (
        db.query(CodeChange)
        .filter(CodeChange.project_id == project_id)
        .order_by(CodeChange.first_at, CodeChange.repo)
        .all()
    )
    if not rows:
        return []
    parent_of = {n.id: n.parent_id for n in nodes}

    def depth(node: Node) -> int:
        # Счётчик шагов: данные импорта и снимков бывают циклическими.
        d, parent = 0, node.parent_id
        while parent is not None and d <= len(parent_of):
            d, parent = d + 1, parent_of.get(parent)
        return d

    by_repo: dict[str, list[Node]] = {}
    for n in nodes:
        repo = repo_of_source(n.source_ref)
        if repo is not None:
            by_repo.setdefault(repo, []).append(n)
    out: list[CodeChangeAlert] = []
    for row in rows:
        linked = sorted(by_repo.get(row.repo, []), key=lambda n: (depth(n), n.name.casefold()))
        if not linked:
            continue
        out.append(CodeChangeAlert(
            id=row.id, repo=row.repo, merges=row.merges, first_at=row.first_at,
            last_at=row.last_at, first_commit=row.first_commit, last_commit=row.last_commit,
            branch=row.branch,
            nodes=[CodeChangeNode(node_id=n.id, node_name=n.name) for n in linked],
        ))
    return out


def clear_for_sources(db: Session, project_id: uuid.UUID, keys: Iterable[str]) -> list[str]:
    """Обновление из кода применено: снять напоминания репозиториев, объекты которых
    есть в прогоне. Ответ — снятые репозитории по алфавиту. Без коммита."""
    repos = {r for k in keys if (r := repo_of_source(k))}
    if not repos:
        return []
    rows = (
        db.query(CodeChange)
        .filter(CodeChange.project_id == project_id, CodeChange.repo.in_(repos))
        .all()
    )
    for row in rows:
        db.delete(row)
    return sorted(row.repo for row in rows)


def dismiss(db: Session, project_id: uuid.UUID, change_id: uuid.UUID) -> None:
    """«Документация актуальна»: снять напоминание вручную. Чужой проект — та же ошибка,
    что у несуществующего. Без коммита."""
    row = db.get(CodeChange, change_id)
    if row is None or row.project_id != project_id:
        raise CodeChangeError(NOT_FOUND)
    db.delete(row)
