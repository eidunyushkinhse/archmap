"""Контекст запуска: корень путей вывода, область обхода, адрес origin и HEAD (ТЗ §4).

Единственная внешняя команда сборщика — git с фиксированными аргументами (инвариант 1):
корень репозитория, адрес origin, хэш HEAD и перечень файлов. Всё, что зовёт git, живёт
здесь, поэтому тест «без побочных эффектов» сверяет вызовы с GIT_COMMANDS.
"""

from __future__ import annotations

import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

# Подкоманды git, которые сборщик вообще может позвать (после «git -C <каталог>»).
GIT_COMMANDS: tuple[tuple[str, ...], ...] = (
    ("rev-parse", "--show-toplevel"),
    ("config", "--get", "remote.origin.url"),
    ("rev-parse", "HEAD"),
    ("ls-files", "-z", "--cached", "--others", "--exclude-standard", "--full-name"),
)
_GIT_TIMEOUT = 120

# Учётные данные в адресе origin вида https://user:token@host/org/repo. Сборщик пишет
# адрес как есть, нормализует его ArchMap, но секрет из адреса в вывод не попадает никогда
# (инвариант 6).
_USERINFO = re.compile(r"^([a-z][a-z0-9+.-]*://)[^@/]*@", re.IGNORECASE)


@dataclass(frozen=True)
class Context:
    """Где и как идёт обход.

    root — корень путей вывода: корень git или ПУТЬ без git. scope — ПУТЬ относительно root
    («» — весь корень); обход им ограничен, а пути в выводе отсчитываются от root, чтобы
    совпадать с тем, что пишет агент (source.path, основания).
    """

    root: Path
    scope: str
    repo: str
    commit: str
    git: bool
    system: str | None = None

    @property
    def scope_dir(self) -> Path:
        return self.root / self.scope if self.scope else self.root


def run_git(cwd: Path, args: tuple[str, ...]) -> bytes | None:
    """git -C cwd <args>: stdout или None, если git нет, команда упала или не уложилась."""
    if args not in GIT_COMMANDS:
        raise ValueError(f"git {' '.join(args)} не входит в перечень разрешённых команд")
    # Репозиторий задаёт только каталог (-C): переменные GIT_DIR, GIT_INDEX_FILE и прочие
    # GIT_* из окружения (их выставляют, например, хуки git) увели бы чтение в чужой индекс.
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    # Чтение не должно ничего записывать в репозиторий пользователя и ничего спрашивать.
    env["GIT_OPTIONAL_LOCKS"] = "0"
    env["GIT_TERMINAL_PROMPT"] = "0"
    try:
        done = subprocess.run(
            ["git", "-C", str(cwd), *args],
            capture_output=True,
            timeout=_GIT_TIMEOUT,
            check=False,
            env=env,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if done.returncode != 0:
        return None
    return done.stdout


def strip_credentials(url: str) -> str:
    """Адрес origin без учётных данных: https://user:token@host/x → https://host/x."""
    return _USERINFO.sub(r"\1", url.strip())


def make_context(path: Path, *, use_git: bool, system: str | None = None) -> Context:
    """Контекст для ПУТИ. Без git (нет команды, не репозиторий, --no-git) корень равен ПУТИ."""
    scope_abs = path.resolve()
    if use_git:
        top = run_git(scope_abs, GIT_COMMANDS[0])
        if top is not None and top.strip():
            root = Path(top.decode("utf-8", "replace").strip()).resolve()
            try:
                scope = scope_abs.relative_to(root).as_posix()
            except ValueError:
                scope = ""
            origin = run_git(root, GIT_COMMANDS[1])
            head = run_git(root, GIT_COMMANDS[2])
            return Context(
                root=root,
                scope="" if scope == "." else scope,
                repo=strip_credentials(origin.decode("utf-8", "replace")) if origin else "",
                commit=head.decode("ascii", "replace").strip() if head else "",
                git=True,
                system=system,
            )
    return Context(root=scope_abs, scope="", repo="", commit="", git=False, system=system)


def git_files(ctx: Context) -> list[str] | None:
    """Перечень файлов области по git (с учётом .gitignore), пути от корня репозитория."""
    out = run_git(ctx.scope_dir, GIT_COMMANDS[3])
    if out is None:
        return None
    names = {p.decode("utf-8", "replace") for p in out.split(b"\0") if p}
    return sorted(names)
