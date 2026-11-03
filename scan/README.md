# Сборщик фактов ArchMap (scan/)

Документ для разработчика. Что и зачем делаем, решено в ТЗ эпика
[docs/tasks/fact-collector.md](../docs/tasks/fact-collector.md); здесь только как этим
пользоваться и как это устроено.

## Что это

Один файл `archmap-scan.pyz`, который человек, агент или CI запускают в своём
репозитории. Сборщик читает манифесты развёртывания и сборки, миграции и примеры
окружения и пишет каталог файлов в форматах, которые ArchMap уже ввозит: `schema.yaml`
(контейнеры, базы данных, брокеры, связи из манифестов), `facts/*.yaml` (таблицы и
параметры конфигурации), отчёт о покрытии и сводку, а для агента основания каждой записи и
подсказки. Сборщик не выполняет код репозитория, не ходит в сеть, не пишет никуда, кроме
каталога вывода, и не выдумывает: описаний, подписей со смыслом и ролей сверх словаря нет,
у каждой записи есть основание «файл:строка». Чего сборщик не умеет, он называет в отчёте
о покрытии статусом семьи, а не молчанием.

## Окружение

```bash
python3 -m venv scan/venv
scan/venv/bin/pip install -r scan/requirements-dev.txt
```

Рантайм-зависимость одна: PyYAML (пин как у `mcp/` и бэкенда). Код обязан работать на
Python 3.10: ruff и mypy проверяют именно эту версию (`scan/pyproject.toml`).

## Гейт

```bash
( cd scan && ./venv/bin/ruff check . && ./venv/bin/mypy && ./venv/bin/python -m pytest -q )
```

Тот же гейт гоняет pre-commit при правке файлов `scan/`. Фикстуры (`scan/fixtures/`) это
чужой код для разбора: ruff, mypy и pytest их не трогают, сборщик их только читает.
Покрытие: `./venv/bin/python -m pytest -q --cov --cov-report=term-missing`.

## Запуск из исходников

```bash
scan/venv/bin/python -m archmap_scan ПУТЬ --out /tmp/archmap-scan
scan/venv/bin/python -m archmap_scan --help
```

Тесты на деревьях внутри репозитория ArchMap запускают сборщик с `--no-git`: иначе корнем
git окажется сам ArchMap, и пути в выводе будут от его корня.

## Сборка файла

```bash
python3 scan/build.py            # → scan/dist/archmap-scan.pyz, печатает размер и sha256
python3 scan/build.py --out ПУТЬ
python3 -I -S scan/dist/archmap-scan.pyz scan/fixtures/yarmarka --out /tmp/y --no-git
```

`build.py` кладёт в архив пакет `archmap_scan`, чистую Python-часть PyYAML из
site-packages того интерпретатора, которым запущен (без `_yaml*.so`, `__pycache__` и
`dist-info`), текст лицензии PyYAML, если он есть в метаданных пакета, и `__main__.py`.
Даты и права записей одинаковые, записи отсортированы: одинаковые исходники и одна версия
PyYAML дают одинаковый sha256. Запуск с `-I -S` проверяет, что файлу не нужно ничего вне
архива. `scan/dist/` в `.gitignore`.

## Фикстуры и ожидаемый вывод

`scan/fixtures/<разборщик>/` — малые деревья на каждый разборщик, у яруса кода — с
ловушками: файл в `tests/`, строка в комментарии, имя выражением. `scan/fixtures/yarmarka/` —
синтетический монорепо по ТЗ §9 с ловушками в `tests/`, `docs/` и `.archmapignore`, а в коде
сервисов — маршрут и топик выражением и секрет с дефолтом; его
полный вывод лежит в `scan/fixtures/yarmarka.expected/`, тест сравнивает байт в байт.
После осознанной правки вывода:

```bash
( cd scan && UPDATE_SCAN_EXPECTED=1 ./venv/bin/python -m pytest -q tests/test_yarmarka.py )
git diff scan/fixtures/yarmarka.expected/   # это ревью правки; коммитить вместе с ней
```

## Устройство

- `cli.py` — ключи и коды выхода; `scan.py` — конвейер «контекст → обход → разборщики →
  сборка → вывод».
- `context.py` — корень, область, адрес origin и коммит; единственная внешняя команда —
  git из перечня `GIT_COMMANDS`. `walk.py` — обход, соглашения, `.archmapignore`, пределы
  чтения файлов.
- `parsers/*.py` — по модулю на источник, функция `parse(files, ctx) -> Findings`;
  `registry.py` — реестр разборщиков по семьям, по нему же считается покрытие.
- `assemble.py` и `owners.py` — объекты, связи, отнесение таблиц и параметров к владельцу;
  `vocab.py` — словари образов, фреймворков и ролей; `secrets.py` — что из значений можно
  писать.
- `yamlload.py`, `tomlite.py`, `sqlddl.py`, `pyast.py` — чтение YAML, TOML, SQL DDL и Python
  с пределами против враждебного входа.
- Ярус кода: маршруты `fastapi`, `flask`, `djangourls`, `express`, `nest`, `gohttp`, параметры
  `pyenv`, `nodeenv`, `goenv`, каналы `celery`, `kafka`, `rabbitmq`, `nats`, расписания `celerybeat`,
  `crontab`; файлы по стеку пакета — `codebase.py`, владельцы записей — `codefacts.py`.
- `output/` — писатели `schema.yaml`, `facts/`, `agent/`, `coverage.yaml`, `summary.txt` и
  маркера каталога; `texts.py` — все строки для людей.
