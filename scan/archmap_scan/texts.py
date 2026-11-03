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
HOW_TO_IMPORT_TITLE = "Как импортировать"

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


# Найдено, но не записано: «Таблиц без владельца: 12, перечень в agent/hints.yaml.»
UNASSIGNED_WORDS = {
    "edges": "Связей с брокером",
    "tables": "Таблиц",
    "config": "Параметров конфигурации",
    "channels": "Каналов",
    "http_routes": "Маршрутов HTTP",
    "schedules": "Расписаний",
}


# Имена из кода, заданные выражением: «Маршрутов HTTP с путём, заданным выражением в коде: 2».
DYNAMIC_WORDS = {
    "http_routes": "Маршрутов HTTP с путём",
    "config": "Параметров конфигурации с именем",
    "channels": "Каналов с именем",
    "schedules": "Расписаний с именем",
}


def dynamic_line(family: str, n: int) -> str:
    word = DYNAMIC_WORDS.get(family, FAMILY_LABEL.get(family, family))
    return f"{word}, заданным выражением в коде: {n}, перечень в agent/hints.yaml."


def shared_params_line(containers: int, records: int) -> str:
    """«Параметры общего кода записаны каждому из 7 контейнеров: записей 133.» Записи —
    только общих параметров: свои параметры контейнера в это число не входят."""
    holders = plural(containers, "контейнера", "контейнеров", "контейнеров")
    return f"Параметры общего кода записаны каждому из {holders}: записей {records}."


def unassigned_line(family: str, n: int) -> str:
    word = UNASSIGNED_WORDS.get(family, FAMILY_LABEL.get(family, family))
    return f"{word} без владельца: {n}, перечень в agent/hints.yaml."


def found_phrase(parts: list[str]) -> str:
    """«Найдено: 3 контейнера, 1 база данных и 4 связи.»"""
    if not parts:
        return NOTHING_FOUND
    if len(parts) == 1:
        return f"Найдено: {parts[0]}."
    return f"Найдено: {', '.join(parts[:-1])} и {parts[-1]}."


def empty_phrase(labels: list[str]) -> str:
    return "Искали и не нашли: " + ", ".join(labels) + "."


def and_list(items: list[str]) -> str:
    """Перечень через «и»: «a», «a и b», «a, b и c»."""
    if len(items) <= 1:
        return "".join(items)
    return f"{', '.join(items[:-1])} и {items[-1]}"


def family_unsupported(label: str, stacks: list[str]) -> str:
    return f"{label}: сборщик пока не читает {and_list(stacks)}."


def family_partial(label: str, stacks: list[str], code: bool, from_code: bool) -> str:
    """Семья найдена не целиком. code — непрочитанное в ней код на языке или фреймворке;
    from_code — найденное пришло и из кода, а не только из манифестов."""
    what = f"код на {and_list(stacks)}" if code else and_list(stacks)
    if code and not from_code:
        return f"{label}: найдено в манифестах, {what} сборщик пока не читает."
    return f"{label}: найдено не всё, {what} сборщик пока не читает."


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
    "  ArchMap его не импортирует.",
]
# Хвост сводки: абзац про связи — только когда в схеме есть объекты, совет про
# .gitignore — всегда.
TAIL_EDGES = [
    "Связи сборщик видит в манифестах, а связи с брокером ещё и в коде, где канал назван",
    "строкой. Объекты, связи которых не видны, ArchMap при импорте отметит замечанием",
    "«объектов без единой связи», а у связей с брокером без канала отметит, что канал не",
    "указан. Связи и каналы допишет агент или человек.",
]
TAIL_GITIGNORE = "Каталог с результатом стоит добавить в .gitignore репозитория."
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
REASON_BUILD_MISSING = "каталог сборки не найден в репозитории"
REASON_BAD_YAML = "файл не разбирается как YAML или превышает пределы разбора"
REASON_DYNAMIC_VALUE = "значение с подстановкой переменной, адрес из него не взят"
REASON_DYNAMIC_IMAGE = "имя образа задано переменной и известно только при запуске"
REASON_PROFILE = "сервис включается только профилем compose"
REASON_DEV_FILE = "сервис есть только в файле для разработки, тестов или CI"
REASON_SHARED_CODE = (
    "контейнеры собраны из одного каталога, поэтому путь к коду ни одному из них не поставлен"
)
REASON_DEPENDS_ON = "depends_on задаёт порядок запуска, а не вызов, поэтому связь не нарисована"
# Compose по содержимому (ТЗ §13.3): файл не с именем compose, но в формате compose.
REASON_EXTERNAL_REPO = "сервис из другого репозитория, объект для него сборщик не создаёт"


def compose_by_content(path: str) -> str:
    """Пометка покрытия контейнеров: «compose по содержимому: devservices/config.yml»."""
    return f"compose по содержимому: {path}"


