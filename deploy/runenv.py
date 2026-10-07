"""Запуск команды с окружением из файла настроек ArchMap.

Формат файла — как у EnvironmentFile в systemd: строки KEY=VALUE, комментарии с «#»
или «;», значение можно взять в кавычки. Подстановок оболочки нет: «$» и «%» в пароле
доходят до приложения как есть (поэтому файл не «source»-ят из bash).

    python3 runenv.py /etc/archmap/archmap.env -- python3 -m alembic upgrade head
"""

import os
import sys


def read_env(path: str) -> dict[str, str]:
    env: dict[str, str] = {}
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line[0] in "#;":
                continue
            key, sep, value = line.partition("=")
            if not sep:
                continue
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            env[key.strip()] = value
    return env


def main(argv: list[str]) -> None:
    if len(argv) < 4 or argv[2] != "--":
        sys.exit("использование: runenv.py ФАЙЛ_НАСТРОЕК -- КОМАНДА [АРГУМЕНТЫ…]")
    os.environ.update(read_env(argv[1]))
    os.execvp(argv[3], argv[3:])


if __name__ == "__main__":
    main(sys.argv)
