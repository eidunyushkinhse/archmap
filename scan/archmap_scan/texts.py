"""Все строки сборщика, которые читает человек или его агент (инвариант 8 ТЗ).

Правила текстов продукта: слова продукта («объект», «контейнер», «спецификация»), без
сочетания запятой с длинным тире, тире только по грамматике, без многоточий, без
внутреннего словаря. Окна и кнопки ArchMap называются так, как их видит пользователь. По
этому модулю проходит сторож из CLAUDE.md.

Модуль импортируется до проверки версии Python (cli.main), поэтому в нём только строки и
простые функции без синтаксиса новее 3.7.
"""

from __future__ import annotations

PRODUCT = "Сборщик фактов ArchMap"

HELP = """{product} {version}

Запуск: python3 archmap-scan.pyz [ПУТЬ] [ключи]

Собирает из репозитория то, что видно без чтения смысла кода: контейнеры, базы данных,
брокеры и связи из манифестов, таблицы из миграций, параметры конфигурации. Код
репозитория не выполняется, сеть не нужна. Результат ложится в каталог в тех форматах,
которые ввозит ArchMap.

  ПУТЬ               корень репозитория или его подкаталог; по умолчанию текущий каталог
  --system ИМЯ       имя системы в схеме; по умолчанию имя из манифеста сборки или каталога
  --out КАТАЛОГ      куда записать результат; по умолчанию ./archmap-scan
  --exclude ШАБЛОН   не читать файлы по шаблону в синтаксисе .gitignore; ключ повторяется
  --include ШАБЛОН   вернуть каталог, который сборщик пропускает по соглашению (tests, docs,
                     fixtures и подобные); ключ повторяется
  --no-git           не обращаться к git: файлы обходятся по каталогу, repo и commit пусты
  --json             напечатать итог в JSON вместо сводки
  --version          напечатать версию
  -h, --help         эта справка

Код выхода 0 означает, что результат записан, 1 означает ошибку.
"""


def python_too_old(found: str) -> str:
    return f"Сборщику фактов ArchMap нужен Python 3.10 или новее, а запущен Python {found}."


def unknown_option(opt: str) -> str:
    return f"Неизвестный ключ «{opt}». Список ключей: --help."


def option_needs_value(opt: str) -> str:
    return f"Ключу {opt} нужно значение."


def flag_takes_no_value(opt: str) -> str:
    return f"Ключ {opt} не принимает значения."


TOO_MANY_PATHS = "Путь к репозиторию указывается один раз."
EMPTY_SYSTEM = "Имя системы в ключе --system не может быть пустым."


def path_not_found(path: str) -> str:
    return f"Каталог «{path}» не найден."


def path_not_dir(path: str) -> str:
    return f"«{path}» не каталог. Укажите каталог репозитория."


def out_busy(path: str) -> str:
    return (
        f"Каталог «{path}» уже существует, и в нём лежат чужие файлы. "
        "Укажите другой каталог ключом --out."
    )


def out_not_dir(path: str) -> str:
    return f"«{path}» уже существует и это не каталог. Укажите другой путь ключом --out."


def crashed(err: str) -> str:
    return f"Сборщик остановился с ошибкой: {err}"


def written_to(path: str) -> str:
    return f"Результат записан в каталог «{path}»."


MARKER = (
    "Этот каталог создал сборщик фактов ArchMap. При следующем запуске с тем же --out\n"
    "сборщик перезапишет его целиком.\n"
)


def plural(n: int, one: str, few: str, many: str) -> str:
    """«1 файл», «2 файла», «5 файлов»: число со словом в нужной форме."""
    n10, n100 = n % 10, n % 100
    if n10 == 1 and n100 != 11:
        word = one
    elif 2 <= n10 <= 4 and not 12 <= n100 <= 14:
        word = few
    else:
        word = many
    return f"{n} {word}"


def files_count(n: int) -> str:
    return plural(n, "файл", "файла", "файлов")


def summary_head(version: str, repo: str, commit: str) -> str:
    parts = [f"{PRODUCT} {version}"]
    if repo:
        parts.append(f"репозиторий {repo}")
    if commit:
        parts.append(f"коммит {commit[:12]}")
    return " · ".join(parts)


NOTHING_FOUND = "Ничего не найдено."
EXCLUDED_TITLE = "Исключено"
EXCLUDE_REASON = {
    "convention": "по соглашению",
    "archmapignore": "по .archmapignore",
    "option": "по ключу --exclude",
}
