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

Раскладку пакет не везёт вовсе (решение Р3, docs/plan-demo-template.md): ведёт
себя ровно как импорт — всё раскладывает движок.
"""

import io
import uuid
import zipfile
from functools import cache
from pathlib import Path

from sqlalchemy.orm import Session

from app.models.project import Project
from app.unified_apply import apply_unified_plan
from app.unified_import import build_unified_plan

_PACKAGES_DIR = Path(__file__).resolve().parent / "template_packages"

# Известные пакеты. Каталог на диске — не реестр: посеять можно только то, что
# названо здесь (опечатка в id не должна ввозить случайную папку).
DEMO_PACKAGE = "demo-marketplace"
_PACKAGES: frozenset[str] = frozenset({DEMO_PACKAGE})


@cache
def _package_zip(package_id: str) -> bytes:
    """Пакет → zip в памяти: ровно тот формат, который читает ввоз архива.

    Пакет лежит в репозитории РОССЫПЬЮ (правку надо уметь прочитать в git-diff),
    а приёмник ждёт архив — поэтому упаковка на лету. Штампы времени
    фиксированы, порядок файлов детерминирован: одинаковый пакет даёт одинаковые
    байты. Кэш — на процесс: пакет статичен, читать его с диска каждый раз незачем."""
    root = _PACKAGES_DIR / package_id
    names = sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file())
    # Манифест первым — как в build_archive (читается он всё равно по имени).
    names.sort(key=lambda n: (n != "manifest.yaml", n))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in names:
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, (root / name).read_bytes())
    return buf.getvalue()


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
    описание единый импорт берёт из манифеста пакета."""
    if template_id not in _PACKAGES:
        return None
    plan = build_unified_plan([(f"{template_id}.zip", _package_zip(template_id))])
    project, _result = apply_unified_plan(db, plan, {}, name, description, user_id)
    return project
