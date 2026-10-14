"""Учётка-читатель для зондов полигона (аудит P-6, P-23) — разовая подготовка dev-базы.

Зонды (scripts/*-probe.mjs, scripts/dump-levels.mjs) в режиме читателя обязаны ходить
БЕЗ права записи: иначе засев раскладки сохраняется в базу, и полигон «финал ==
перезагрузка» проверяет уже не то. Роль из токена ArchMap не читает (её решает база),
поэтому читатель — отдельная учётка: глобально «Пользователь» (viewer), в каждом активном
проекте — участник с ролью «чтение». Пароль случайный и не нужен: зонд чеканит токен сам.

    backend/venv/bin/python scripts/probe-reader.py [--username probe-reader]
    export ARCHMAP_PROBE_READER=probe-reader

Повторный запуск безопасен: добавит участие в проектах, появившихся с прошлого раза.
"""

import argparse
import os
import secrets
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND))
os.chdir(BACKEND)  # Settings читает .env от текущей директории

import app.main  # noqa: E402, F401 — регистрирует все модели
from app.auth import hash_password  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.models.project import Project  # noqa: E402
from app.models.project_member import ProjectMember  # noqa: E402
from app.models.user import User  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Учётка-читатель для зондов полигона")
    parser.add_argument("--username", default="probe-reader")
    args = parser.parse_args()
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.username == args.username).one_or_none()
        if user is None:
            user = User(username=args.username, hashed_password=hash_password(secrets.token_urlsafe(24)),
                        role="viewer", is_admin=False)
            db.add(user)
            db.flush()
            print(f"заведён пользователь {args.username}")
        elif user.is_admin or user.role != "viewer":
            sys.exit(f"{args.username} — не простой читатель (админ или architect): возьмите другое имя")
        member_of = {m.project_id for m in db.query(ProjectMember).filter(ProjectMember.user_id == user.id)}
        added = 0
        for project in db.query(Project).filter(Project.archived_at.is_(None)):
            if project.id not in member_of:
                db.add(ProjectMember(project_id=project.id, user_id=user.id, role="reader"))
                added += 1
        db.commit()
        print(f"участие «чтение» добавлено в проектах: {added}")
        print(f"export ARCHMAP_PROBE_READER={args.username}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
