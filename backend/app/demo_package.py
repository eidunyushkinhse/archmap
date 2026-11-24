"""Посев демо-пакета для будущего онбординга.

Демо-пакет (demo-marketplace, «Маркетплейс «Ярмарка»») — не декларация в коде, а
готовый проект целиком: многоуровневое C4, процессы, схемы логики, спеки и три
семьи фактов. Он лежит распакованным архивом знания в template_packages/<id>/
(обновляется scripts/refresh-demo-template.py) и сеется существующими
приёмниками единого импорта. Своего сидера у пакета нет СОЗНАТЕЛЬНО: ручной
перечень копируемых полей трижды отставал от модели (см. app/copy_plan.py), и
пакет отстал бы так же.

Способ старта «Шаблон» в окне создания проекта убран 2026-09-30 вместе с шестью
каркасами C4 и API витрины (GET /projects/templates, start="template:<id>").
Из API сидер больше не вызывается: его дождётся онбординг на демо-проекте
(tasks.md), а до тех пор пакет живым держит сторож tests/test_template_package.py.

Раскладку архив знания не везёт (решение Р3, docs/archive/plan-demo-template.md), и
единый импорт раскладывает пакет движком, как любой ввоз. Но главная демо-проекта с
авто-раскладкой не читается (узкая колонка, раунд 5 обучения, docs/tasks/demo-tour-5.md),
поэтому рядом с архивом в пакете лежит СВОЯ расстановка — layout.yaml: позиции объектов
по путям, только x и y. Её читает только этот посев: в архив пакета (zip для единого
импорта) файл не попадает, и формат архива знания не меняется. Раздел deployment того же
файла — расстановка холста «Развёртывание» (docs/specs/deployment.md, D14): позиция
карточки объекта на площадке, ключ строки `deploy:<объект>@<площадка | unplaced>` в виде
того же уровня; свёрнутость площадок файл не задаёт.
"""

import io
import logging
import math
import uuid
import zipfile
from dataclasses import dataclass
from functools import cache
from pathlib import Path

import yaml
from sqlalchemy.orm import Session

from app import yaml_io
from app.deployment import project_sites, site_path
from app.models.node import Node
from app.models.project import Project
from app.models.view_layout import DEPLOY_KEY_PREFIX, ViewLayoutItem
from app.node_ref import NodeIndex
from app.unified_apply import apply_unified_plan
from app.unified_import import build_unified_plan

log = logging.getLogger(__name__)

_PACKAGES_DIR = Path(__file__).resolve().parent / "template_packages"

# Известные пакеты. Каталог на диске — не реестр: посеять можно только то, что
# названо здесь (опечатка в id не должна ввозить случайную папку).
DEMO_PACKAGE = "demo-marketplace"
_PACKAGES: frozenset[str] = frozenset({DEMO_PACKAGE})

# Расстановка пакета: лежит рядом с файлами архива, но в архив не входит.
LAYOUT_FILE = "layout.yaml"
# Площадка группы «Размещение не указано» в разделе deployment и в ключе карточки.
UNPLACED = "unplaced"


@cache
def _package_zip(package_id: str) -> bytes:
    """Пакет → zip в памяти: ровно тот формат, который читает ввоз архива.

    Пакет лежит в репозитории РОССЫПЬЮ (правку надо уметь прочитать в git-diff),
    а приёмник ждёт архив — поэтому упаковка на лету. Штампы времени
    фиксированы, порядок файлов детерминирован: одинаковый пакет даёт одинаковые
    байты. Кэш — на процесс: пакет статичен, читать его с диска каждый раз незачем.
    Расстановка (LAYOUT_FILE) — не часть архива знания и в zip не идёт."""
    root = _PACKAGES_DIR / package_id
    names = sorted(
        p.relative_to(root).as_posix()
        for p in root.rglob("*")
        if p.is_file() and p.relative_to(root).as_posix() != LAYOUT_FILE
    )
    # Манифест первым — как в build_archive (читается он всё равно по имени).
    names.sort(key=lambda n: (n != "manifest.yaml", n))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in names:
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, (root / name).read_bytes())
    return buf.getvalue()


@dataclass(frozen=True)
class LayoutPos:
    """Позиция объекта на виде: view — путь контейнера вида (None — корень проекта),
    item — путь объекта. site — у карточки холста «Развёртывание»: путь площадки по её
    дереву или UNPLACED; None — позиция на холсте объектов."""

    view: str | None
    item: str
    x: float
    y: float
    site: str | None = None


