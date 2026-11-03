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
NOT_COVERED_TITLE = "Не покрыто"
NOTES_TITLE = "Пояснения"
HOW_TO_IMPORT_TITLE = "Как ввезти"

# Семьи покрытия словами (порядок задаёт registry.FAMILIES).
FAMILY_LABEL = {
    "containers": "Контейнеры",
    "databases": "Базы данных",
    "brokers": "Брокеры",
    "edges": "Связи",
    "tables": "Таблицы",
    "config": "Параметры конфигурации",
    "channels": "Каналы брокеров",
    "http_routes": "Маршруты HTTP",
    "workers": "Воркеры",
    "schedules": "Расписания",
}
# Формы числа для фразы «Найдено: 3 контейнера»: один, два, пять.
FAMILY_WORDS = {
    "containers": ("контейнер", "контейнера", "контейнеров"),
    "databases": ("база данных", "базы данных", "баз данных"),
    "brokers": ("брокер", "брокера", "брокеров"),
    "edges": ("связь", "связи", "связей"),
    "tables": ("таблица", "таблицы", "таблиц"),
    "config": ("параметр конфигурации", "параметра конфигурации", "параметров конфигурации"),
    "channels": ("канал", "канала", "каналов"),
    "http_routes": ("маршрут HTTP", "маршрута HTTP", "маршрутов HTTP"),
    "workers": ("воркер", "воркера", "воркеров"),
    "schedules": ("расписание", "расписания", "расписаний"),
}


def found_phrase(parts: list[str]) -> str:
    """«Найдено: 3 контейнера, 1 база данных и 4 связи.»"""
    if not parts:
        return NOTHING_FOUND
    if len(parts) == 1:
        return f"Найдено: {parts[0]}."
    return f"Найдено: {', '.join(parts[:-1])} и {parts[-1]}."


def empty_phrase(labels: list[str]) -> str:
    return "Искали и не нашли: " + ", ".join(labels) + "."


def family_unsupported(label: str, stacks: list[str]) -> str:
    return f"{label}: сборщик пока не читает {', '.join(stacks)}."


def family_partial(label: str, stacks: list[str]) -> str:
    return f"{label}: найдено в манифестах, а {', '.join(stacks)} сборщик пока не читает."


def family_unknown(label: str) -> str:
    return f"{label}: сборщик не опознал стек, поэтому не искал."


def family_error(label: str, error: str) -> str:
    return f"{label}: {error}."


def unread_phrase(too_large: int, binary: int) -> str:
    parts = []
    if too_large:
        parts.append(plural(too_large, "файл", "файла", "файлов") + " больше предела размера")
    if binary:
        parts.append(plural(binary, "двоичный файл", "двоичных файла", "двоичных файлов"))
    return "Не прочитано: " + ", ".join(parts) + "."


def excluded_more(n: int) -> str:
    return f"  и ещё {plural(n, 'строка', 'строки', 'строк')}: полный перечень в coverage.yaml"


HOW_TO_IMPORT = [
    "  Схема в файле schema.yaml. На экране «Проекты» нажмите «Новый проект», выберите способ",
    "  «Импорт» и добавьте файл. Чтобы обновить открытый проект, нажмите кнопку «Действия со",
    "  схемой» (три точки), выберите «Обновить из кода» и добавьте тот же файл.",
]
HOW_TO_IMPORT_TABLES = [
    "  Таблицы в файлах facts/*.tables.yaml. На странице базы данных в разделе «Структура»",
    "  нажмите «+ Таблица», выберите «Через ИИ-агента» и добавьте файлы.",
]
HOW_TO_IMPORT_CONFIG = [
    "  Параметры конфигурации в файлах facts/*.config.yaml. На странице контейнера в разделе",
    "  «Конфигурация» нажмите «+ Параметр», выберите «Через ИИ-агента» и добавьте файлы.",
]
HOW_TO_IMPORT_CHANNELS = [
    "  Каналы брокеров в файлах facts/*.channels.yaml. На странице брокера в разделе «Каналы»",
    "  нажмите «+ Канал», выберите «Через ИИ-агента» и добавьте файлы.",
]
HOW_TO_IMPORT_FACTS = [
    "  Адрес объекта записан в первой строке каждого файла фактов, поэтому все файлы одного",
    "  вида можно добавить в одно окно. Записать их может и ИИ-агент инструментами ArchMap.",
]
HOW_TO_IMPORT_AGENT = [
    "  Каталог agent читает ИИ-агент: там основания каждой записи, точки входа и подсказки.",
    "  ArchMap его не ввозит.",
]
TAIL = [
    "Связи сборщик видит только в манифестах. Объекты, связи которых там не видны, ArchMap",
    "при ввозе отметит замечанием «объектов без единой связи», а у связей с брокером",
    "отметит, что канал не указан. Связи и каналы допишет агент или человек.",
    "Каталог с результатом стоит добавить в .gitignore репозитория.",
]
EXCLUDE_REASON = {
    "convention": "по соглашению",
    "archmapignore": "по .archmapignore",
    "option": "по ключу --exclude",
}


# Причины в hints.yaml: их читает агент, поэтому коротко и словами продукта.
REASON_EXTENDS = "extends не раскрывается: сервис описан по своему ключу без наследования"
REASON_INCLUDE = "include не раскрывается: подключённые файлы compose не читаются"
REASON_ENV_FILE = "env_file не читается: в файлах окружения бывают секреты"
REASON_BUILD_OUTSIDE = "каталог сборки вне области обхода"
REASON_BAD_YAML = "файл не разбирается как YAML или превышает пределы разбора"
REASON_DYNAMIC_VALUE = "значение с подстановкой переменной, адрес из него не взят"
REASON_PROFILE = "сервис включается только профилем compose"
REASON_DEV_FILE = "сервис есть только в файле compose для разработки"
REASON_SHARED_CODE = (
    "контейнеры собраны из одного каталога, поэтому путь к коду ни одному из них не поставлен"
)
REASON_DEV_DOCKERFILE = "Dockerfile для разработки, тестов или CI"
REASON_DEPENDS_ON = "depends_on задаёт порядок запуска, а не вызов, поэтому связь не нарисована"
NOTE_IMPLICIT_CONTAINER = "контейнер определён по репозиторию, не по манифесту"


def parser_failed(parser: str, err: str) -> str:
    return f"разборщик {parser} остановился с ошибкой {err}"
