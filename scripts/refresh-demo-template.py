#!/usr/bin/env python3
"""Обновление пакета демо-шаблона из живого эталонного проекта.

Пакет шаблона (backend/app/template_packages/<id>/) — РАСПАКОВАННЫЙ архив знания
эталонного проекта: ровно те файлы, что отдаёт «Скачать архив», только лежащие
россыпью, чтобы правку шаблона можно было прочитать в git-diff. Сидер пакует их
обратно в zip и отдаёт единому импорту, поэтому формат пакета = формат архива,
расходиться им негде.

Пакет — СНИМОК, а не ссылка: правка живого проекта не меняет шаблон, пока не
прогнан этот скрипт (и наоборот).

Запуск (venv бэка — в нём настройки из backend/.env):
    cd backend && ./venv/bin/python ../scripts/refresh-demo-template.py

После прогона обязателен сторож:
    cd backend && ./venv/bin/python -m pytest tests/test_template_package.py -q
"""

import argparse
import io
import os
import shutil
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BACKEND = REPO / "backend"
# Настройки бэка читаются из backend/.env относительно рабочего каталога.
os.chdir(BACKEND)
sys.path.insert(0, str(BACKEND))

import app.main  # noqa: F401,E402  — регистрация всех моделей SQLAlchemy
from app.archive_export import build_archive  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.models.project import Project  # noqa: E402

DEFAULT_PROJECT = "Маркетплейс «Ярмарка» v2"
DEFAULT_PACKAGE = BACKEND / "app" / "template_packages" / "demo-marketplace"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", default=DEFAULT_PROJECT, help="имя эталонного проекта в БД")
    ap.add_argument("--package", default=str(DEFAULT_PACKAGE), help="каталог пакета шаблона")
    args = ap.parse_args()

    db = SessionLocal()
    try:
        found = (
            db.query(Project)
            .filter(Project.name == args.project, Project.archived_at.is_(None))
            .all()
        )
        if len(found) != 1:
            names = ", ".join(f"«{p.name}»" for p in db.query(Project).filter(Project.archived_at.is_(None)).all())
            print(
                f"Эталонный проект «{args.project}» "
                + ("не найден" if not found else f"найден в {len(found)} экземплярах")
                + f". Активные проекты: {names}",
                file=sys.stderr,
            )
            return 1
        payload = build_archive(db, found[0])
    finally:
        db.close()

    pkg = Path(args.package)
    if pkg.exists():
        shutil.rmtree(pkg)
    pkg.mkdir(parents=True)

    zf = zipfile.ZipFile(io.BytesIO(payload))
    total = 0
    for info in zf.infolist():
        if info.is_dir():
            continue
        dest = pkg / info.filename
        dest.parent.mkdir(parents=True, exist_ok=True)
        data = zf.read(info)
        dest.write_bytes(data)
        total += len(data)

    print(f"пакет обновлён: {pkg.relative_to(REPO)}")
    print(f"файлов: {len(zf.namelist())}, распакованный размер: {total / 1024:.1f} КБ")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
