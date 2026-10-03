"""Серверные команды администрирования (docs/tasks/admin-users.md, шаг 4).

Первый администратор создаётся здесь, на сервере, без интернета и без открытой
регистрации:

    ./venv/bin/python -m app.admin create-admin <логин> [--role architect|viewer]
                                                        [--reset-password]

Пароль вводится в консоли дважды (getpass) и в аргументах не появляется: иначе он
остался бы в истории оболочки и в списке процессов.

Если пользователь уже есть, команда делает его администратором и снимает
блокировку (это путь восстановления доступа, когда админов не осталось), а пароль
не трогает, пока не передан --reset-password. Роль существующего меняется, только
если --role передан явно.

Демо-стенд (docs/tasks/demo-mode.md) администрируется тоже отсюда:

    ./venv/bin/python -m app.admin demo-cleanup [--idle-hours 24]
    ./venv/bin/python -m app.admin demo-stats

demo-cleanup сразу убирает песочницы гостей без активности дольше срока (то же
делает фоновая уборка приложения раз в 10 минут), demo-stats печатает сводку.
"""

import argparse
import getpass
import sys
from collections.abc import Callable
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app import demo
from app.auth import hash_password, password_problem
from app.database import SessionLocal
from app.models.user import User

# Роль нового администратора, если --role не передан: первый админ обычно и
# ведёт документацию.
DEFAULT_ROLE = "architect"


class AdminCommandError(Exception):
    """Отказ команды с текстом для консоли (код выхода 1)."""


def read_new_password(prompt: Callable[[str], str] | None = None) -> str:
    """Новый пароль из консоли: дважды, с проверкой совпадения и длины.

    prompt — подмена getpass для тестов; по умолчанию берётся getpass.getpass в
    момент вызова (его и подменяют тесты через monkeypatch)."""
    ask = prompt or getpass.getpass
    first = ask("Новый пароль: ")
    second = ask("Повторите пароль: ")
    if first != second:
        raise AdminCommandError("Пароли не совпадают")
    problem = password_problem(first)
    if problem is not None:
        raise AdminCommandError(problem)
    return first


def create_admin(
    db: Session,
    username: str,
    role: str | None = None,
    reset_password: bool = False,
    prompt: Callable[[str], str] | None = None,
) -> str:
    """Создать администратора или сделать им существующего. Возвращает итог для
    консоли. Коммитит сам: команда — одна транзакция."""
    username = username.strip()
    if not username:
        raise AdminCommandError("Укажите логин")
    if role is not None and role not in ("architect", "viewer"):
        raise AdminCommandError("Роль должна быть architect или viewer")

    user = db.query(User).filter(User.username == username).first()
    if user is None:
        password = read_new_password(prompt)
        user = User(
            username=username,
            hashed_password=hash_password(password),
            role=role or DEFAULT_ROLE,
            is_admin=True,
            is_active=True,
        )
        db.add(user)
        db.commit()
        return f"Создан администратор «{username}», роль {user.role}."

    if reset_password:
        user.hashed_password = hash_password(read_new_password(prompt))
    was_blocked = not user.is_active
    user.is_admin = True
    user.is_active = True
    if role is not None:
        user.role = role
    db.commit()

    parts = [f"«{username}» теперь администратор, роль {user.role}"]
    if was_blocked:
        parts.append("блокировка снята")
    parts.append("пароль изменён" if reset_password else "пароль не менялся")
    return ", ".join(parts) + "."


def demo_cleanup(db: Session, idle_hours: float = 24.0) -> str:
    """Убрать просроченные песочницы демо-стенда сейчас. Итог для консоли."""
    if idle_hours < 0:
        raise AdminCommandError("Срок бездействия не может быть отрицательным")
    report = demo.cleanup_sandboxes(db, idle=timedelta(hours=idle_hours))
    return f"Убрано песочниц: {report.guests}, проектов: {report.projects}."


def _when(moment: datetime | None) -> str:
    # В БД время UTC: подписываем, чтобы оператор не принял его за местное.
    return moment.strftime("%Y-%m-%d %H:%M UTC") if moment is not None else "—"


def demo_stats(db: Session) -> str:
    """Сводка демо-стенда: живые песочницы, проекты гостей, кто дольше всех без
    активности (уборка снимет их первыми)."""
    stats = demo.sandbox_stats(db)
    lines = [
        f"Живых песочниц: {stats.sandboxes}",
        f"Проектов у гостей: {stats.projects}",
    ]
    if stats.oldest:
        lines.append("Дольше всех без активности:")
        lines.extend(
            f"  {row.username}: создан {_when(row.created_at)}, "
            f"активен {_when(row.last_active_at)}, проектов {row.projects}"
            for row in stats.oldest
        )
    return "\n".join(lines)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.admin", description="Администрирование ArchMap на сервере."
    )
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser(
        "create-admin",
        help="создать администратора или сделать им существующего пользователя",
    )
    create.add_argument("username", help="логин")
    create.add_argument(
        "--role",
        choices=["architect", "viewer"],
        default=None,
        help=f"роль (новому по умолчанию {DEFAULT_ROLE}; существующему — не меняется)",
    )
    create.add_argument(
        "--reset-password",
        action="store_true",
        help="задать существующему пользователю новый пароль",
    )
    cleanup = commands.add_parser(
        "demo-cleanup", help="демо-стенд: убрать песочницы гостей без активности сейчас"
    )
    cleanup.add_argument(
        "--idle-hours",
        type=float,
        default=24.0,
        help="сколько часов бездействия считать сроком (по умолчанию 24)",
    )
    commands.add_parser("demo-stats", help="демо-стенд: сводка по песочницам")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    # Сессия открывается только здесь: импорт модуля тестами к БД не подключается
    # (движок SQLAlchemy соединяется лениво, при первом запросе).
    with SessionLocal() as db:
        try:
            if args.command == "demo-cleanup":
                print(demo_cleanup(db, args.idle_hours))
            elif args.command == "demo-stats":
                print(demo_stats(db))
            else:
                print(create_admin(db, args.username, args.role, args.reset_password))
        except AdminCommandError as exc:
            print(f"Ошибка: {exc}", file=sys.stderr)
            return 1
        except (KeyboardInterrupt, EOFError):
            # Ctrl+C или Ctrl+D на вводе пароля: ничего не записано.
            print("\nОтменено.", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