# Подписи связей (ТЗ §5.1): подпись называет действие источника связи. Сервис использует
# базу и публикует в брокер, брокер доставляет сервису: «потребляет» у стрелки из брокера
# читалось бы наоборот (как в примере промпта импорта: «доставляет новые заказы»).
LABEL_USES = "использует"
LABEL_PUBLISHES = "публикует"
LABEL_DELIVERS = "доставляет"
NOTE_IMPLICIT_CONTAINER = "контейнер определён по репозиторию, не по манифесту"
NOTE_DB_BY_MIGRATIONS = "база определена по миграциям, не по манифесту"
NOTE_BROKER_BY_CLIENT = "брокер определён по клиенту в коде, не по манифесту"
NOTE_BUILDFILES = "контейнеры определены по файлам сборки, не по манифесту"
# Сборка, которую сборщик не читает, когда контейнеры определены по файлам сборки.
STACK_ANT = "Java (build.xml)"
# Имя объекта-базы, диалект которой по миграциям не опознан (ТЗ §7, пункт 3).
UNKNOWN_DATABASE = "База данных"


def parser_failed(parser: str, err: str) -> str:
    return f"разборщик {parser} остановился с ошибкой {err}"
REASON_RELEASE_PHASE = "фаза выпуска Heroku выполняется один раз при выкладке, это не процесс"
REASON_TEMPLATE_NAME = "имя программы задаётся шаблоном и известно только при развёртывании"
REASON_HELM_DISABLED = "компонент чарта выключен в values.yaml (enabled: false)"
NOTE_HELM_TEMPLATES = "шаблоны Helm (каталог templates) не разбираются"
STACK_HELM_TEMPLATES = "Helm templates"
REASON_BAD_MANIFEST = "манифест сборки не разбирается"
REASON_MANIFEST_TOO_LARGE = "манифест сборки больше предела разбора"
REASON_SHARED_LIB = "общий код: файл вне каталогов кода всех контейнеров"
REASON_NO_DATABASE = "база не найдена в манифестах"
REASON_MANY_DATABASES = "несколько баз, владелец не определим"
REASON_SKIPPED_STATEMENT = "инструкция миграции не разобрана, её изменения в таблицы не попали"


def migration_error_in(folder: str, error: str) -> str:
    return f"в каталоге {folder} {error}"


def migration_failed(error: str) -> str:
    return f"{error}; таблицы из этих миграций не собраны"


def alembic_cycle(revisions: list[str]) -> str:
    return "цикл ревизий Alembic: " + ", ".join(revisions[:5])


def alembic_broken(revision: str, parent: str) -> str:
    return f"обрыв цепочки Alembic: ревизия {revision} ссылается на неизвестную ревизию {parent}"


REASON_BAD_PYTHON = "файл миграции не разбирается как Python"


def django_cycle(migrations: list[str]) -> str:
    return "цикл миграций Django: " + ", ".join(migrations[:5])


def django_broken(migration: str, parent: str) -> str:
    return f"обрыв цепочки Django: миграция {migration} ссылается на неизвестную миграцию {parent}"
REASON_OPENAPI_TOO_LARGE = "файл больше предела разбора YAML, операции не посчитаны"
REASON_BAD_OPENAPI = "файл OpenAPI не разбирается"
REASON_OPENAPI_REFS = "пути заданы ссылками, которые не удалось развернуть, операции не посчитаны"
REASON_OPENAPI_FILE = "спецификацию сборщик не импортирует, её добавляют в разделе «OpenAPI» объекта"
REASON_CLIENT_LIBRARY = "клиентская библиотека в манифесте сборки подсказывает вид зависимости"

# Ярус кода (ТЗ §6.2): причины в hints.yaml.
REASON_DYNAMIC_ROUTE = "путь маршрута задан выражением, а не строкой, и известен только при запуске"
REASON_DYNAMIC_PARAM = (
    "имя параметра задано выражением, а не строкой, и известно только при запуске"
)
REASON_DYNAMIC_CHANNEL = "имя канала задано выражением, а не строкой, и известно только при запуске"
REASON_DYNAMIC_SCHEDULE = (
    "имя расписания задано выражением, а не строкой, и известно только при запуске"
)
REASON_MANY_OWNERS = "файл в каталоге нескольких контейнеров, владелец не определим"
REASON_NO_BROKER = "брокер не найден в манифестах"
REASON_MANY_BROKERS = "несколько брокеров этого вида, владелец не определим"

# Служебные каталоги, конфиги инструментов и переменные ОС (ТЗ §13.1): записи кода из них
# не факты сервиса, а окружение разработчика и CI. Они не удаляются, а лежат в подсказках.
REASON_TOOLING_DIR = "файл в служебном каталоге, не код сервиса"
REASON_TOOL_CONFIG = "конфиг инструмента"
REASON_OS_VARIABLE = "переменная операционной системы или CI"
# Причины, по которым найденное в факты не записано не из-за владельца: в счёт «без
# владельца» такие подсказки не входят.
ASIDE_REASONS = frozenset({REASON_TOOLING_DIR, REASON_TOOL_CONFIG, REASON_OS_VARIABLE})
TOOLING_REASONS = frozenset({REASON_TOOLING_DIR, REASON_TOOL_CONFIG})


def tooling_line(n: int) -> str:
    """Строка пояснений сводки: сколько записей кода ушло в подсказки (ТЗ §13.1)."""
    return (
        f"Записей кода из служебных каталогов и конфигов инструментов: {n}, в факты они не"
        " записаны, перечень в agent/hints.yaml."
    )


def os_variables_line(n: int) -> str:
    return (
        f"Переменных операционной системы и CI: {n}, параметрами они не считаются, перечень"
        " в agent/hints.yaml."
    )
