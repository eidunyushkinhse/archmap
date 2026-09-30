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
"""

import argparse
import getpass
import sys
from collections.abc import Callable

from sqlalchemy.orm import Session

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
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    # Сессия открывается только здесь: импорт модуля тестами к БД не подключается
    # (движок SQLAlchemy соединяется лениво, при первом запросе).
    with SessionLocal() as db:
        try:
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