def _coord(value: object) -> float | None:
    """Координата из файла: конечное число, не булево (True в YAML — тоже int)."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value) if math.isfinite(value) else None


def _views(raw: object) -> list[tuple[str | None, dict]]:
    """Виды раздела: [{view: путь | null, items: {...}}] → пары (вид, items); негодные
    записи пропускаются."""
    if not isinstance(raw, list):
        return []
    out: list[tuple[str | None, dict]] = []
    for view in raw:
        if not isinstance(view, dict):
            continue
        vpath = view.get("view")
        items = view.get("items")
        if (vpath is None or isinstance(vpath, str)) and isinstance(items, dict):
            out.append((vpath, items))
    return out


def _pos(raw: object) -> tuple[float, float] | None:
    """{x, y} записи; негодная — None."""
    if not isinstance(raw, dict):
        return None
    x, y = _coord(raw.get("x")), _coord(raw.get("y"))
    return (x, y) if x is not None and y is not None else None


def parse_layout(text: str) -> list[LayoutPos]:
    """Разбор layout.yaml: {views: [{view: путь | null, items: {путь: {x, y}}}],
    deployment: [{view: путь | null, items: {путь объекта: {путь площадки: {x, y}}}}]}.

    Файл пакета правят руками и скриптом, поэтому разбор терпим: негодная запись
    пропускается, а файл, который не разбирается вовсе, даёт пустую расстановку —
    вход гостя из-за него не падает (проект просто раскладывается движком)."""
    try:
        doc = yaml_io.safe_load(text)
    except yaml.YAMLError:
        log.warning("Демо-пакет: %s не разбирается, расстановки не будет", LAYOUT_FILE)
        return []
    if not isinstance(doc, dict):
        return []
    out: list[LayoutPos] = []
    for vpath, items in _views(doc.get("views")):
        for item, raw in items.items():
            pos = _pos(raw)
            if isinstance(item, str) and pos is not None:
                out.append(LayoutPos(vpath, item, *pos))
    for vpath, items in _views(doc.get("deployment")):
        for item, sites in items.items():
            if not isinstance(item, str) or not isinstance(sites, dict):
                continue
            for site, raw in sites.items():
                pos = _pos(raw)
                if isinstance(site, str) and pos is not None:
                    out.append(LayoutPos(vpath, item, *pos, site=site))
    return out


def read_layout(path: Path) -> list[LayoutPos]:
    """Расстановка из файла; нет файла или не читается — пустая."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    except (OSError, UnicodeDecodeError):
        log.warning("Демо-пакет: %s не читается, расстановки не будет", path)
        return []
    return parse_layout(text)


@cache
def _package_layout(package_id: str) -> tuple[LayoutPos, ...]:
    """Расстановка пакета (кэш на процесс, как у _package_zip: пакет статичен)."""
    return tuple(read_layout(_PACKAGES_DIR / package_id / LAYOUT_FILE))


def _site_ids(db: Session, project: Project) -> dict[str, uuid.UUID | None]:
    """Площадки ЭТОГО проекта по путям; у тёзок путь неоднозначен — None (позиция на
    такой площадке пропускается)."""
    sites = project_sites(db, project.id)
    tree = {s.id: (s.name, s.parent_id) for s in sites}
    out: dict[str, uuid.UUID | None] = {}
    for s in sites:
        path = site_path(tree, s.id)
        out[path] = None if path in out else s.id
    return out


def seed_package_layout(db: Session, project: Project, package_id: str) -> int:
    """Положить расстановку пакета строками раскладки проекта. Пути резолвятся по
    объектам и площадкам ЭТОГО проекта: объекта, контейнера вида или площадки с таким
    путём нет или путь неоднозначен (тёзки) — позиция пропускается без ошибки, пакет и
    файл могут разойтись. Пишется только {x, y}: раскрытие контейнеров и свёрнутость
    площадок файл не задаёт. Возвращает число записанных строк. Коммит — на вызывающей
    стороне."""
    positions = _package_layout(package_id)
    if not positions:
        return 0
    nodes = db.query(Node).filter(Node.project_id == project.id).all()
    index = NodeIndex.of(nodes)
    sites = _site_ids(db, project) if any(p.site is not None for p in positions) else {}

    def one(path: str) -> uuid.UUID | None:
        hits = index.by_path.get(path, [])
        return index.flat[hits[0]].id if len(hits) == 1 else None

    def item_key(pos: LayoutPos, node_id: uuid.UUID) -> str | None:
        """Ключ строки: id объекта на холсте объектов, карточка deploy:<объект>@<площадка>
        на холсте «Развёртывание»."""
        if pos.site is None:
            return str(node_id)
        site = UNPLACED if pos.site == UNPLACED else sites.get(pos.site)
        return f"{DEPLOY_KEY_PREFIX}{node_id}@{site}" if site is not None else None

    rows: dict[tuple[uuid.UUID | None, str], dict[str, float]] = {}
    for pos in positions:
        view_id = None if pos.view is None else one(pos.view)
        node_id = one(pos.item)
        if node_id is None or (pos.view is not None and view_id is None):
            continue
        key = item_key(pos, node_id)
        if key is not None:
            rows[(view_id, key)] = {"x": pos.x, "y": pos.y}
    for (view_id, item_id), payload in rows.items():
        db.add(ViewLayoutItem(project_id=project.id, view_id=view_id, item_id=item_id, payload=payload))
    db.flush()
    return len(rows)


def seed_package_template(
    db: Session,
    template_id: str,
    name: str,
    description: str | None,
    user_id: uuid.UUID,
) -> Project | None:
    """Создать проект из демо-пакета. None — пакет неизвестен; проект при этом не
    создаётся вовсе (сирот нет). Коммит — на вызывающей стороне.

    Проект создаёт единый импорт: пакет едет ему одним входом-архивом, и все семьи
    ложатся РОДНЫМИ приёмниками — теми же, что у ввоза архива пользователем. Споров
    у одного входа не бывает по построению, поэтому резолюции пустые. Пустое
    описание единый импорт берёт из манифеста пакета. Следом ложится расстановка
    пакета (seed_package_layout)."""
    if template_id not in _PACKAGES:
        return None
    plan = build_unified_plan([(f"{template_id}.zip", _package_zip(template_id))])
    project, _result = apply_unified_plan(db, plan, {}, name, description, user_id)
    seed_package_layout(db, project, template_id)
    return project
