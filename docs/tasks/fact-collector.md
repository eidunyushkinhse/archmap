# Сборщик фактов (эпик, после релиза, 2026-11-03)

Ветка `feat/fact-collector`, слияние в main через `--no-ff`. Эпик идёт после релиза: записи в
tasks.md «АВТОМАТИКА ПЕРЕД АГЕНТОМ» и «ПЕРЕСОБРАТЬ ЭТАЛОНЫ» (сомнение владельца про
bullshit-proof эталоны). Обсуждение с владельцем 2026-11-02…03, решение владельца 2026-11-03:
«Сборщик одним файлом, пиши ТЗ на нулевую версию».

## 0. Решения владельца и границы

- BYOA полагается на агента даже там, где хватает автоматики. Сборщик фактов вытаскивает из
  репозитория пользователя всё, что не требует суждения: единицы развёртывания, базы, брокеры,
  зависимости, структуру таблиц из миграций, параметры конфигурации, каналы брокера, точки
  входа. Агент получает скелет и факты, а сам делает то, что автоматикой не вытащить: смысл,
  границы контейнеров, имена, описания, подписи связей, непокрытые стеки.
- Форма: **один файл** `archmap-scan.pyz`, который отдаёт сам сервер ArchMap. Агент запускает
  его первым шагом промпта (фаза 3), пользователь без агента запускает руками, CI запускает
  как шаг пайплайна. Ставить на машину ничего не нужно, кроме Python 3.
- Сервер ArchMap код пользователя не получает ни в одном сценарии. Сборщик работает там, где
  лежит репозиторий, и отдаёт файлы в тех форматах, которые ArchMap уже ввозит.
- Нулевая версия (этот документ, фазы 1а…1в) не трогает промпты агенту и интерфейс. Её
  результат ввозится сегодняшними окнами и инструментами. Интеграция с агентом (шаг промпта,
  инструмент MCP, пометки «по сборщику» в превью) идёт отдельной фазой после замера на
  эталонах, потому что любая правка промпта проверяется замером.
- Редкий стек: сборщик отдаёт ярус манифестов, семьи кода помечает «не покрыто», агент
  работает по ним как сегодня. Хуже, чем сегодня, не становится ни для кого.

## 1. Путь пользователя (куда идём, не всё в нулевой версии)

Описано владельцу 2026-11-03, коротко:

- Новый проект: «Построй схему системы по этому репозиторию и создай проект «Ярмарка»».
  Агент запускает сборщик, читает его сводку («покрыто / не покрыто / исключено»), по скелету
  проверяет границы и дописывает смысл, показывает план. Потом «Структура БД, каналы и
  конфигурация по сборщику готовы. Записать?».
- Обновление: «Обнови схему проекта «Ярмарка» по свежему коду». Сканерная часть сравнения
  детерминирована, агент читает код только для нового и непокрытого. Запуск без изменений
  в коде даёт пустой план.
- Без агента: скачать файл с ArchMap, запустить, ввезти `schema.yaml` в окне **Новый проект**
  способом **Импорт**, файлы фактов окнами фактов. Скелет без описаний и без исходящих связей.
- Служебный контур с запретом стороннего ПО на устройстве: тот же файл запускает CI на образе
  ArchMap, который компания уже зеркалирует (фаза 4, не здесь).

В нулевой версии из этого работает путь «без агента» и ручной запуск сборщика агентом по
просьбе пользователя.

## 2. Инварианты сборщика

1. **Чистая функция «каталог репозитория → каталог файлов».** Без сети, без выполнения кода
   репозитория (Python разбирается через `ast`, никаких `import` чужих модулей), без записи
   куда-либо, кроме каталога вывода. Единственная внешняя команда: `git` с фиксированными
   аргументами (список файлов, адрес origin, хэш HEAD); без git работает обход каталога.
2. **Детерминизм.** Один и тот же каталог и одна версия сборщика дают байт в байт одинаковый
   вывод. Порядок везде отсортирован, времени и случайных значений в выводе нет.
3. **Молчание не двусмысленно.** У каждой семьи фактов в отчёте один из статусов: `covered`
   (разборщики запускались, найдено N), `empty` (разборщики запускались, не найдено ничего),
   `unsupported` (стек опознан, разборщика нет: назван стек), `unknown` (стек не опознан).
   «Маршрутов нет» и «маршруты не умею» выглядят по-разному.
4. **Ничего не выдумывает.** Каждая запись вывода имеет основание `файл:строка` в
   `agent/evidence.yaml`. Описаний, подписей со смыслом и ролей сверх словаря сборщик не пишет:
   поле остаётся пустым, его заполняет агент или человек.
5. **Ничего не выбрасывает молча.** Исключённые каталоги, неразобранные файлы, динамические
   имена, неотнесённые записи перечислены в отчёте с числами и примерами.
6. **Секреты не пишутся.** Файлы `.env`, `.env.local`, `.env.production` и любые без суффикса
   `example|sample|template|dist` не открываются вовсе. Исключение (§15 п. 12 С13, решение
   судьи, владелец может отменить): закоммиченный в git `.env` рядом с файлом compose
   читается только для подстановки переменных в поля compose. Из примеров берутся имена; значение
   пишется как дефолт только если имя не похоже на секрет (`PASSWORD|SECRET|TOKEN|KEY|DSN|
   PRIVATE|CREDENTIAL|URL` с учётными данными) и значение не похоже на ключ (длинная
   случайная строка, строка подключения с паролем).
7. **Форматы вывода равны форматам ввоза ArchMap.** `schema.yaml` в формате единого ввоза
   (`nodes`/`edges`/`source`), файлы фактов в формате пакетов «Доки от агента» с первой
   строкой `# archmap-node: …`. ArchMap ради сборщика в нулевой версии не меняется; неизвестные
   ключи ввоз игнорирует, поэтому дополнительные ключи сборщика допустимы, но в нулевой
   версии их нет: основания лежат отдельно в `agent/`.
8. **Тексты по правилам продукта.** Сводка и сообщения сборщика читает пользователь:
   слова продукта («объект», «контейнер», «спецификация»), без «, —», тире только по
   грамматике, без многоточий, без имён панелей и внутреннего словаря. Все такие тексты
   лежат в одном модуле `texts.py`, по нему проходит сторож из CLAUDE.md.
9. **Версия.** У сборщика своя версия `archmap_scan.__version__` (нулевая: `0.1.0`), она
   печатается в шапке каждого файла вывода и отдаётся сервером вместе с файлом.

## 3. Форма и поставка

- Код: новый верхний каталог `scan/`: пакет `archmap_scan/`, `tests/`, `fixtures/`,
  `requirements.txt` (PyYAML тем же пином, что mcp и backend), `requirements-dev.txt`
  (pytest, ruff, mypy теми же пинами, что `mcp/requirements-dev.txt`), `pyproject.toml`
  (ruff и mypy; `target-version`/`python_version` **3.10**), `build.py`, `README.md`.
- Совместимость: синтаксис и стандартная библиотека в пределах Python 3.10 (на машине
  пользователя Python новее не обещан). Зависимость одна: PyYAML, чистая Python-реализация
  кладётся внутрь файла (`yaml/` без `_yaml*.so` и `*.dist-info`).
- Сборка файла: `python3 scan/build.py` собирает `scan/dist/archmap-scan.pyz` средствами
  `zipapp` (точка входа `archmap_scan.cli:main`, shebang `/usr/bin/env python3`), копируя
  пакет `yaml` из site-packages того интерпретатора, которым запущен скрипт. Один скрипт на
  три поставки: Dockerfile (после `pip install` стадии бэкенда, результат в
  `/opt/archmap/scan/archmap-scan.pyz`), `deploy/build-bundle.sh` (в `backend/../scan/` стейджа,
  рядом с `backend/`), `./dev.sh` (собирает, если файла нет или исходники новее). Желательно
  воспроизводимо (фиксированные даты записей zip), минимум: `build.py` печатает размер и sha256.
- Раздача сервером: `GET /api/v1/scan/archmap-scan.pyz` без аутентификации (как `/health`;
  содержимое публичное, AGPL), `Content-Type: application/octet-stream`,
  `Content-Disposition: attachment; filename="archmap-scan.pyz"`, `ETag` по sha256,
  `Cache-Control: no-cache`, заголовок `X-ArchMap-Scan-Version`. `GET /api/v1/scan` отдаёт JSON
  `{version, sha256, size}`. Путь к файлу: настройка `scan_file` в `app/config.py` (по умолчанию
  `../scan/dist/archmap-scan.pyz` от `backend/`, в образе `/opt/archmap/scan/archmap-scan.pyz`,
  в серверной поставке соответствующий путь релиза). Файла нет: 404 с текстом «Сборщик фактов в
  эту поставку не входит». Демо-режим раздачу не запрещает. nginx поставки ничего нового не
  требует (`/api/` уже идёт в бэкенд), `standalone.py` тоже.
- Запуск пользователем: `python3 archmap-scan.pyz [ПУТЬ] [--system ИМЯ] [--out КАТАЛОГ]
  [--exclude ШАБЛОН]… [--include ШАБЛОН]… [--no-git] [--json] [--version]`. Справка на русском.
  Коды выхода: 0 успех (даже если найдено мало), 1 ошибка (пути нет, каталог вывода занят чужими
  файлами, разбор упал). Падение одного разборщика не валит запуск: семья получает статус
  `error` с текстом, остальное пишется.

## 4. Вход

- `ПУТЬ` (по умолчанию текущий каталог) должен быть корнем репозитория или его подкаталогом;
  корень git определяется через `git rev-parse --show-toplevel`, без git корень равен `ПУТЬ`.
  Обход всегда ограничен `ПУТЬ`; git даёт семантику `.gitignore`, адрес origin и HEAD. Пути в
  выводе (`source.path`, evidence) относительны корня git, чтобы совпадать с тем, что пишет
  агент; без git относительны `ПУТЬ`. Ключ `--no-git` отключает git полностью (тесты на
  фикстурах внутри репозитория ArchMap запускаются с ним, `repo` и `commit` тогда пусты).
- Перечень файлов: `git ls-files -z --cached --others --exclude-standard` (учитывает
  `.gitignore`), без git обход каталога с встроенным списком пропусков: `.git`, `node_modules`,
  `vendor`, `dist`, `build`, `target`, `.venv`, `venv`, `__pycache__`, `.tox`, `.mypy_cache`,
  `.idea`, `.vscode`, `coverage`.
- Исключение по соглашению (всегда, независимо от git): сегменты пути `test`, `tests`,
  `__tests__`, `testing`, `spec`, `specs`, `testdata`, `fixtures`, `mocks`, `__mocks__`, `e2e`,
  `docs`, `doc`, `examples`, `example`, `samples`, `benchmarks`; имена файлов `test_*.py`,
  `*_test.py`, `*_test.go`, `*.test.*`, `*.spec.*`, `conftest.py`; compose-файлы с сегментом
  `test|ci|e2e` в имени. Исключённое перечисляется в отчёте по каталогам с числом файлов.
- Манифесты для разработки (находка фазы 1а на Grafana, `devenv/`): compose, Dockerfile,
  supervisor, systemd и k8s в пути с сегментом `dev`, `devenv`, `development`, `local`, `hack`,
  `contrib`, `sandbox`, `demo`, `playground`, `.devcontainer`, `vagrant`, `ci`, `test` (или с
  таким сегментом в имени файла) объектов в схему не дают: их сервисы уходят в `hints` с
  причиной «файл для разработки». Сами каталоги из обхода не исключаются: манифесты в них
  читаются ради подсказок. Код в каталогах с сегментом `dev`, `devenv`, `development`,
  `.devcontainer`, `vagrant`, `hack`, `playground`, `e2e` разборщики кода не читают
  (находка фазы 1б на Grafana: 439 маршрутов из `devenv/docker/blocks/*/main.go` в
  подсказках); семья получает `skipped: {dev_code: N}` по файлам. Сегменты `local`, `contrib`,
  `demo`, `ci`, `test`, `sandbox` на код не действуют: `src/sentry/demo_mode/` и песочница
  плагинов Grafana `pkg/services/pluginsintegration/sandbox/` рабочий код.
- Файл `.archmapignore` в корне репозитория и ключ `--exclude`: по шаблону на строку,
  синтаксис подмножества `.gitignore`: `*`, `**`, `?`, ведущий `/` привязывает к корню,
  хвостовой `/` означает каталог, строки с `#` и пустые пропускаются; отрицаний `!` нет.
  `--include` возвращает в обход каталог, исключённый соглашением (например `fixtures/`).
- Открываются только файлы, которые нужны какому-то разборщику по имени или расширению, не
  длиннее 2 МБ, в UTF-8 (ошибки декодирования заменяются). Всё остальное не читается.

## 5. Выход

Каталог `--out` (по умолчанию `./archmap-scan` в текущем каталоге). Если каталог существует и
в нём нет маркера `.archmap-scan`, сборщик отказывает (код 1) и просит другой путь; с маркером
перезаписывает целиком. В конце печатает путь и сводку.

```
archmap-scan/
  .archmap-scan            маркер владения каталогом
  summary.txt              сводка для человека и агента: что найдено, покрытие, как ввезти
  coverage.yaml            покрытие по семьям для машины (раздел 8)
  schema.yaml              скелет схемы в формате ввоза ArchMap
  facts/
    <контейнер>.config.yaml       # archmap-node: Система / контейнер  ·  config: […]
    <база>.tables.yaml            # archmap-node: Система / база      ·  tables: […]
    <брокер>.channels.yaml        # archmap-node: Система / брокер    ·  channels: […]
  agent/
    entrypoints.yaml       точки входа по контейнерам: маршруты, воркеры, расписания, потребители
    evidence.yaml          основания каждой записи schema и facts: список «файл:строка»
    hints.yaml             неопределимое и подсказки: depends_on сервис→сервис, динамические имена,
                           неотнесённые параметры, стеки без разборщика, найденные файлы OpenAPI
```

В ArchMap ввозятся `schema.yaml` и `facts/`. Каталог `agent/` читает агент (и человек), ArchMap
его не ввозит. Имена файлов в `facts/` строятся из имени объекта транслитерацией латиницей,
чтобы файлы одинаково назывались на любой ОС.

### 5.1 `schema.yaml`

- Корень: один объект-система с именем `--system`, иначе имя из корневого манифеста сборки
  (`name` в package.json, `[project].name` в pyproject.toml, последний сегмент `module` в go.mod),
  иначе имя каталога репозитория. `element: system`. Описания нет.
- Дети корня: контейнеры (`shape: service`), базы (`shape: database`), брокеры (`shape:
  broker`) по разделу 6.1. Компонентов, внешних систем (SaaS) и людей сборщик не создаёт.
- У каждого объекта: `name` как в манифесте дословно; `technology` по словарю (раздел 6.5);
  `role` из короткого словаря: «сервис», «фронтенд», «воркер», «БД», «кэш», «брокер», «прокси»,
  «хранилище», «планировщик»; `status: existing`; `description` пустое (ключ не пишется).
- `source`: `repo` из адреса origin (как есть, нормализует ArchMap), `path` по каталогу кода
  контейнера (контекст сборки compose, каталог Dockerfile, каталог сервиса в монорепо), `host`
  по имени сервиса compose или k8s Service. Правила: `repo`+`path` ставятся только тем
  контейнерам, у которых каталог кода свой и ни с кем не совпадает; контейнеры, собранные из
  одного каталога (web и worker из одного Dockerfile), получают только `host` и запись в
  `hints.yaml`. Базам и брокерам только `host`. Корню `source` не нужен. Код в корне
  репозитория у единственного контейнера: `repo` без `path`. `path` ставится только на
  каталог, который есть в обходе (контекст сборки compose, указывающий в никуда, уходит в
  `hints`). Контейнер из Dockerfile с суффиксом (`Dockerfile-postgresql`, `worker.Dockerfile`)
  каталогом кода не владеет: вид и технология только по `FROM`, `repo`/`path` и стек корня
  ему не достаются.
- `edges`: только то, что видно в манифестах и литералах кода (раздел 6.3); подписи из словаря:
  «использует» (база, кэш, хранилище, сервис по адресу из конфигурации), «публикует»
  (сервис → брокер) и «доставляет» (брокер → сервис, как в примере промпта ввоза «доставляет
  новые заказы»: подпись называет действие источника связи, поэтому «потребляет» у стрелки
  из брокера читалось бы наоборот), `technology` по виду цели («PostgreSQL», «Kafka»,
  «HTTP»), `channel` у связей с брокером дословно, `sync: false` у связей по каналу.
  Направление: от того, кто обращается. Одна пара и один канал: одна связь.
- Ввоз покажет замечания «без единой связи» у контейнеров, связи которых сборщик не увидел.
  Это ожидаемо и в сводке объяснено: связи дописывает агент или человек.

### 5.2 `facts/`

Форматы ровно те, что в промптах семей (`backend/app/*_prompt.py`, снимки
`backend/tests/snapshots/prompts/{data,channels,config}--builder.txt`): `tables` с
`columns` (`name`, `type`, `pk`, `required`, `references`, `schema`), `channels` (`name`,
`kind`, остальное только из кода), `config` (`name`, `type`, `required`, `default`,
`description` пустое). Адрес владельца первой строкой `# archmap-node: <Система> / <объект>`
именами из `schema.yaml`. Записи без владельца в `facts/` не пишутся, а идут в `hints.yaml`
(раздел 7). Значения с «: » внутри в двойных кавычках, как требуют промпты.

### 5.3 `agent/`

- `entrypoints.yaml`: по контейнеру список `http` (`method`, `path`, `file`, `line`,
  `framework`), `workers` (команда запуска из Procfile/compose/supervisor, очереди из её
  аргументов), `schedules` (Celery beat, crontab, CronJob: имя, расписание, задача),
  `consumers` (канал, файл, строка). Одинаковые записи (метод, путь, источник) пишутся один
  раз: Zulip подключает `i18n_urls` дважды, маршрут от этого не удваивается.
- `evidence.yaml`: ключи вида `nodes/<путь объекта>`, `edges/<from>→<to>[#channel]`,
  `tables/<база>/<таблица>`, `channels/<брокер>/<канал>`, `config/<контейнер>/<имя>`, каждому
  список строк `файл:строка` (для манифестов строка ключа). Этот файл и есть основание для
  «bullshit-proof» эталона: запись без основания в выводе невозможна по построению.
- `hints.yaml`: разделы `depends_on` (пары сервис→сервис из compose, в связи не попали),
  `dynamic_names` (места, где имя канала или переменной не литерал), `unassigned`
  (параметры, таблицы, каналы без владельца с причиной), `unsupported` (опознанные стеки без
  разборщика), `openapi_files` (пути найденных файлов OpenAPI), `profiles` (сервисы compose под
  `profiles:` или только в dev/local-файлах). У каждой записи любого раздела один набор
  ключей: `kind`, `name`, `reason`, `source`, при необходимости `object` или `container`;
  подсказку читает и машина. За общими ключами идут поля записи, когда они известны (ч. 5,
  П3): `method` у маршрута, если регистрация называет метод (ANY не пишется), `schedule` и
  `task` у расписания, такие же, какие были бы у записи (выражение как написано у
  расписания из конфигурации или переменной, настоящее расписание у расписания без
  владельца); пустые не пишутся.

## 6. Разборщики нулевой версии

Каждый разборщик: отдельный модуль `archmap_scan/parsers/<имя>.py` с одной функцией
`parse(files, ctx) -> Findings`, без состояния, покрыт тестами на фикстуре. Реестр разборщиков
по семьям один (`registry.py`), по нему же считается покрытие.

### 6.1 Ярус 1, манифесты (не зависят от языка)

| Источник | Что берёт | Куда кладёт |
|---|---|---|
| `docker-compose*.y*ml`, `compose*.y*ml` (все, кроме исключённых соглашением; `extends`/`include` не раскрываются, в hints) | сервисы: имя, `image`, `build.context`/`dockerfile`, `command`, `depends_on`, ключи `environment` (имена; значения только для адресов зависимостей), `ports`, `profiles` | объекты (вид по образу, раздел 6.5), `host` = имя сервиса, связи по адресам из `environment` (`postgres://db:5432`, `REDIS_HOST=redis`, `http://orders:8080` → объект с таким `host`), связи по `depends_on` только к базам и брокерам, пары сервис→сервис в hints; параметры: имена из `environment` контейнера в семью config без дефолтов; у сервиса с образом прокси (nginx, HAProxy, Caddy, Traefik, Envoy) файлы томов из репозитория и многострочные значения `environment`: `upstream { server }` и `proxy_pass` nginx, `reverse_proxy` Caddy, `server` в `backend`/`listen` HAProxy дают связи прокси → объект с этим `host`, технология HTTP (ч. 3, Ж3); сервис с образом из переменной или своим тегом — прокси и по базовому образу последней стадии своего Dockerfile, конфигурация берётся и из `COPY`/`ADD` последней стадии внутри контекста сборки (Envoy `*.yaml`, nginx `*.conf`, `Caddyfile`, `haproxy.cfg`), Envoy — адреса кластеров `static_resources.clusters[]` (`load_assignment` и `hosts`) с подстановками `${VAR}` из окружения единицы и закоммиченного `.env` (ч. 5, С1) |
| `Dockerfile*` | базовый образ (`FROM`) → язык/рантайм; каталог файла → каталог кода контейнера; `CMD`/`ENTRYPOINT`; `ARG X` с `cargo build --bin $X` при Cargo.toml с `[workspace]` в том же каталоге → член workspace с `src/main.rs` (ч. 3, И1) | `technology`, `source.path`, команда для `entrypoints`; контейнер на бинарный крейт (имя из `[package] name`, каталог крейта, Rust), склейка по имени с сервисом compose или k8s |
| `Procfile` | `имя: команда` | контейнер на строку: `web` → «сервис», остальные → «воркер»/«планировщик» по слову в команде (`worker`, `consumer`, `beat`, `scheduler`, `cron`); каталог Procfile — каталог кода процессов, если рядом нет контейнера со своей сборкой: тогда код у контейнера сборки, а процесс даёт воркеры, расписания и связи (§15 п. 13 Д10) |
| supervisor: `*.conf`, `*.conf.template*`, `*.ini` с секциями `[program:имя]` (включая шаблоны erb/jinja, разбор построчно) | имя программы, `command`, `numprocs` | контейнер на программу; очереди из аргументов команды в `entrypoints.workers` |
| systemd `*.service` | `Description`, `ExecStart` | контейнер на юнит |
| k8s без шаблонов: `*.y*ml` с `apiVersion`+`kind` в `Deployment\|StatefulSet\|DaemonSet\|Job\|CronJob\|Service\|ConfigMap\|NetworkPolicy` (несколько документов в файле) | имя, образы контейнеров пода, `env`/`envFrom` (имена), `schedule` у CronJob, имя Service; у NetworkPolicy поды `spec.podSelector`, `ingress.from[].podSelector`, `egress.to[].podSelector` (ч. 3, Ж1); значение `valueFrom.configMapKeyRef` из `data` ConfigMap того же файла, каталога или ближайшего предка, встроенные патчи `kustomization.yaml` (`patches[].patch`, `patchesStrategicMerge`) с `kind` и `metadata.name`, слитые с нагрузкой того же имени (ч. 3, Ж2) | объекты, `host` = имя Service (сопоставление по `selector`/`metadata.name`), расписания в `entrypoints.schedules`, параметры в config; связи «использует» источник ingress → под политики и под политики → цель egress по метке `app.kubernetes.io/name` или `app` шаблона Deployment/StatefulSet, без канала и sync, та же пара из env — одна связь |
| Helm: `Chart.yaml`, `values.yaml` | имя чарта, образы в values (`image.repository`) | объекты по образам; `templates/` не разбираются (Go-шаблоны), в coverage `partial` с пояснением |
| манифесты сборки: `package.json`, `pyproject.toml`, `requirements*.txt`, `Pipfile`, `go.mod`, `Cargo.toml`, `pom.xml`, `build.gradle*`, `Gemfile`, `composer.json`, `mix.exs` | имя пакета, зависимости (имена, без версий), workspaces/монорепо | `technology` контейнера (язык + фреймворк по словарю 6.5), опознание стека для статусов `unsupported`, клиентские библиотеки как подсказка вида зависимости (драйвер Postgres, клиент Kafka) |
| `.env.example`, `.env.sample`, `.env.template`, `.env.dist`, `env.example` | имена, значения как дефолты по инварианту 6 | семья config контейнера, к которому отнесён файл (раздел 7) |
| файлы OpenAPI: `openapi*.y*ml\|json`, `swagger*.y*ml\|json` с ключом `openapi:`/`swagger:` | путь, число операций; операции (метод, путь, строка ключа), `info.title`, `servers[].url` (ч. 3, З3) | `hints.openapi_files`; содержимое не ввозится (в ArchMap спецификация живёт в разделе «OpenAPI» объекта и едет пакетом доков, это фаза 3); операции — маршруты `entrypoints.http` сервиса-владельца, если он определим механически (§15 п. 14 З3) |

### 6.2 Ярус 2, код (по фреймворкам)

| Семья | Стек | Что ищет (только литералы) |
|---|---|---|
| маршруты HTTP → `entrypoints.http` | Python: FastAPI/Starlette (`@app.get("/p")`, `@router.post`, `APIRouter(prefix=)`, `include_router(r, prefix=)` в пределах одного файла и по импорту имени из того же репозитория), Flask (`@app.route`, `@bp.route`, `Blueprint(url_prefix=)`, `add_url_rule`), Django (`urls.py`: `path`, `re_path`, `url`, вложенные `include()` по модулю, DRF `router.register(prefix, ViewSet)` → `/prefix/` и `/prefix/{id}/`) | `ast`: декораторы и вызовы с литеральным первым аргументом; метод из имени; префиксы складываются, нерешённый префикс помечается `prefix_unresolved: true` |
| | Node: Express/Koa-router/Fastify (`app.get('/p'`, `router.post(`, `app.use('/prefix', router)` в одном файле), NestJS (`@Controller('prefix')` + `@Get('p')`, префикс членом строкового `enum` репозитория `@Controller(Имя.Член)`, ч. 4, К4) | регулярные выражения по строкам без оглядки назад, литералы в одинарных, двойных и обратных кавычках без подстановок |
| | Go: `net/http` (`http.HandleFunc("/p"`, `mux.Handle(`), gorilla, chi (`r.Get("/p"`), gin/echo/fiber (`r.GET("/p"`, `e.POST(`), группы `r.Group("/v1")` в одном файле; `имя + "/p"` на известном маршрутизаторе — путь литерала с `prefix_unresolved`, `"/a" + "/b"` — путь целиком, методы `.Methods(http.MethodGet)` (ч. 4, К5); запрос клиента не маршрут: `http.Get(url)`, `http.Post`, `http.Head` и глагол с одним аргументом без цепочки за скобкой (`api.Get(url)`), а построитель go-restful `ws.GET("/p").To(h)` маршрут (ч. 5, П4) | регулярные выражения |
| | Ruby: Rails (`config/routes.rb` и `config/routes/*.rb` пакета с rails или railties): `get`/`post`/`put`/`patch`/`delete 'путь'` и `:действие`, `match` с `via:`, `root`, `resources`/`resource` (стандартные операции, `only:`, `except:`, `path:`, `param:`), `member`/`collection` и `on:`, вложенные ресурсы под `/имя/:имя_id`, `namespace` и `scope` (префикс), `concern`/`concerns`, `draw(:имя)` — файл `config/routes/имя.rb` на месте вызова (ч. 4, К1); необязательная группа в круглых скобках в пути не пишется, `devise_for` по модулям `devise` модели (`app/models/<имя>.rb`, `path:`, `path_names:`, `skip:`, `only:`, `sign_out_via:`), `shallow: true` и блок `shallow do` (ч. 5, П6) | построчно по маске Ruby, стек блоков `do` … `end`; `mount` и путь с подстановкой `#{…}` в hints; модуль devise без известного набора и модель без `devise` в hints, провайдеры omniauth не раскрываются (`/имя/auth/:provider`) |
| | .NET: ASP.NET Core (`*.csproj` с `Sdk="Microsoft.NET.Sdk.Web"`, `Microsoft.AspNetCore.*` или `<FrameworkReference Include="Microsoft.AspNetCore.App" />`, ч. 5, П5): `app.MapGet("/p"`, `MapPost`, `MapPut`, `MapDelete`, `MapPatch`, `MapMethods("/p", new[] { "GET" })`, `MapHealthChecks("/p")` как GET, группа `var g = app.MapGroup("/v1")` в одном файле; контроллеры (`[ApiController]` или наследник `Controller`/`ControllerBase`): `[Route("api/[controller]")]` класса и `[HttpGet("x")]`, `[Route("x")]` метода, `[controller]` и `[action]` (ч. 4, К2); маршрут по соглашению по шаблону того же проекта: `MapDefaultControllerRoute()` (`{controller=Home}/{action=Index}/{id?}`), `MapControllerRoute` с `pattern:` или вторым литералом, первый шаблон без `{area` (ч. 5, П5) | по маске C#; группа или `[Route]` не литералом и путь `$"…{x}…"` в hints; `{controller}` и `{action}` шаблона подставляются, `{x?}` отбрасывается; шаблона нет или он не литерал — `/Контроллер/действие` с `prefix_unresolved: true` |
| | Rust: actix-web (`Cargo.toml` с actix-web): `.route("/p", web::get().to(h))` и другие методы (`web::method`, `web::to` — ANY), `web::resource("/p").route(web::get()…)` и `.to(h)`, `web::scope("/v1")` с вложенными `.service(web::scope(…))`, `#[get("/p")]` и `#[route("/p", method = "GET")]` над `fn` (ч. 4, К3) | один проход по парным скобкам маски Rust; атрибут — путь без префикса; константа `const` файла раскрывается, `format!` и переменная в hints |
| | Java и Kotlin: Spring MVC и WebFlux (пакет с артефактом `spring-boot*`, у Gradle плагин `org.springframework.boot`; ч. 5б, К1): класс с `@RestController` или `@Controller`, префикс `@RequestMapping("/x")`, `value =`, `path =`, массив `{"/a", "/b"}` (Kotlin `[…]`) по маршруту на элемент; методы `@GetMapping`, `@PostMapping`, `@PutMapping`, `@DeleteMapping`, `@PatchMapping`, `@RequestMapping(method = {RequestMethod.GET, …})`, без `method` ANY; префикс приложения `server.servlet.context-path` или `spring.webflux.base-path` из `application.yml`/`.properties` модуля | по маске Java и Kotlin одним проходом по парным скобкам; интерфейсы (`@FeignClient`) не читаются; ведущая косая добавляется, `{id:regex}` пишется `{id}`; константа класса раскрывается, выражение и шаблон Kotlin с `$` в hints; префикс приложения с `${` — `prefix_unresolved: true` |
| параметры конфигурации → `facts/*.config.yaml` | Python: `os.getenv("X", default)`, `os.environ["X"]`, `os.environ.get("X", default)`, классы `BaseSettings` (имя поля в верхнем регистре, дефолт из присваивания, `Field(alias=)`/`env=`), `decouple.config("X", default=)`, `environ.Env`, обёртки репозитория, читающие окружение по первому параметру (`get_from_env("X", d, type_cast=int)`), имя строковой константой модуля (ч. 3, Е2); Node: `process.env.X` (дефолт из `\|\| 'v'` и `?? 'v'` на той же строке), ключи схемы zod, применённой к окружению (`EnvSchema.safeParse(process.env)`, схема своего или импортированного модуля; тип по валидатору, `.default(литерал)`, перечень `z.enum` в описании; ч. 3, Е3); Go: `os.Getenv("X")`, `os.LookupEnv("X")`, `envconfig` теги `env:"X"`, обёртки репозитория, у которых строковый параметр уходит в `os.Getenv`/`os.LookupEnv`/`viper.BindEnv` (`env.StringFromEnv("X", "d")`, `mustMapEnv(&v, "X")`), и имя строковой константой пакета (`common.EnvGnuPGHome`; ч. 3, Е1); C# (`*.csproj`): `Configuration["X"]` и `configuration["X"]` (ключ `A:B` как написан), `Environment.GetEnvironmentVariable("X")`, дефолт литералом после `??`, `?? throw` — required; Java (`pom.xml`, `build.gradle`): `System.getenv("X")`, `System.getenv().get("X")`, дефолт из `getOrDefault("X", "d")`; у обоих тип по обёртке разбора (`Integer.parseInt`, `bool.TryParse`) и имя строковой константой (`static final`/`const`) того же файла, файла класса или статического импорта (ч. 3, Е4); Rust (`Cargo.toml`): `#[envconfig(from = "X", default = "v")]` (без `from` — имя поля в верхнем регистре; поле без атрибута в структуре с `#[derive(Envconfig)]` — тоже, обязательно, если не `Option<T>`, ч. 5, Р3), clap `#[arg(env = "X", default_value_t = …)]`, тип по типу поля, `std::env::var("X")`, `env::var_os("X")` с дефолтом из `.unwrap_or("v")`; `env!`/`option_env!` — переменная времени сборки в hints (ч. 3, И2) | тип по дефолту (`bool`/`int`/`duration`/`string`), `required` = нет дефолта и чтение через `[]`/`LookupEnv`/`Field(...)` без дефолта; один параметр из N мест чтения: одна запись, все места в evidence |
| | .NET: `appsettings.json` в каталоге проекта (рядом с `*.csproj`; не `appsettings.<Среда>.json` и не каталог тестов): ключ с вложением `A:B:C`, значение дефолтом как написано (массив одной строкой, `null` без дефолта), JSON с комментариями `//`, `/* */` и висячими запятыми; в коде C# `GetValue<T>("A:B")` и `GetValue<T>("A:B", дефолт)`, `GetConnectionString("x")` → `ConnectionStrings:x`, раздел `GetSection("A")` или `GetRequiredSection("A")` с `.Get<T>()`, `.Bind(obj)` (тип `obj` по объявлению в файле), аргументом `Configure<T>(раздел)` или `AddOptions<T>().Bind(раздел)`, `AddOptions<T>().BindConfiguration("A")` → `A:Свойство` по публичным свойствам с `set` или `init` класса `T` того же проекта (дефолт из инициализатора-литерала, `required` — обязателен); имя раздела литералом, константой или `nameof(T)`, переменная раздела ставит его перед ключом (ч. 5, Р1) | тип у файла по значению (`string`, `int`, `float`, `bool`, `array`), у кода по `T` и типу свойства; запись файла и чтение того же ключа — один параметр: дефолт из файла, тип из кода; файл больше 1 МБ или глубже 50 уровней непрочитан, класса нет — параметр `A` с типом `T` как написан, имя раздела выражением в hints |
| | hjson: `config/defaults.hjson` или `config/default.hjson` рядом с манифестом сборки пакета (`config.hjson` и другие имена не читаются; у Lemmy `config/defaults.hjson` рядом с `Cargo.toml`): ключ с вложением через точку (`database.pool_size`), значение дефолтом как написано (строка без кавычек, число, `true`/`false`; массив одной строкой; `null` без дефолта); комментарии `#`, `//`, `/* */`, ключи и строки без кавычек, `'''` многострочные, запятые необязательны (ч. 5, Р2) | тип по значению (`string`, `int`, `float`, `bool`, `array`); файл больше 1 МБ, глубже 50 уровней или больше 5000 ключей непрочитан с подсказкой в `unparsed`, ошибка синтаксиса — подсказка без записей |
| каналы брокера → `facts/*.channels.yaml` и связи с `channel` | Celery (`@app.task(queue="q")`, `@shared_task(queue=)`, `task_routes`, `Queue("q")` kombu, `apply_async(queue=)`, `task_default_queue`, аргументы `-Q q1,q2` в командах воркеров) → `kind: queue`; Kafka: kafka-python/confluent/aiokafka (`send("t"`, `produce("t"`, `KafkaConsumer("t"`, `subscribe([…])`), kafkajs (`send({ topic: 't'`, `subscribe({ topic: 't'`), Go sarama/segmentio (`Topic: "t"`) → `kind: topic`; RabbitMQ: pika (`queue_declare(queue="q")`, `basic_publish(exchange="e", routing_key="k")`, `basic_consume(queue="q")`), amqplib (`assertQueue('q')`, `sendToQueue('q'`, `consume('q'`) → `kind: queue`/`exchange`; NATS (`subscribe("s")`, `publish("s"`) → `kind: subject`; модуль-реестр констант по последнему слову имени файла `topics`/`queues`/`subjects` (`ИМЯ = "t"`, f-строка, `get_from_env(…, default="t")`; TypeScript `export const ИМЯ = 't'` в пакетах с kafkajs), голое `ИМЯ` в вызове клиента раскрывается по импорту (ч. 2, В1); BullMQ и Bull на Node.js (`new Queue('q')`, `@InjectQueue('q')` → публикация, `new Worker('q')`, `@Processor('q')` → потребление, `BullModule.registerQueue({ name: 'q' })` → объявление; `enum` с последним словом имени `queue`/`queues` или концом `QueueName(s)` → очереди без направления, `QueueName.X` раскрывается) → `kind: queue` брокера Redis (ч. 2, В2); Sidekiq на Ruby (`:queues:` в `config/sidekiq*.yml` → объявление, класс с `include Sidekiq::Worker`/`Sidekiq::Job` или наследник такого класса → потребление очереди `sidekiq_options queue:`, без неё `default`; владелец — контейнер, команда которого запускает sidekiq) → `kind: queue` брокера Redis (ч. 2, В3); реестр консьюмеров Kafka: словарь уровня модуля с последним словом имени `consumers` и ключом `topic` в значениях (`KAFKA_CONSUMERS = {"имя": {"topic": Topic.X, "dlq_topic": …}}`) → потребление `topic` и других ключей со словом topic, публикация `dlq_topic` и `stale_topic` процессом по ключу, объект процесса только из манифестов (ч. 2, В4) | имя дословно (у f-строки и шаблона литеральная часть); направление по вызову (publish → контейнер→брокер, consume → брокер→контейнер); поля сообщений не извлекаются (пусто); нелитеральное имя → `hints.dynamic_names` |
| воркеры и расписания → `entrypoints` | Celery beat (`beat_schedule`, `CELERYBEAT_SCHEDULE`, `@periodic_task`, `add_periodic_task` и обёртка над ним в файлах того же каталога, ч. 4, Л1), `crontab`-файлы и `cron.d/`, k8s CronJob (6.1), sidekiq-scheduler (`:scheduler: :schedule:` или `:schedule:` в `config/sidekiq*.yml`: `every`, `cron`, `interval`, `at`, `in`, задача `class`; контейнер, который запускает sidekiq; ч. 2, В3), sidekiq-cron (`config/schedule.yml`, `config/schedule.yaml`, `config/sidekiq_cron.yml`: запись верхнего уровня с `class` и `cron` или `every`, без sidekiq-cron в Gemfile только с `cron` и `class`; тот же владелец; ч. 5, П2), `node-cron`/`schedule`-литералы не ищутся; потребители `consumers` — каналы потребления из кода (классы Sidekiq, `new Worker` BullMQ, реестр `KAFKA_CONSUMERS` по объекту процесса) | имя, расписание как написано (вставки ERB остаются текстом, у списка первый элемент), задача; у потребителя канал, вид, брокер, основание |
| | Go: robfig/cron (`go.mod` с `github.com/robfig/cron`, файл с её импортом): `c.AddFunc("spec", f)`, `c.AddJob("spec", j)`, `c.Schedule(cron.Every(d), j)` (ч. 4, Л2) | расписание как написано, строковая константа файла раскрывается, выражение текстом, имя без значения в hints; имя и задача — функция или задание вторым аргументом, у литеральной функции `файл:строка` |
| | Rust: clokwerk (`Cargo.toml` с clokwerk): `scheduler.every(TimeUnits::minutes(5))`, `.every(1.hour())`, `.every(Interval::Daily).at("03:00")`, `.run(move || f(…))` (ч. 4, Л3) | расписание текстом аргумента every и at через пробел; имя и задача — первая свободная функция в теле run, без неё `файл:строка`; модуль тестов не читается |
| | Node: пакеты `cron` и `@nestjs/schedule` (`package.json`): `@Cron("expr")` и `@Cron(CronExpression.X)` над методом, `new CronJob("expr", f)`, объект `{ name, expression | cronTime, onTick }` (`create({ … })`, `CronJob.from({ … })`) (ч. 4, Л4) | выражение как написано, член `CronExpression.X` по словарю (`EVERY_HOUR` → `0 * * * *`), имя из `name:`, члена перечисления, имени метода или функции; выражение полем конфигурации или именем в hints |

### 6.3 Миграции → `facts/*.tables.yaml`

| Источник | Разбор |
|---|---|
| SQL DDL: `*.sql` в каталогах `migrations`, `migrate`, `db`, `sql`, `schema`, `database`, Flyway `V*__*.sql`, golang-migrate `*.up.sql`, Diesel `up.sql`, sqlx | токенизатор DDL ограниченной грамматики: `CREATE TABLE [IF NOT EXISTS] [схема.]имя (колонка тип [NOT NULL] [PRIMARY KEY] [REFERENCES т(к)] …, PRIMARY KEY (…), FOREIGN KEY (…) REFERENCES …)`, `CREATE TABLE имя AS SELECT …` (колонки по псевдонимам `AS имя` и именам колонок списка без типа, «*» и выражение без имени — подсказка; ч. 3, З2), `ALTER TABLE … ADD [COLUMN]`, `DROP COLUMN`, `RENAME [COLUMN]`, `DROP TABLE`, `ALTER TABLE … RENAME TO`; кавычки `"`, `` ` ``, `[]`; порядок файлов по имени (версии Flyway/golang-migrate по числу); `*.down.sql` пропускаются; непонятная инструкция пропускается со счётчиком в coverage |
| Alembic: каталог с `env.py` и `versions/*.py` | `ast`: `op.create_table("t", sa.Column("c", sa.Type(…), nullable=, primary_key=), sa.PrimaryKeyConstraint, sa.ForeignKeyConstraint, schema=)`, `op.add_column`, `op.drop_column`, `op.drop_table`, `op.rename_table`, `op.alter_column(new_column_name=, nullable=)`, `op.create_foreign_key`; порядок по цепочке `down_revision` (ветвления: объединение по `merge`-ревизиям; цикл или обрыв → `error` семьи с текстом); только функция `upgrade()`; `op.execute("…")` с DDL отдаётся SQL-разборщику |
| Django: `*/migrations/0*.py` | `ast`: `CreateModel(name=, fields=[(имя, models.Тип(null=, primary_key=, to=…))], options={"db_table": …})`, `AddField`, `RemoveField`, `DeleteModel`, `RenameModel`, `RenameField`, `AlterField(null=)`; имя таблицы `app_label + "_" + lower(model)` или `db_table`; `ForeignKey(to="app.Model")` → `references: таблица.id`; порядок по `dependencies` внутри приложения и между приложениями; `RunPython`/`RunSQL` пропускаются (счётчик) |
| Kysely и другие шаблоны `sql` в миграциях Node.js: `.ts`/`.js` в каталоге `migrations` любой глубины (ч. 3, З2) | шаблоны ``sql`…` ``, ``sql<Тип>`…` `` и ``sql.raw(`…`)`` вне тела функции `down` — текстом SQL в разбор DDL выше, файлы по имени с числами по значению, набор — каталог; читаются только CREATE, ALTER, DROP, RENAME; вставка `${…}` — заглушка: на месте имени таблицы или колонки в `hints.dynamic_names`, в типе колонки — текстом вставки; диалект по драйверу package.json (`pg`, `postgres` — PostgreSQL, `mysql2` — MySQL, `better-sqlite3` — SQLite), иначе по типам; построитель схемы (`db.schema.createTable`) не читается; ``sql.raw(`SQL`)`` в цикле `for (const { a, b } of СПИСОК)` или `for (const [a, b] of СПИСОК)` по массиву-литералу верхнего уровня того же файла читается для каждого элемента со значениями вместо `${a}` и `${b}`, переименование таблицы или колонки переносит ссылки на неё (ч. 5, М1) |
| Rails: `db/schema.rb` в любом каталоге (ч. 3, З1) | построчно, без исполнения Ruby: `create_table "т", id:, primary_key: do \|t\|` … `end`, `t.тип "к", null: false` (тип как написан), `t.references`/`t.belongs_to "x"` → `x_id` (`polymorphic: true` — ещё `x_type`), `t.timestamps` → `created_at`, `updated_at`, `add_foreign_key "из", "в", column:, primary_key:`; индексы, ограничения, `create_view` с heredoc, типы, функции и триггеры пропускаются, `enable_extension`/`create_schema` в `hints.unassigned`, прочее — пропуск со счётчиком; диалект по драйверу в Gemfile (`pg`, `mysql2`, `trilogy`, `sqlite3`); при `db/structure.sql` рядом читается только он; `db/migrate/` не читается |

Для не покрытых владельцем таблиц (раздел 7) записи идут в `hints.unassigned`.

### 6.4 Не в нулевой версии (в coverage как `unsupported` с именем стека, где стек опознан)

Prisma `schema.prisma` (Rails `schema.rb` читается с части 3, З1; `structure.sql` разбирает 6.3),
построитель схемы Kysely `db.schema.createTable` (шаблоны `sql` читаются с части 3, З2),
Liquibase (снят владельцем), Helm `templates/`, маршруты Laravel/Phoenix, Rust без actix-web и серверов JVM без разборщика (Ktor, Micronaut, Javalin, Vert.x, Helidon; Rails, ASP.NET Core и actix-web читаются с части 4, К1–К3, Spring с части 5б, К1),
планировщики в коде без разборщика (node-cron, node-schedule, Agenda, schedule, APScheduler, gocron,
tokio-cron-scheduler, whenever, rufus-scheduler, Clockwork, GoodJob, Solid Queue и другие; robfig/cron, clokwerk, пакеты cron и @nestjs/schedule читаются с части 4, Л2–Л4, sidekiq-cron с части 5, П2),
ключи viper и Spring `@Value`, параметры Kotlin, исходящие HTTP-вызовы в коде, компоненты,
внешние SaaS и люди, описания и подписи со смыслом, поля сообщений каналов, содержимое OpenAPI
(кроме операций как маршрутов владельца, ч. 3, З3), Redis/SQS/Pub/Sub как каналы, «мёртвый код»
и проверка «объявлено и подключено» (фаза 3: ярусы свидетельств), Terraform.

### 6.5 Словари (стартовые, пополняются по находкам, один модуль `vocab.py`)

- Образ → вид и технология: `postgres`→database «PostgreSQL», `mysql`→database «MySQL»,
  `mariadb`→«MariaDB», `mongo`→«MongoDB», `clickhouse`→«ClickHouse», `elasticsearch`→
  «Elasticsearch», `opensearch`→«OpenSearch», `redis`/`valkey`→database «Redis» (роль «кэш»;
  становится broker «Redis», если на него указывает `CELERY_BROKER_URL`/`BROKER_URL`/`RQ_*`),
  `memcached`→database «Memcached» (роль «кэш»), `minio`→database «MinIO» (роль «хранилище»),
  `rabbitmq`→broker «RabbitMQ», `kafka`/`cp-kafka`/`bitnami/kafka`→broker «Kafka»,
  `redpanda`→broker «Redpanda», `nats`→broker «NATS», `pulsar`→broker «Pulsar»,
  `zookeeper`→service «ZooKeeper» (роль «сервис»), `nginx`/`traefik`/`haproxy`/`envoy`→service
  (роль «прокси»), `mailhog`/`mailpit` → service. Неизвестный образ без `build` → service,
  `technology` = имя образа без тега. Слово словаря ищется и среди частей имени через дефис
  и подчёркивание (`clickhouse-posthog`, `timescaledb-ha`, `docker-redis-cluster`), кроме
  имён со словом программы вокруг базы (`client`, `exporter`, `ui`, `meta`…) и с двумя
  технологиями (§15 п. 14 И3).
- Базовый образ Dockerfile и манифест сборки → `technology`: «Python», «Node.js», «Go»,
  «Java», «Ruby», «PHP», «Rust», «.NET», «Elixir»; плюс фреймворк: fastapi→«FastAPI»,
  django→«Django», flask→«Flask», starlette, express→«Express», @nestjs/core→«NestJS», fastify,
  koa, next→«Next.js», react/vue/@angular/core/svelte → роль «фронтенд» при отсутствии
  серверного фреймворка, gin/echo/chi/fiber, spring-boot (pom/gradle), rails (Gemfile),
  laravel (composer.json), phoenix (mix.exs). Запись: «Python + FastAPI».
- Клиентские библиотеки → подсказка вида зависимости: psycopg/asyncpg/pg/pgx → PostgreSQL,
  mysqlclient/pymysql/mysql2 → MySQL, redis/ioredis → Redis, kafka-python/confluent-kafka/
  aiokafka/kafkajs/sarama → Kafka, pika/aio-pika/amqplib → RabbitMQ, celery → Celery, nats.

## 7. Отнесение к владельцу

- **Контейнер файла.** Каждый контейнер со своим кодом имеет каталог кода (контекст сборки
  compose, каталог Dockerfile, каталог сервиса в монорепо по workspaces/`services/*`). Файл
  принадлежит контейнеру с самым длинным каталогом-префиксом. Репозиторий без манифестов
  контейнеров: один неявный контейнер с именем корня (по манифесту сборки или каталогу), в
  coverage пометка «контейнер определён по репозиторию, не по манифесту». Файл вне каталогов
  всех контейнеров (общая библиотека) → записи в `hints.unassigned` с причиной «общий код».
  Единственный контейнер со своим каталогом кода владеет и кодом вне своего каталога (контейнеры
  на одних образах единственность не нарушают: Sentry с devservices), если язык файла
  совпадает с языком контейнера или язык контейнера не определён (находка фазы 1б на Sentry:
  `self-hosted` один, а 950 маршрутов и 165 параметров из `src/` остались без владельца);
  при двух и более контейнерах общий код остаётся без владельца. Процесс, заданный только
  командой (Procfile, `x-programs`, юнит systemd или supervisor без своего Dockerfile и
  образа), каталога кода не получает, если есть контейнер со своей сборкой того же языка
  (каталоги вложены) или без определённого языка, чья сборка охватывает каталог процесса:
  код и его факты остаются у контейнера сборки (§15 п. 13 Д10). Файл Go под
  `<каталог кода>/cmd/<имя>/` при двух и более программах `cmd/` в каталоге, из которых хотя
  бы одной соответствует контейнер, принадлежит только контейнерам этой программы (имя
  контейнера или программа его команды равны `<имя>`; программа команды совпадает и при
  конечной «s» у одного из имён, и как `<имя>-controller` или `<имя>-server` при имени
  контейнера с тем же хвостом, если в каталоге нет своей программы с именем команды, ч. 4,
  Н3); у программы без контейнера записи
  уходят в `hints.unassigned` с причиной «код программы из cmd/<имя>/, у которой нет
  контейнера в манифестах» (§15 п. 14 Ф1).
- **База для миграций.** Цепочка: (1) контейнер, владеющий каталогом миграций, и адрес базы в
  его `environment`/дефолтах → объект-база с таким `host`; (1а) владелец каталога есть, адреса
  базы в его окружении нет, а в файлах его манифестов (тот же файл compose, тот же каталог
  манифестов k8s или Helm) ровно одна реляционная база → она; владельцы в файлах с разными
  базами → дальше по цепочке (ч. 4, Н2); (2) единственная реляционная база в
  манифестах; (3) баз в манифестах нет, а миграции есть (Sentry, Zulip: база живёт в другом
  репозитории) → объект-база по признакам миграций: `technology` и имя по диалекту (Django
  `ENGINE` в настройках, URL в `alembic.ini`/`env.py`, типы `SERIAL`/`JSONB`/`AUTO_INCREMENT`
  в SQL), без `host`, в coverage пометка «база определена по миграциям, не по манифесту»;
  диалект не опознан → имя «База данных» без `technology`; (4) несколько реляционных баз и
  адрес не указывает ни на одну → `hints.unassigned` с причиной «несколько баз, владелец не
  определим». Сводка считает найденным только то, что записано в файлы: записи из
  `hints.unassigned` в «Найдено» не входят и называются отдельно.
- **Брокер для каналов.** Та же цепочка по виду брокера (Kafka-клиент → объект «Kafka»): адрес
  в конфигурации контейнера, единственный брокер этого вида, иначе `unassigned`. Celery без
  брокера в манифестах: брокер не создаётся, очереди в `unassigned` с причиной «брокер не
  найден в манифестах».
- **Контейнер для параметров.** По файлу чтения (контейнер файла); `environment` compose
  даёт владельца напрямую. Один параметр, прочитанный в нескольких контейнерах: по записи у
  каждого (правило продукта: владелец параметра контейнер, одинаковый параметр у двух
  контейнеров это две записи). Сводка в «Найдено» считает параметры по именам и отдельной
  строкой называет записи общего кода (Zulip: 26 имён, 140 записей у 8 контейнеров;
  «140 параметров» читалось бы как 140 разных); в coverage `found` остаётся числом записей,
  рядом `distinct` с числом имён, когда они расходятся.
- **Сервис для файла OpenAPI** (ч. 3, З3). Среди контейнеров с ролью «сервис»: файл в
  каталоге кода ровно одного из них; иначе среди сервисов, чей каталог кода содержит файл
  (нет таких — среди всех сервисов), ровно у одного имя или слово команды входит в путь
  файла, `info.title` или `servers[].url`. Файл в каталоге документации и файл чужого API (все
  адреса `servers` на внешних доменах) владельца не получают. Владелец не определим —
  `hints.openapi_files` с причиной и перечнем сервисов, среди которых он искался.
- **Команда через скрипт** (ч. 5, П1). Команда единицы (compose, k8s, Procfile, supervisor,
  systemd, CMD Dockerfile), чья программа — относительный путь к скрипту оболочки репозитория
  (`./bin/docker-worker-celery`; путь от контекста сборки, от каталога манифеста или от корня,
  первый существующий), раскрывается чтением первых 64 КБ скрипта как текста: его простые
  команды становятся дополнительными командами единицы, скрипт из скрипта раскрывается ещё на
  один шаг. По ним выбираются владелец маршрута (веб-сервер), владелец записей sidekiq и роль
  контейнера по словам команды. CMD Dockerfile — команда по умолчанию: её скрипты не
  раскрываются, если манифест развёртывания задаёт объекту свою команду.
- **Владелец расписаний Celery beat** (ч. 5, П1). Среди контейнеров файла расписание получает
  единственный, чьи команды (с раскрытыми скриптами) запускают `celery` со словом `beat` или
  ключом `-B`/`--beat`; таких несколько — `hints.unassigned` «владелец не определим», ни
  одного — прежнее правило (единственный с ролью «планировщик»). Флаг вроде
  `--with-scheduler` свидетельством не считается: у PostHog свидетельство — `celery -A posthog
  beat` в `bin/docker-worker-beat`, до которого доходит раскрытие `bin/docker-worker-celery`.

## 8. Отчёт о покрытии

`coverage.yaml`:

```yaml
scanner: 0.1.0
repo: github.com/org/yarmarka      # как в origin; без git: пусто
commit: 1a2b3c4d                   # HEAD; без git: пусто
stacks: [Python + FastAPI, Node.js + React, PostgreSQL, Kafka]
families:
  containers: {status: covered, found: 7, parsers: [compose, dockerfile], notes: []}
  databases:  {status: covered, found: 2, parsers: [compose]}
  brokers:    {status: covered, found: 1, parsers: [compose]}
  edges:      {status: covered, found: 9, parsers: [compose-env, kafka-python]}
  tables:     {status: covered, found: 14, parsers: [alembic], skipped: {sql_statements: 3}}
  config:     {status: covered, found: 23, parsers: [python-env, compose-env]}
  channels:   {status: covered, found: 4, parsers: [kafka-python], dynamic_names: 2}
  http_routes: {status: partial, found: 31, parsers: [fastapi], unsupported: [Next.js]}
  workers:    {status: covered, found: 2, parsers: [procfile, celery]}
  schedules:  {status: empty, parsers: [k8s, celery-beat, crontab]}
excluded:
  - {path: tests/, files: 412, reason: convention}
  - {path: docs/, files: 58, reason: convention}
unread: {too_large: 3, binary: 0}
```

Статусы: `covered`, `partial` (часть стека покрыта, остальное названо в `unsupported`),
`empty`, `unsupported` (стек опознан, разборщика нет), `unknown` (стек не опознан), `error`
(разборщик упал, текст). `summary.txt` пересказывает то же словами по правилам продукта и
заканчивается разделом «Как импортировать» (слово интерфейса: способ **Импорт**): `schema.yaml` в окне **Новый проект** способом **Импорт**
или к открытому проекту через **Обновить из кода**; файлы `facts/` окнами фактов (структура
БД, каналы, конфигурация) или инструментами агента; каталог `agent/` для агента. Пункт про
`schema.yaml` пишется, только когда в схеме есть хотя бы один объект; при «Ничего не
найдено» раздела «Как импортировать» и абзаца про связи нет (Zabbix: сводка советовала
импортировать пустую схему), остаётся только совет про `.gitignore`. Семья, в которой
нашлись только записи с выражением в коде (`dynamic_names`, статус `empty`), в строке «Искали
и не нашли» не называется: о ней говорит строка «Расписаний с именем или расписанием,
заданным выражением в коде: N» (и такие же строки маршрутов, каналов и параметров), а статус
`empty` в `coverage.yaml` остаётся, потому что промпт ввоза велит агенту искать такие семьи
самому (ч. 5, П3).

## 9. Качество

- **Фикстура «Ярмарка»** `scan/fixtures/yarmarka/`: синтетический монорепо: `docker-compose.yml`
  (storefront, orders, billing-worker, orders-db postgres, events kafka, redis, mailhog под
  `profiles`), Dockerfile у каждого сервиса, `Procfile` у orders, `services/orders` (FastAPI с
  `APIRouter(prefix="/orders")` и `include_router`, pydantic Settings, `os.getenv` с дефолтами,
  Alembic с тремя ревизиями включая `add_column` и `drop_table`, kafka-python `send("orders.created")`),
  `services/billing-worker` (Celery: очереди, beat, `apply_async(queue=)`), `frontend`
  (package.json с react, `process.env.API_URL || 'http://orders:8080'`), `.env.example` с
  секретами по имени, `tests/` и `docs/` с ловушками (compose с лишними сервисами, миграция,
  маршруты), `.archmapignore`. Ожидаемый вывод закоммичен целиком (`fixtures/yarmarka.expected/`),
  тест сравнивает байт в байт; тест «ловушки не попали»; тест «секреты не попали» (grep по
  выводу на значения из `.env.example`).
- Фикстуры поменьше на каждый разборщик (Django-миграции с переименованиями, SQL DDL в
  разных диалектах, Express/Nest, Go-роутеры, RabbitMQ, supervisor-шаблон, k8s-манифесты,
  Procfile, Helm values).
- **Детерминизм**: два запуска подряд байт в байт; запуск без git (переименованный `.git`)
  даёт тот же вывод, кроме `repo`/`commit`.
- **Враждебный вход**: файл с одной строкой в 2 МБ, YAML с якорями-бомбой (`yaml.safe_load`
  плюс предел размера), миграции с циклом ревизий, глубоко вложенный JSON; каждый разборщик
  укладывается в секунду на таком входе (тест времени).
- **Производительность**: репозиторий Sentry (около 50 тысяч файлов) за десятки секунд,
  не минуты; замер в отчёте фазы 2.
- **Без побочных эффектов**: тест подменяет `socket.socket` и `subprocess.run` и проверяет,
  что сеть не трогается, а `subprocess` зовётся только с `git` и фиксированными аргументами.
- Гейт `scan/`: `ruff check .`, `mypy`, `pytest -q`; покрытие разборщиков не ниже 85 %.

## 10. Интеграция в репозиторий

- `scripts/git-hooks/pre-commit`: четвёртая зона `scan/*` по образцу `mcp/*` (venv `scan/venv`);
  правка `backend/app/routers/scan.py` гоняет бэк-гейт как обычно.
- `.github/workflows/ci.yml`: джоба `scan` (ruff + mypy + pytest + `build.py` и запуск
  собранного файла на фикстуре под Python 3.10 и 3.12), в джобе `compose` проверка
  `GET /api/v1/scan` (200, версия).
- `Dockerfile`, `deploy/build-bundle.sh`, `dev.sh`, `compose.yaml` (ничего, путь по умолчанию),
  `deploy/helm` (ничего), `deploy/install.sh` (путь релиза в `archmap.env`, если нужен).
- Документы в тех же коммитах: `spec.md` (раздел «Сборщик фактов»: что это, что собирает,
  что не делает, как получить файл), `docs/docs-delta.md` (новая возможность для сайта: путь
  без агента), `tasks.md` (эпик, фазы, статус), `CLAUDE.md` (структура: каталог `scan/`,
  команды гейта и сборки) и `QWEN.md` через `scripts/agent-docs.py`, `mcp/README.md` не
  трогать (фаза 3), `DEPLOY.md` одной фразой про файл в поставке.

## 11. Фазы

### Фаза 1а (исполнитель): ядро и ярус манифестов
Каталог `scan/`, обход и исключения, отнесение к владельцу, разборщики 6.1 целиком, миграции
6.3 (SQL DDL, Alembic, Django), словари 6.5, вывод всех файлов раздела 5 (разделы `agent/`
заполняются тем, что уже есть), coverage и summary, CLI, `build.py`, фикстура «Ярмарка» с
ожидаемым выводом, тесты раздела 9, гейт и хук. Семьи яруса 2 в этой фазе получают статус
`unsupported` с именем стека: сводка уже честная.

### Фаза 1б (исполнитель): ярус кода
Разборщики 6.2 (маршруты, параметры, каналы, воркеры и расписания) с фикстурами, связи по
каналам в `schema.yaml`, обновление ожидаемого вывода «Ярмарки».

### Фаза 1в (исполнитель): поставка и раздача
`app/routers/scan.py`, настройка `scan_file`, Dockerfile, bundle, dev.sh, CI, документы по
разделу 10. Проверка руками: `curl -o archmap-scan.pyz http://localhost:8000/api/v1/scan/archmap-scan.pyz
&& python3 archmap-scan.pyz scan/fixtures/yarmarka --out /tmp/…` и ввоз `schema.yaml` в окне
**Новый проект** на dev-стенде без ошибок; файлы `facts/` окнами фактов без ошибок адреса.

### Фаза 2 (архитектор, исполнитель только читает): замер на эталонах
Клоны на коммитах эталонов: `~/archmap-etalons-2026-08-19/repos/{sentry,zulip,grafana,zabbix}`
(sentry 49ce20c3, zulip 94f9096, grafana 00c02e4c, zabbix 167ebfa), эталоны
`~/archmap-etalons-2026-08-19/exports-2026-09-04/etalon-*.yaml`. Для каждого: запуск сборщика,
время, `coverage.yaml`; сверка по семьям: контейнеры, базы, брокеры против детей корня эталона
(полнота и точность по именам через лестницу `scripts/c4-compare`, только уровень контейнеров,
без компонентов); каналы против `channel` у связей эталона (Sentry 40, Zulip 15); таблицы и
параметры выборочно: по 20 записей на репозиторий сверяются с кодом по `evidence.yaml` второй
парой глаз (другая модель или владелец). Ориентиры для решения, не гейт: каналы полнота ≥ 80 %
и точность ≥ 90 % на Sentry и Zulip; таблицы Django без ложных записей; контейнеры: всё, что
есть в compose/Procfile/supervisor репозитория, найдено, недостижимое названо (Zabbix: реестр
процессов в C, Grafana: миграции в Go-коде). Отчёт `docs/qa-scan-v0.md`. По нему владелец
решает про фазу 3 и про пересборку эталонов на основе `evidence.yaml`.

### Фаза 3а (исполнитель): слепые пятна по замеру
Раздел 13: служебные каталоги в подсказки, реестры каналов, compose по содержимому, процессы по
файлам сборки, склейка дублей. Решение владельца 2026-11-03: «делаем». После неё повторный
замер теми же скриптами (docs/qa-scan-v0.md, приложение).

### Фаза 3 (решение владельца 2026-11-03: делать сразу после 3а, без замера промпта): агент
Шаг промпта ввоза и обновления (БЕЗ замера: решение владельца 2026-11-03, замер после
завершения эпика и пересборки эталонов по основаниям сборщика), инструмент `archmap_scan` в
локальном MCP для агентов без терминала, пометки «по сборщику» с основанием в превью и плане
обновления, ссылка на файл в окне **Новый проект** способом **Из репозитория** для пути без
агента, страница сайта документации, `mcp/README.md`.

### Фаза 4 (после решения владельца): служебный контур
Шаг CI на образе ArchMap, служебная учётка с токеном, место приёма результата в проекте без
человека в пайплайне (входящий файл, который открывает архитектор).

## 12. Риски и решения архитектора (владелец может отменить)

- Раздача файла без аутентификации: содержимое публичное, нагрузки нет; иначе агенту по адресу
  пришлось бы носить токен в curl. Решение: без аутентификации.
- Каталог вывода по умолчанию `./archmap-scan` в текущем каталоге, то есть обычно внутри
  репозитория пользователя. Сборщик пишет туда маркер, а сводка советует добавить каталог в
  `.gitignore`. В репозиторий ArchMap он не попадает.
- Имя файла исключений `.archmapignore`, синтаксис подмножества `.gitignore` без отрицаний.
- Regex по чужому коду только без оглядки назад и с тестом времени: правило CLAUDE.md про
  регулярные выражения на пользовательском тексте.
- Python 3.10 на машине пользователя: более старый даёт понятную ошибку при старте (проверка
  версии первой строкой `main`), а не трассировку синтаксиса.
- Ложные связи из `depends_on` между сервисами не рисуются (только в hints): compose
  описывает порядок старта, а не вызовы. Связи к базам и брокерам по `depends_on` рисуются,
  потому что иных отношений к ним не бывает.

## 13. Дополнения по замеру фазы 2 (фаза 3а; docs/qa-scan-v0.md)

1. **Служебные каталоги и переменные ОС** (отчёт, раздел 5: точность параметров 55 %).
   Записи кода (параметры, маршруты, каналы, расписания) из файлов в каталогах с сегментом
   `tools`, `scripts`, `bin`, `.github`, `.gitlab`, `.circleci`, `deploy`, `deployment`, `puppet`,
   `ansible`, `terraform`, `testutils`, `testutil`, `testing`, `test_utils`, `.storybook`, из
   конфигов инструментов (`*.config.js|cjs|mjs|ts|mts|cts` и с вариантом `jest.config.codeowner.js`)
   и из файлов тестовой обвязки по имени (`*_testinfra.go`, `testutil.go`; Grafana держит её в
   `pkg/`) в
   `facts/` и `entrypoints.yaml` не пишутся, а идут в `hints.unassigned` с причиной «файл в
   служебном каталоге, не код сервиса» или «конфиг инструмента»; coverage получает
   `skipped: {tooling: N}` по семьям, сводка в «Пояснениях» одну строку с числом. Гарантии, что
   в таких каталогах нет кода сервиса, нет (вопрос владельца 2026-11-03), поэтому записи не
   удаляются, а остаются видимы агенту и человеку. Переменные операционной системы и CI
   (`HOME`, `USER`, `LOGNAME`, `PATH`, `PWD`, `SHELL`, `TMPDIR`, `TMP`, `TEMP`, `TZ`, `LANG`, `LC_*`,
   `TERM`, `HOSTNAME`, `http_proxy`, `https_proxy`, `no_proxy` в любом регистре, `CI`, `GITHUB_*`,
   `GITLAB_*`, `CODESPACES`, `PYTHON*`, `NODE_OPTIONS`) параметрами не считаются и идут туда же с
   причиной «переменная операционной системы или CI»; `os.environ.setdefault(...)` не чтение.
   `NODE_ENV` и `DJANGO_SETTINGS_MODULE` остаются параметрами.
2. **Реестры каналов** (раздел 3: каналов строкой 0 при 40 из 40 у Sentry и 14 из 15 у Zulip в
   коде). Python: класс (в том числе `Enum`) или словарь на уровне модуля, у имени которого
   есть часть `topic|topics|queue|queues|subject|subjects|channel|channels`, а значения
   (у словаря ключи) строки, в репозитории с клиентом брокера подходящего вида (Kafka для
   topic, RabbitMQ или Celery для queue, NATS для subject) → каналы этого вида, направление
   неизвестно. Аргумент вызова публикации или подписки вида `Name.MEMBER` или `Name["MEMBER"]`,
   где `Name` реестр, раскрывается в значение: направление и связь как у строки. Декоратор с
   первым строковым аргументом, у имени которого есть часть `queue` (`@assign_queue("q")`),
   в репозитории с RabbitMQ или Celery → потребитель очереди; именованный аргумент с частью
   `test` и значением `True` → запись пропускается. Брокера в манифестах нет, а клиент в
   зависимостях и каналы найдены → объект-брокер по клиенту (Kafka, RabbitMQ, NATS; у Celery по
   схеме `broker_url`: `redis://` → Redis, `amqp://` → RabbitMQ), без `host`, в coverage пометка
   «брокер определён по клиенту в коде, не по манифесту» (как база по миграциям, §7; владелец
   может отменить).
3. **Compose по содержимому** (раздел 2: Sentry `devservices/config.yml`). Файл YAML не с
   именем compose и не k8s/helm, у которого на верхнем уровне `services:` со словарём и хотя бы
   у одного сервиса `image` или `build` → читается как compose по тем же правилам (включая
   каталоги разработки); coverage и подсказки называют его «compose по содержимому: путь».
   Записи с `repo_link` или `repo_name` (расширения `x-*`, `dependencies`) → раздел
   `hints.external_repos` (`kind: repo`, `name`, `repo`, `source`): сервисы других репозиториев
   для агента, объектов из них нет. Блок `x-programs` верхнего уровня (у compose по
   содержимому и у обычного) с записями `{имя: {command: строка}}` даёт процессы, как
   Procfile (§6.1): имя `web` или слово команды `devserver`, `runserver`, `web`, `server` →
   «сервис», `scheduler`, `beat`, `cron` → «планировщик», остальные → «воркер»; команда в
   `entrypoints.workers`, каталог кода — корень обхода, технология по его манифестам
   (кроме случая, когда в репозитории есть контейнер со своей сборкой: тогда каталога кода
   у программы нет и код у этого контейнера, ч. 2б, Д10); признак разработки файла и
   политика Б те же, режимы devservices к программам не применяются; программа с именем
   сервиса того же файла склеивается с ним; `x-*` без `command` процессов не дают (ч. 2, В5).
4. **Процессы по файлам сборки, когда манифестов нет** (раздел 2: Zabbix 0 из 10). Autotools:
   `Makefile.am` со строками `bin_PROGRAMS`, `sbin_PROGRAMS`, `libexec_PROGRAMS` (с `+=` и
   переносами `\`) → контейнер на программу, каталог кода равен каталогу `Makefile.am`,
   технология C или C++ по расширениям исходников рядом. Go: каталог `cmd/<имя>/` или
   `*/go/cmd/<имя>/` с `main.go` → контейнер `<имя>`, технология Go, каталог кода этот каталог
   (общий код `pkg/` остаётся «несколько владельцев»). Правило действует только когда ярус
   манифестов (6.1) не дал ни одного контейнера, и заменяет собой единственный неявный
   контейнер корня (§7); в coverage пометка «контейнеры определены по файлам сборки, не по
   манифесту». Java (`build.xml`) и PHP остаются в «не покрыто» с именем стека.
5. **Склейка дублей** (раздел 2: Grafana `grafana` из Dockerfile и `grafana-server` из systemd).
   Два контейнера из разных семей манифестов с одним каталогом кода, у которых команда одного
   запускает бинарь с базовым именем другого (`/usr/share/grafana/bin/grafana server` →
   `grafana`), сливаются в один объект: имя контейнера из Dockerfile (иначе более короткое),
   источники и разборщики обоих, в `hints` запись `merged` с обоими источниками (поле `source`
   списком из двух), пометка в coverage и сводке «один процесс в двух манифестах: N». Без совпадения
   команды и имени склейки нет (Zulip `Dockerfile-postgresql` и программы supervisor).
   С части 2 (п. 13 Д9) склеиваются и контейнеры разных семей, у которых имя одного равно
   `<имя системы>-<имя другого>` или `<имя системы>_<имя другого>` (без учёта регистра) при
   совпадении языка или технологии (или технология одного не задана): `dist/mastodon-web.service`
   и compose `web`; имя остаётся короткое, у сервиса compose.

## 14. Решения фазы 3 (агент; 2026-11-04)

1. **Шаг «0» в промпте ввоза** (`backend/app/import_prompt.py`, `_scan_step`). Промпт
   строителя и обёртка со скептиком начинаются с запуска сборщика: инструментом
   `archmap_scan`, если он есть у агента, иначе командами `curl -sSfL -o archmap-scan.pyz
   <адрес>` и `python3 archmap-scan.pyz . --system "<имя>" --out archmap-scan`; сборщик не
   запустился → шаги 1–6 как раньше. Адрес ArchMap агенту недоступен → человек кладёт файл в
   корень репозитория сам, и шаг велит пропустить скачивание (п. 5). Агент читает `summary.txt`,
   `coverage.yaml`, `agent/hints.yaml` и `agent/entrypoints.yaml`, берёт `schema.yaml` за скелет слоя 2 (имена, shape, source,
   channel и связи из манифестов не трогает), дописывает смысл, семьи `empty`, `unsupported`,
   `unknown` ищет сам, записи без основания не удаляет, сервисы профиля разработки и фазы
   выпуска не берёт; файлы `facts/` подаёт после создания проекта как есть. Пункт 17
   чек-листа сверяет документ со скелетом. Шаг ставится, только когда клиент передал свой адрес
   (`origin`: фронт — `window.location.origin`, MCP — адрес сервера) и файл есть в поставке;
   без `origin` промпт прежний байт-в-байт, ответ несёт `scan_url`. Промпт аудита шага не
   получает: он проверяет готовый пакет. Имя системы в команде экранируется для оболочки.
   Замера промпта нет (решение владельца 2026-11-03), снимки `import--*-scan` закрепляют текст.
2. **Инструмент `archmap_scan`** (локальный MCP 0.14.0, удалённо его нет). Скачивает файл в
   кэш `ARCHMAP_SCAN_DIR` (по умолчанию `~/.cache/archmap-mcp`) по версии и sha256 из
   `GET /api/v1/scan`, сверяет sha256 после скачивания, пишет атомарно; запускает
   `python -I -S -X utf8` тем же интерпретатором, что и сервер MCP, подпроцессом без оболочки,
   с пределом `ARCHMAP_SCAN_TIMEOUT` (600 с) и 2 МБ вывода. `out_dir` только внутри `path` и не
   символическая ссылка. Удалённый `/mcp` на вызов отвечает отказом с подсказкой про команды
   промпта.
3. **Пометка входов сборщика** (`backend/app/scan_origin.py`). По шапке `# archmap-scan
   <версия>`, `# repo:`, `# commit:` (первые 5 строк и 1 КБ) превью ввоза (`file_remarks[i].scanner`),
   план обновления из кода (`scanner` по входам, `null` у входа не от сборщика) и отчёты фактов
   (`scanner` по файлам) несут строку «Собрано сборщиком фактов ArchMap <версия> по коммиту …
   репозитория …: …». Окна показывают её серым, MCP пунктом под «Вход N:».
4. **Ссылка на файл в окнах** (`frontend/src/components/project/ScanFileLink.tsx`). Окно «Новый
   проект» на способе «Импорт» и окно «Обновить из кода» под кнопкой промпта показывают абзац со
   ссылкой на `/api/v1/scan/archmap-scan.pyz` и версией; без файла в поставке абзаца нет.
5. **Файл уже в корне** (2026-11-04, по проверке сайта на пути пользователя): шаг «0» говорит
   «если файл archmap-scan.pyz уже лежит в корне репозитория, первую команду пропусти»; сайт
   описывает путь при недоступном адресе ArchMap без обходных подсказок агенту.
6. **Кандидаты к замеру после эпика** (до него промпт не трогать): статусы `partial` и `error` в
   перечне семей, которые агент ищет сам (сейчас названы `empty`, `unsupported`, `unknown`, а у
   Sentry каналы `partial` с названным Pub/Sub); текст пометки «их добавит агент или человек» в
   окнах ввоза.

## 15. Оракулы и фаза 3б (по замеру 2026-11-04, docs/qa-scan-v0.md §9)

Решения владельца 2026-11-04: полноту сборщика измеряем независимыми оракулами, оракулы в
продукт не кладём (измерительная оснастка в `~/archmap-etalons-2026-08-19/oracles/`), в
репозиторий идут только починки разборщиков и фикстуры на найденные промахи; судью связывает
протокол §9.1 отчёта (вёдра с механическим критерием, по умолчанию промах сборщика).

### Фаза 3б (исполнитель): слепые пятна по оракулам

Числа по прогону оракула с уточнёнными правилами (qa §9.2): Zulip совпало 5 из 117, промахов
109; Grafana совпало 124 из 206, промахов 39, хвостов 13.

1. **Обёртки регистрации маршрутов Django** (Zulip `rest_path`: 109 путей публичного API не
   записаны). Вызов в списке маршрутов, чьё имя не `path`/`re_path`/`url`, разборщик резолвит
   по импорту или определению в том же модуле до функции в репозитории; функция считается
   обёрткой, если её тело возвращает вызов `path`/`re_path`/`url`, у которого первый
   позиционный аргумент (или `route=`/`regex=`) это первый параметр функции. Тогда вызов
   обёртки это маршрут: путь из первого позиционного аргумента (или именованного по имени
   параметра), методы из имён именованных аргументов, равных HTTP-методам (`GET=`, `POST=`,
   значение любое, в том числе кортеж), по записи на метод, без методов `ANY`. Один уровень
   вложенности, кэш по (файл, имя), всё остальное как сейчас. Фикстура: обёртка над `path` в
   отдельном модуле и список с ней, подключённый дважды через `include`. Проверка:
   `openapi_routes.py` на Zulip даёт ≥ 100 совпадений.
2. **Путь в обёртке у Go** (Grafana `generated_base_api_*.go`: `group.Delete(toMacaronPath("/api/v1/…"), …)`,
   105 подсказок и 23 промаха). Аргумент-путь вида `ИМЯ("литерал")` с единственным строковым
   литералом, начинающимся с `/`, на известном объекте маршрутизации (корень, группа, параметр
   замыкания группы) даёт маршрут с этим литералом; на неизвестном получателе остаётся
   подсказкой, как сейчас. Проверка: промахов в `generated_base_api_*` нет.
3. **Префикс группы через параметр функции регистрации Go** (Grafana `registerFolderAPI(apiRoute, …)`
   из `r.Group("/api", …)`: 12 хвостов). Функция того же пакета (каталога), чей параметр служит
   получателем маршрутов или групп, получает префикс параметра от места вызова: вызов внутри
   замыкания группы или на группе присваиванием даёт префикс и признак «решён»; несколько
   мест вызова с разными префиксами дают запись на каждый (как двойное подключение в Django);
   нет мест вызова или префикс там не литерал, как сейчас. Один уровень, без рекурсии через
   два параметра, только файлы одного каталога. Проверка: хвостов на Grafana ≤ 1.
4. Семантика флага `prefix_unresolved` (корень полем структуры) в 3б не меняется.
5. **Текст статуса**: «покрыто» читается как «нашёл всё»; решение владельца о замене на
   «разобрано» и о фразе в сводке, что полнота не обещается, ждёт.
6. Оракулы запускаются после каждой фазы сборщика как часть замера, скрипты оракулов
   исполнитель фазы не правит (несогласие с оракулом идёт в отчёт, не в патч); результаты в
   `docs/qa-scan-v0.md`.
7. **Решения исполнителя фазы 3б** (2026-11-04, владелец может отменить). Django: имя вызова
   ищется сначала среди функций верхнего уровня своего модуля, затем по импорту (в том числе
   `m.f` и импорт под другим именем); обёртка, которая возвращает `path(route, include(…))`,
   и вызов обёртки с `include()` в аргументах маршрутом не считаются. Go: литерал обёртки не
   с «/» остаётся подсказкой, как прежде; место вызова функции регистрации с неизвестным
   объектом маршрутизации даёт запись как прежде рядом с записями решённых мест; имя,
   определённое в каталоге дважды (методы разных типов), и параметр, перекрытый параметром
   замыкания, не резолвятся; вызовы ищутся только в файлах каталога, где есть вызов
   маршрута или группы. По факту: 4 хвоста Grafana из 13 (пути прав доступа
   `resourcepermissions/api.go:135`) дают не параметр функции, а группа с путём
   `fmt.Sprintf("/api/access-control/%s", …)`, пунктом 3 они не решаются. Версия сборщика
   не поднята: `backend/tests/test_scan_origin.py` читает `scan/fixtures/yarmarka.expected` и
   ждёт в шапке `0.1.0`, подъём версии правит и тест бэкенда.
8. **Итог фазы 3б** (слито 2c4e3136, сборщик 0.2.0; docs/qa-scan-v0.md §9.5): Zulip совпало
   5 → 114 из 117, Grafana 124 → 157 из 206. Версия поднята архитектором: тест бэкенда
   `test_scan_origin` и тесты сканера берут номер из шапки фикстуры и `__version__`. Кандидаты
   следующей фазы (без решения): группа Go с путём из `fmt.Sprintf("/api/x/%s", …)` (`%s` как
   параметр; 1 промах и 4 хвоста Grafana); chi `r.Group(func(r chi.Router) {…})` без пути не
   даёт области; корни и группы Go известны по имени на весь файл (`r := chi.NewRouter()` и
   `func reg(r chi.Router)` в одном файле); файлы urls Django читаются дважды
   (`codebase.sources` и `load`); предел времени express в тесте враждебного входа на грани.
9. **Эталон Sentry v2 в слоях** (2026-11-05, docs/qa-scan-v0.md §10): по действующим правилам
   пропусков нет, полнота с кандидатами 0,19 по объектам и 0,00 по связям, точность объектов
   0,45. Фаза 3в (ждёт решения владельца): (а) `x-programs` compose по содержимому → процессы
   (+19 объектов на Sentry); (б) реестр `KAFKA_CONSUMERS` → объекты и связи брокер → консьюмер
   по `topic`, `dlq_topic`, `stale_topic` (+2 объекта, +32 связи); (в) dev-only сервисы
   devservices (недефолтные `modes:`, отладочные) → подсказки (−6 ложных объектов; спорит с
   решением 1а читать манифесты каталогов разработки). Перемер после 3в той же проверкой на том
   же `layers.yaml`, без агентов. Эталоны Zulip, Grafana, Zabbix по тому же протоколу: ~1,4 млн
   токенов каждый.
10. **Корнер-кейсы** (2026-11-06, решение владельца вместо пересборки эталонов; docs/qa-scan-v0.md §11):
   шесть репозиториев (Online Boutique, Lemmy, Mastodon, immich, Argo CD, PostHog), 1,24 млн токенов
   на все, связи 158/170 верны, объекты 83/172. Задание фазы 3в по приоритету, перемер теми же
   `verdict.yaml` и чекером без новых скептиков:
   - (А) дефекты: литерал с конкатенацией (`"/"+root`, `"OTEL_"+name`) уходит в dynamic_names, а не
     в факты; файл k8s отбрасывается как шаблон только по признаку Helm (`{{ .Values`, `{{-`), а не по
     любому «{{»; `CREATE TABLE … AS` даёт таблицу без колонок и примеры пропусков из живых таблиц;
     примеры окружения по суффиксу `example|sample|template|dist` (инвариант §2 п. 6) и `example.env`;
     владелец файла по §7 не отдаётся контейнеру другого языка; Dockerfile в подкаталоге привязывается
     к сервису compose/skaffold по контексту, `Dockerfile.<суффикс>` это вариант того же контейнера;
     транзитивные зависимости pip-compile («# via») не задают фреймворк; задача на образе базы или
     брокера с `command` не база и не брокер; CI-файлы (`.woodpecker.yml`, `.drone.yml`, `.gitlab-ci.yml`)
     не compose по содержимому; `.semgrep` служебный; имя таблицы без кавычек в нижний регистр;
     строка сводки «параметры общего кода» только при непустом shared_code; Enum с именем в CamelCase
     делится на слова (`CeleryQueue`).
   - (А) честность: `unsupported` с именем только из прямых зависимостей и файлов, которые есть
     (viper, Java, Ruby, Rust по факту), обязательные имена .NET, Rails, Sidekiq, BullMQ, Kysely,
     clokwerk, sidekiq-scheduler; `unknown` только при неопознанном стеке; словарь образов пополнить
     (`pgautoupgrade`, `clickhouse*`, `browserless`); Redis брокер при Sidekiq/BullMQ в зависимостях.
   - (Б) политика «боевое или для разработки», ПРИНЯТА владельцем 2026-11-06 («Да, согласен»),
     уточняет решение 1а, а не отменяет: манифесты разработки читаются всегда. (1) Если в
     репозитории есть боевые манифесты (compose без признаков разработки, k8s, Helm, systemd),
     манифесты разработки дают только подсказки с причиной; сервис, который есть и там, и там,
     остаётся по боевому. (2) Если боевых манифестов нет (Sentry devservices, Zulip), манифесты
     разработки дают объекты, но каждая запись несёт пометку «из манифеста разработки», сводка
     говорит об этом прямо. (3) Признак разработки по месту и форме, не по догадке: каталоги
     `.devcontainer`, `docker/federation`, `e2e`, `playwright`, `test*`; файлы `*.dev.yml`,
     `Dockerfile.debug|playwright|e2e`; Procfile при goreman в Makefile; CI-файлы; сервисы base,
     не расширенные ни одним боевым файлом; сервисы наблюдаемости из prod-стендов разработки;
     с части 1б (п. 12) ещё «служебная сборка» (каталог `tools`, `scripts`, `artifacts` и
     подобные), «команда разработки» и «инструмент разработки» у сервиса compose и «Laravel
     Sail» у файла compose; с части 2 (п. 13) «тег образа» у сервиса compose (Д1), «CI на
     ступени 2» (кандидаты каталога `ci/` и файлов CI объектов не дают и без боевых
     манифестов, Д4), «имя стенда» у файла compose (верхний `name:` со словом smoke, test,
     ci, e2e, dev, local, bench, Д8).
     Страховка остатка: шаг промпта агента «подсказки dev-only проверь, не боевые ли они».
     Данные: 55 из 89 неверных объектов корнер-кейсов dev-only; релевантное только в dev-манифестах
     встретилось трижды (Sentry целиком, ES и LibreTranslate Mastodon, usage-ingestion PostHog) и
     при политике остаётся видимым.
   - (В) правила по value: реестры каналов константами модуля и enum очередей (Kafka PostHog 56,
     BullMQ 19, sidekiq.yml 13; с ними Sentry п. 9б); связи из NetworkPolicy (13), patches kustomize
     (7 связей, 14 config), ConfigMap-адресов (3), смонтированных файлов конфигурации (19); обёртки
     чтения env в Go и Rust envconfig (181, 1039), zod-схема env (48), .NET Configuration (9), hjson
     (21); пути swagger/OpenAPI как точки входа (106); SQL-литералы в миграциях на TS (72).
11. **Решения исполнителя фазы 3в, часть 1** (2026-11-06, ветка feat/scan-3c, сборщик 0.3.0;
   владелец может отменить, числа перемера в отчёте исполнителя).
   - А2: признак Helm это `{{-` или `{{` с `.Values`, `.Release`, `.Chart`, `.Capabilities`,
     `.Files`, `include`, `template`, `define`, `tpl`, `if`, `else`, `range`, `with`, `end`,
     `toYaml` или комментарием `/*`.
   - А3: имя без кавычек в нижний регистр не приводится у MySQL, MariaDB, SQLite и SQL Server
     (там регистр имени таблицы сохраняется), у alembic и Django приводится;
     `CREATE TEMP TABLE` таблицу не создаёт; `ALTER TRIGGER` и `RENAME CONSTRAINT` поняты;
     `CREATE TABLE … AS` даёт таблицу без колонок с подсказкой (колонки запроса не выводятся).
   - А5: язык сверяется и при единственном владельце.
   - А6: вариант Dockerfile без суффикса разработки (llm-analytics, dagster-ml PostHog)
     остаётся своим контейнером; корневой Dockerfile привязывается по имени репозитория или
     системы с нормализацией (argo-cd и argocd); `tilt` считается суффиксом разработки; обёртка
     `bundle` в командах снимается.
   - А8: задача на образе базы или брокера только с командой оболочки или
     `restart: no|on-failure`: так базовый kafka (redpanda start) и реплики остаются собой.
   - А9: служебным считается и `.gitlab/`.
   - А10: «общий код» считают только разборщики кода и примеры окружения.
   - А11: очереди SQS опознаются по слову sqs в имени реестра или каталоге и по клиенту AWS в
     импортах; словарь `…_TO_TOPICS` реестром не считается (FEATUREBASE_OBJECT_TYPE_TO_TOPICS
     PostHog дал три ложные темы, когда kafka-init перестал быть вторым брокером).
   - А12: стек ищется в файлах контейнеров (owners.file_owners), подписи «Язык: библиотека»,
     семья workers по тем же правилам; `unknown` становится `empty` у http_routes и channels,
     если язык контейнеров известен. Контейнеры по файлам сборки или неявный контейнер корня
     границу системы не задают, и тогда стек ищется по всем манифестам (PHP-интерфейс Zabbix
     без своего контейнера иначе прятался за «искали и не нашли»).
   - А13: ClickHouse в имени образа, кроме keeper, exporter, backup и operator; Redis брокер,
     только когда он у контейнера один; манифесты сборки это каталог кода и каталог Dockerfile
     внутри него (immich: server/package.json); база с depends_on к брокеру связана с ним
     (clickhouse и kafka PostHog).
   - А14: оговорка второй и третьей строкой сводки, ключ `covered` в YAML прежний (п. 5
     выполнен).
   - Б1: к признакам добавлены каталог `devservices` (оркестратор разработки Sentry, без него
     Sentry не попадает на ступень 2) и стенд в каталоге кода контейнера из другого боевого
     файла (`assemble._stands`: livestream/ и rust/ PostHog, 7 объектов, отдельный коммит).
     Сервис основы со своей сборкой (`build`) разработкой не считается, иначе ok-объект
     usage-ingestion PostHog ушёл бы в подсказки. Признак «сервисы наблюдаемости из
     prod-стендов» (immich docker-compose.prod.yml) не сделан: по месту и форме он не виден, а
     правило «один файл собирает, другой запускает образ» ломает схему с файлом override.
   - Б2: признак по пути получает и Helm; сервис с тем же именем в боевом манифесте любого
     вида остаётся по боевому и забирает Dockerfile сборки из файла разработки.
   - Б3: сервис devservices вне режима default остаётся объектом, если есть режим с его
     именем (memcached), иначе уходит в подсказки (bigtable, redis-cluster, relay-cell,
     relay-edge, taskbroker-sentry); отладочный узнаётся по слову debug в описании
     (spotlight). Ступень 2 наступает, когда нет ни одного боевого манифеста развёртывания
     (compose, k8s, Helm, systemd, supervisor, Procfile); Dockerfile таким манифестом не
     считается.
   - Остаток после части 1 (15 из 73 лишних объектов, цель ≤ 10 не достигнута): узлы
     многоузлового ClickHouse PostHog 9 (признак только в комментарии шапки «smoke-test
     stack»), posthog-metrics-agent (склейка Helm и Dockerfile products/metrics/agent дала
     бы имя чарта, и ok-объект agent пропал бы), mastodon-web и mastodon-streaming (дубли
     юнитов systemd и compose, склейка §13.5 по команде их не видит), immich-grafana и
     immich-prometheus, gitops-agent Argo CD (отдельный продукт в gitops-engine/). Ложные
     связи PostHog 12 → 2: asyncmigrationscheck → plugins (адрес из унаследованного
     окружения) и temporal-ui → db (depends_on только порядок запуска).
12. **Решения исполнителя части 1б по дымовому прогону 2026-11-07** (ветка feat/scan-3c, сборщик
   0.3.0 без выпуска; 15 неглубоких клонов: Java, .NET, PHP, Elixir, полиглот, Terraform, Ansible,
   Bazel, большие монорепо; пункты С1–С13 судьи; владелец может отменить, числа перемера в
   отчёте исполнителя).
   - С1: каталоги зависимостей и инструментов (`node_modules`, `vendor`, `.venv`, `venv`,
     `__pycache__`, `.tox`, `.mypy_cache`, `.idea`, `.vscode`, `coverage`) не читаются и при
     обходе через git (`walk.DEPENDENCY_DIRS`), в покрытии причина `dependencies`; сегмент
     сравнивается целиком с учётом регистра, как у обхода без git. `dist`, `build`, `target` с
     git читаются (закоммиченный `build/` Kubernetes источник). Каталог CI проверяется раньше:
     `.github/vendor/` остаётся в причине `ci`. С части 2 (п. 13 Д5) `coverage` с git
     читается.
   - С2: шаблон Dockerfile (имя Dockerfile в любой из четырёх форм с расширением `j2`, `tpl`,
     `template`, `in`, `jinja`, `jinja2`) не читается вовсе (`walk.template_rule`), в покрытии
     причина `template`: `Dockerfile.j2` AWX объектом «j2» не становится, `.devcontainer/Dockerfile.in`
     Envoy уходит из подсказок в исключённое. Шаблоны других манифестов (`*.conf.template`
     supervisor) правило не трогает. Форма `<имя>.Dockerfile` и раньше разбиралась как
     `Dockerfile.<имя>` (`assemble._variant`, `walk.dev_sign`), тест это закрепляет.
   - С3: (а) `docs`, `doc`, `examples`, `example`, `samples` и новый `sample` совпадают и частью
     сегмента через дефис или подчёркивание (`walk._convention_dir`: `docker-stack-docs`,
     `helm_examples`), частью слова нет (`documents`, `exampleservice`). Правило общее для
     обхода, поэтому вместе с учебными Dockerfile Airflow уходят и `api-docs/` Sentry (подсказка
     о файле OpenAPI `api-docs/openapi.json` пропала, вернуть ключом `--include api-docs`),
     `src/telemetry-docs/` OpenTelemetry Demo (сервис compose остаётся, его Dockerfile
     не читается), `contributing-docs/` и `example_dags/` Airflow, `sample-*` Kubernetes.
     (б) Признак «служебная сборка» (`walk.service_sign`, текст «служебная сборка в каталоге
     <каталог>/»): сегмент `tools`, `scripts`, `artifacts`, `recipes`, `quality`, `benchmark`,
     `benchmarks`, `uffizzi`, `terraform`, `packer`, `build-image`, `*-build-image` или с `_` в
     начале; ставят его Dockerfile, compose, k8s, systemd, supervisor и Procfile
     (`walk.manifest_sign` = признак разработки, иначе служебная сборка), Helm нет. Dockerfile
     служебной сборки проверяется после привязки к образу сервиса (`_image_targets`): образ,
     который запускает боевой сервис, остаётся его Dockerfile. На ступени 2 такой Dockerfile
     становится объектом с пометкой (ловушка Monica), а Dockerfile с признаком разработки по
     месту и форме по-прежнему уходит в подсказки на обеих ступенях: это правило части 1, его
     пункт не называет. Следствия по дыму: юниты `scripts/systemd/airflow-*.service` Airflow
     (8 процессов) и `tools/kafka/*/docker-compose.yml` Loki (брокер kafka) тоже стали
     подсказками; у AWX все манифесты в `tools/`, боевых нет, и его процессы вернулись объектами
     ступени 2 с пометкой.
   - С4: язык по базовому образу Dockerfile берётся с конца (`assemble._dockerfile_language`):
     итоговая стадия, а без языка у неё (`scratch`, `alpine`, distroless) ближайшая предыдущая
     с языком. Манифесты сборки каталога кода по-прежнему старше образа. В дыме правка видна на
     fpm Monica после С6 (сейчас Dockerfile в `scripts/` подсказка ступени 1).
   - С5: (а) у объекта compose, k8s или Helm без каталога кода или с корневым (не базы и не
     брокера по образу, не варианта Dockerfile) каталог кода ищется по имени сервиса, затем по
     последнему сегменту образа (`assemble._named_dir`): каталог с этим именем в корне или в
     `src/`, `services/`, `apps/`, `packages/`, `cmd/`, `modules/`, хвост из `src`, `app`,
     `docker`, `build` имени не задаёт (`src/cart/src` это «cart»). Каталогом кода служит
     каталог с манифестом сборки или с Dockerfile самого объекта (С++ `src/currency/`); чужой
     Dockerfile в каталоге с таким именем не в счёт, иначе образ grafana/loki трёх сервисов
     Loki забрал бы `cmd/loki`. Ближайший к корню выигрывает, два разных каталога на одной
     глубине неоднозначны. Решение исполнителя: Gradle с плагином Kotlin (`kotlin("jvm")`,
     `org.jetbrains.kotlin`) даёт язык Kotlin (цель приёмки «Kotlin у fraud-detection»);
     recommendation в клоне на Java (build.gradle), поэтому Java + Spring Boot, а не Python.
     (б) Dockerfile без манифеста сборки в своём каталоге, чей каталог имени не даёт (`docker/`)
     или это служебная сборка, при «COPY .» или «ADD .» берёт каталог кода у ближайшего
     предка с манифестом (`Dockerfile.copies_context`, `assemble._package_home`) и имя по нему
     (корень даёт имя системы: Monica вместо «scripts»); такой Dockerfile без имени при двух и
     более сервисах compose с образами одной организации, код которых найден по (а),
     уходит в `hints.unassigned` с причиной «общий Dockerfile сборки» (docker/Dockerfile
     Petclinic больше не объект «petclinic-ms»). Предок, который уже каталог сборки другого
     сервиса, правило не трогает: Dockerfile разбирается как раньше. Попутно поправлены две
     технологии PostHog из вердикта wrong-kind (ml-mirror-image-scrub и recording-rasterizer:
     Node.js вместо Rust, это С4).
   - С6: признак разработки по форме сервиса compose (`compose._service_dev`). (а) «Команда
     разработки» (`vocab.dev_command`, по базовому имени слова команды или entrypoint): пары
     `yarn|npm|pnpm install|ci`, `bundle|pip|pip3|composer install`, `next dev`, программы
     `webpack-dev-server`, `nodemon`, `rspec`, `pytest`, `jest`, `cypress`, `playwright`, `vite`
     (кроме `vite build`), `db:seed`. Сверх перечня судьи, чтобы сохранить цель пункта на Forem:
     `--watch` (esbuild: `yarn build --watch`), заглушка `sleep infinity` и `tail -f /dev/null`
     (devcontainer) и раннер тестов по части имени сервиса (`rspec_system` без своей команды).
     (б) «Инструмент разработки» (`vocab.DEV_TOOL_IMAGES`) по сегменту пути образа, имя или имя с
     номером (`pgadmin4`). `browserless` из перечня судьи НЕ взят: в боевом файле hobby PostHog
     им рендерит воркер, это ok-объект вердикта корнер-кейсов (стоп-правило брифа), поэтому
     chrome Forem остаётся объектом. (в) «Laravel Sail» ставится файлу целиком: контекст сборки
     внутри `vendor/laravel/sail` или образ `sail-*` хотя бы у одного сервиса; его базы и кэш
     поднимаются для того же стенда. У Monica боевых манифестов не остаётся, ступень 2: сервисы
     Sail, базы и `scripts/docker/Dockerfile` (объект «monica» на PHP + Laravel) объекты с пометкой. (г)
     Dockerfile под `.devcontainer/` к боевому объекту не привязывается (n8n больше не берёт
     каталог кода `.devcontainer`). Остаток: bundle Forem (`./scripts/bundle.sh`) правилом не
     виден, Forem даёт 8 объектов вместо цели 6 (bundle, chrome сверх списка).
   - С7: (а) корневой контейнер (неявный или с каталогом кода, равным корню) берёт язык из
     манифестов свободных подкаталогов (`assemble._free_packages`: не заняты каталогом кода
     другого объекта, не служебная сборка и не разработка по `walk.manifest_sign`). Решения
     исполнителя сверх формулировки судьи, чтобы правило не угадывало: только когда корень не
     задаёт язык (манифестов нет или это `package.json` без dependencies и workspaces, как у
     eShop с одними devDependencies; `assemble._service_root`), базовый образ Dockerfile языка
     не называет, Dockerfile объекта не объявлен в подкаталоге, а свободные манифесты не
     Node.js одного языка (у OpenTelemetry Demo рядом утилиты Go `internal/tools/`, тесты .NET
     и Gemfile мобильного приложения). Язык и фреймворк по `stack_of` среди этих манифестов.
     eShop: «.NET». Промежуточно: `telemetry-docs` OpenTelemetry Demo (контекст корня,
     Dockerfile из переменной `.env`) получил Ruby от `src/react-native-app/Gemfile`; уйдёт с
     мобильным каталогом С8 и подстановкой `.env` С13. (б) `coverage.stacks` только из словаря
     (`vocab.is_stack`): языки манифестов, образов и файлов сборки, фреймворки, виды образов и
     клиентов, диалекты SQL, запись «язык + фреймворк». Имя образа остаётся технологией объекта
     (zipkin), из стеков уходят и технологии задач по образу (`postgres`, `redpanda` PostHog).
     (в) Семья яруса кода в статусе `unknown` получает в `unsupported` языки контейнеров, код
     на которых сборщик не читает, и `unknown` остаётся только без языка у всех контейнеров.
     У Petclinic `unsupported` уже дал С5 (код найден по имени); `http_routes` пишет
     «Java: Spring Boot» по правилу А12. `channels` Kubernetes `unknown` по правилу: после
     ухода `_mock` (С3) у контейнеров на образах язык не известен.
   - С8: (а) `Dockerfile.<суффикс>` и `<префикс>.Dockerfile` рядом с основным `Dockerfile` —
     вариант контейнера основного при любом суффиксе (`hints.merged`, причина «вариант
     Dockerfile рядом с основным»); решение А6 про отдельные контейнеры по суффиксу не для
     разработки отменено, тест `test_standalone_dockerfiles` переписан (`Dockerfile.worker`
     теперь вариант orders). Решения исполнителя, чтобы не потерять ok вердикта PostHog: в
     корне репозитория суффикс по-прежнему называет отдельный образ (`Dockerfile.llm-analytics`,
     `Dockerfile.dagster-ml` рядом с корневым `Dockerfile`); у основного Dockerfile нескольких
     сервисов (общий `rust/Dockerfile` capture, cymbal и других) суффикс не для разработки
     тоже отдельный образ (`rust/Dockerfile.sqlx-migrate`: первый перемер его склеил с capture,
     стоп-правило, правило уточнено). Форма с дефисом (`Dockerfile-fpm` Monica) правилом не
     задета. Основной Dockerfile без контейнера: вариант идёт по прежним правилам. (б)
     Dockerfile, который стал бы своим объектом, в подкаталоге каталога кода ровно одного
     контейнера (не корень, свой каталог не в счёт) — его вариант (причина «Dockerfile в
     подкаталоге кода этого контейнера»), если в каталоге Dockerfile нет своего манифеста
     сборки; кандидаты разработки ступени 1 каталогом не владеют. Ближайшие к корню
     решаются первыми. Сверх случаев судьи по правилу ушли объекты `aws_lambda` Airflow
     (вариант `executors`) и `kube-apiserver`, `kubectl` Kubernetes (варианты `server-image`
     из `build/server-image/`). (в) Каталог мобильного приложения (`walk.mobile_dir`: часть
     сегмента `android`, `ios`, `mobile`, `flutter` или `react-native` в сегменте): Dockerfile
     в нём уходит в `hints.unassigned` с причиной «мобильное приложение», его манифесты не
     свободные пакеты С7 (`telemetry-docs` OpenTelemetry Demo вернулся к Node.js корня).
   - С9: обе ветки правила судьи сборщик уже выполнял: `_engine` разборщика Django предпочитает
     ENGINE не sqlite во всех файлах настроек, а таблицы при реляционной базе в манифестах
     достаются ей (`owners.database_for`). Новое: в этом случае ENGINE sqlite3 даёт подсказку
     «sqlite как значение по умолчанию настроек» (`hints.unassigned`, вид `database`). У AWX
     ни одна ветка не выполняется: в пакете `awx/settings/` ENGINE один (sqlite3 в
     `defaults.py:24`), а compose с PostgreSQL лежит в шаблоне `.j2` (исключён С2). Чтобы
     сохранить цель «AWX без SQLite», решение исполнителя: sqlite3 считается значением по
     умолчанию и тогда, когда другой модуль того же каталога настроек присваивает `DATABASES`
     на уровне модуля без sqlite (`production_defaults.py: DATABASES = {}`,
     `django._sqlite_overridden`, `TableSet.dialect_default`). Тогда база по миграциям строится
     без вида («База данных», 60 таблиц AWX), подсказка та же. Ловушка: модуль рядом без
     `DATABASES` sqlite не отменяет, проект только на sqlite остаётся с SQLite.
   - С10: файл Kubernetes, где у любого документа `metadata.name` или строка под ключом `image`
     содержит `RELEASE-NAME` без учёта регистра, это вывод `helm template` (`k8s.rendered`):
     документы файла не разбираются, в покрытии пометка семьи containers «отрендеренный
     шаблон Helm (имена RELEASE-NAME) не разбирается», путь файла в `hints.unparsed`. Метки и
     прочие поля признаком не считаются. У Airflow ушли объекты «RELEASE-NAME-kerberos-kdc» и
     «RELEASE-NAME-keytab-bootstrap» (`chart/kustomize-overlays/kerberos/`); файлы
     `chart/kustomize-overlays/keda/` (ScaledObject) разборщик не загружал и раньше.
   - С11: разборщик SQL группирует наборы, чей каталог назван диалектом, по общему родителю
     (`sql._one_database`). Если в группе два и более каталога и есть серверный, остаётся
     набор первого по алфавиту серверного каталога; вид по типам колонок, а без них по имени
     каталога (`mysql` → MySQL). Остальные наборы группы в базу не идут: встраиваемый —
     подсказка «встроенная база для разработки и тестов: таблицы взяты из <каталог>»,
     второй серверный — «несколько диалектов одной базы» (`hints.unassigned`, вид
     `database`). Один каталог диалекта без соседей правилом не задет. Petclinic: три
     сервиса, у каждого `db/hsqldb` и `db/mysql`, база одна «MySQL» с таблицами, «База
     данных» ушла.
   - С12: маркер сборки в корне (`buildfiles.root_stack`; Bazel старше CMake) даёт стек
     репозитория `vocab.STACK_BAZEL` или `STACK_CMAKE`. При маркере `Cargo.toml` и `go.mod`
     (`vocab.SDK_MANIFESTS`) — SDK и утилиты: неявный контейнер по ним не строится, каталоги
     `cmd/` модулей Go процессами не считаются, имя системы по `go.mod` не берётся, языка
     контейнеру с корневым каталогом кода они не дают, в `unsupported` по языку не идут.
     Решения исполнителя: контейнер с корневым каталогом кода без другого языка получает стек
     маркера технологией; стек первым в `stacks` и в `unsupported` семьи containers и семей
     яруса кода (config, channels, http_routes, workers, schedules). Разбор Envoy: объекты
     «all», «gcc», «llvm», «none» — сервисы матрицы CI `ci/matrix/docker-compose.yml` со
     сборкой из корня (ступень 2, объекты с пометкой разработки), основания `Cargo.toml:1` и
     `go.mod:1` у них были от корневых манифестов; «envoy» — `distribution/docker/Dockerfile-envoy`,
     образ продукта, у системы «envoy» основание `go.mod:1`. После правила стеки
     [C++ (Bazel)], у матрицы технология «C++ (Bazel)» без оснований от Cargo.toml и go.mod,
     имя системы по каталогу. Сами объекты матрицы остаются по политике Б: правило про
     неявные контейнеры их не задевает (остаток).
   - С13 (решение судьи, отдельный коммит для отката): `.env` из каталога файла compose
     читается, только если он закоммичен (`git ls-files --cached`; новая разрешённая команда
     `context.GIT_COMMANDS`, вызывается лениво, только если такой `.env` есть в перечне). Перечень
     обхода с git включает и незакоммиченные файлы вне `.gitignore`, поэтому одного перечня
     мало. Без git не читается никогда. Строки разбирает `envexample.parse_text`. Значения
     раскрывают `${VAR}`, `${VAR:-x}` (и `${VAR-x}`) в `image`, `build.context`,
     `build.dockerfile`, `environment` и `depends_on` (`compose.expand(env=…)`); `$VAR` без
     скобок, `command` и `entrypoint` не трогаются, `ports` разборщик compose не читает вовсе.
     Значения `.env` не параметры и не факты: в вывод попадает только то, что подставлено в
     поля compose, дальше по прежним правилам (адрес связи по §6, дефолт по инварианту 6).
     Два сопутствующих правила, без которых подстановка у OpenTelemetry Demo ломала прежний
     результат: у контейнера без своих манифестов сборки вид и технологию даёт база или
     брокер итоговой стадии его Dockerfile, как у Dockerfile без манифеста (kafka на
     `apache/kafka` и opensearch остались брокером и базой); каталогом кода для правила
     подкаталога С8 служит и каталог Dockerfile сервиса со сборкой из корня, если он назван
     именем сервиса (`src/checkout/genproto/Dockerfile` остался вариантом checkout). Итог у
     OpenTelemetry Demo: технологии образов, astronomy-db — PostgreSQL, valkey-cart — Redis,
     связи к otel-collector, opamp-server, valkey-cart и astronomy-db по адресам `.env`.
   - Остаток части 1б по целям дыма: Forem 8 объектов при цели 6 (bundle: команда
     `./scripts/bundle.sh` правилом С6 не видна; chrome на browserless оставлен ради ok вердикта
     PostHog; базы db и postgres из двух файлов compose, склейку их ни один пункт не называет);
     объекты матрицы CI Envoy остаются объектами ступени 2 (С12); recommendation OpenTelemetry
     Demo на Java (в клоне build.gradle), а не на Python; `http_routes` Petclinic пишет
     «Java: Spring Boot» по правилу А12; stacks Kubernetes пусты (у контейнеров на образах
     язык не известен); подсказка Sentry о `api-docs/openapi.json` ушла с С3а.
13. **Решения исполнителя части 2** (2026-11-07, ветка feat/scan-3c, сборщик 0.3.0 без выпуска;
   реестры каналов и связи с брокером, блок В п. 10, кандидаты п. 9 (а) и (б), мелкие правила
   по дыму; владелец может отменить, числа перемера в отчёте исполнителя).
   - В1 (решение исполнителя): модуль-реестр констант опознаётся по ПОСЛЕДНЕМУ слову имени
     файла во множественном числе (`topics`, `queues`, `subjects`), а не по любому слову:
     у PostHog `dead_letter_queue.py`, `cleanup_queue.py`, `activity_summary/queue.py`
     держат имена таблиц ClickHouse, ключей Redis и источников (`events_dead_letter_queue`,
     `activity_log`), и правило по любому слову дало бы ложные очереди Celery. Файл, который
     клиента Kafka не подключает, но импортирует имя из реестра топиков и зовёт обёртку
     проекта (`posthog/api/metalytics.py`: `get_producer(…).produce(topic=KAFKA_APP_METRICS2)`),
     читается разборщиком Kafka, и в счёт идут только аргументы, раскрытые по реестру (прочие
     `send` и `produce` не подсказки): без этого места записи PostHog через обёртку
     оставались без связи с каналом. Правило голого имени в Celery, RabbitMQ и NATS действует
     в файлах, которые их разборщики читают и раньше. TypeScript: модуль констант ищется по
     тому же правилу имени в пакетах с kafkajs; импорт `from '~/…/kafka-topics'` с
     псевдонимом пути находится по имени файла, если такой модуль один. У PostHog код на
     Node.js подключает node-rdkafka, а не kafkajs, поэтому зеркало `kafka-topics.ts` там не
     читается (каналы те же, что у Python).
   - В1 (решение исполнителя части 2 ОТМЕНЕНО частью 2б, решение владельца 2026-11-08): в
     части 2 связь с каналом из кода перестала вытеснять «использует» той же пары из
     манифестов, чтобы не терять ok-связи вердиктов `web → kafka` PostHog и `sidekiq → redis`
     Mastodon. Причина была измерительной, а не продуктовой: вердикты записали эти связи без
     канала, а измеритель судьи теперь печатает такую пару строкой «заменена связью с
     каналом», не регрессией. ArchMap при ввозе отмечает связь с брокером без канала
     замечанием, и лишняя «использует» рядом со связями с каналом давала пользователю
     замечания на ровном месте. Правило части 1 вернулось: «использует» не рисуется, если у
     пары (без учёта направления) есть связь с каналом; к базе и к брокеру без связей с
     каналом она остаётся. `yarmarka.expected` снова с 8 связями, тест
     `test_channel_edges_replace_uses_link` восстановлен и дополнен ловушками.
   - В2 (решение исполнителя): `BullModule.registerQueue({ name })` объявляет очередь без
     направления (регистрация для внедрения, а не запись в очередь); публикует
     `@InjectQueue`. Файл подключает и `@nestjs/bull` (обёртка Nest над Bull). `new Worker` в
     файле, который подключает `worker_threads`, не потребитель (поток Node.js). BullMQ снят из
     «не читаю» семьи каналов; семья воркеров по-прежнему называет BullMQ: потребитель кода
     пишется в `entrypoints.consumers`, воркеров из кода сборщик не заводит (кандидат судьи
     про `entrypoints.workers` не выполнен буквально). У immich 19 очередей у брокера `redis`,
     связей с каналом нет: `new Worker(queueName, …)` в цикле по `Object.values(QueueName)` и
     `registerQueue(...bull.queues)` уходят в `hints.dynamic_names`, это честный результат.
   - В3 (решение исполнителя): владелец потребителя и расписания Sidekiq выбирается по
     программе-исполнителю (`ChannelUse.runner`, `CodeSchedule.runner`): среди контейнеров
     файла тот, у которого команда одного из манифестов (`vocab.command_program`) равна
     `sidekiq`; нет такого — `hints.unassigned` с причиной «среди контейнеров файла нет
     процесса, который запускает sidekiq», два — «владелец не определим». Наследник ищет
     базовый класс по полному имени с модулями (`ActivityPub::DistributionWorker` и
     `DistributionWorker` у Mastodon разные классы), имя без модуля берётся, только если оно
     единственное. Вставки ERB в расписании остаются текстом как написано (`cron: '<%=
     Random.rand(0..59) %> 3 * * *'`), имя очереди со вставкой уходит в
     `hints.dynamic_names`. Принят и `:schedule:` верхнего уровня. Очередь записи расписания
     (часть 2б, решение владельца 2026-11-08): класс из записи `:schedule:` с `queue: X` без
     своей очереди в `sidekiq_options` потребляет X, потому что sidekiq-scheduler кладёт
     задачу в очередь записи; своя очередь класса сильнее записи, запись без `queue:` даёт
     очередь класса (`default` или базового). Решение исполнителя: очередь записи не
     наследуется (в записи стоит только этот класс), имя класса сравнивается полным именем с
     модулями, очередь со вставкой ERB уходит в `hints.dynamic_names`. Mastodon: 16 классов
     `Scheduler::*` в очереди `scheduler`, связь `redis → sidekiq [scheduler]`, у `default`
     35 потребителей. Потребитель пишется на каждый класс (у Mastodon 112: 97 с `include`
     и 15 наследников), `entrypoints.workers` из кода не заводится, семья воркеров
     по-прежнему называет «Ruby: Sidekiq». В «не читаю» семей каналов и расписаний остался
     язык Ruby без библиотеки: прочий код на Ruby сборщик не читает.
   - В4 (решение исполнителя): кроме `topic`, потреблением считается любой ключ записи со
     словом topic, кроме `dlq_topic` и `stale_topic` (`synchronize_commit_log_topic_default`
     у трёх post-process-forwarder Sentry: в слоях эталона это связи Kafka → воркер, 22 = 19
     по `topic` и 3 по журналу фиксаций). Значение `None` каналом не считается, выражение
     уходит в `hints.dynamic_names`. Объект процесса ищется по имени, иначе среди
     контейнеров с `consumer <имя>` в команде (В5 даёт процессы `x-programs` с такими
     командами), иначе `hints.unassigned` с причиной «процесс консьюмера <имя> в манифестах не
     найден». Файл реестра читает разборщик Kafka по тем же правилам, что и прочие файлы
     (клиент в импортах или имя из реестра топиков, а в тексте слово kafka: у Sentry
     `sentry.conf.types.kafka_definition`). До В5 у Sentry 32 такие подсказки: объектов
     процессов ещё нет.
   - В5 (решение исполнителя): режимы devservices (`modes`) к программам не применяются: у
     Sentry все 21 программа перечислены только в режимах, кроме `default`, и правило
     режимов убрало бы их целиком, а цель пункта — объекты процессов. Каталог кода
     программы — корень обхода (у Sentry код в корне, файл в `devservices/`), поэтому в части
     2 код `src/` принадлежал 21 контейнеру из корня, а не единственному `self-hosted`
     (правило `sole_owner` не действовало): маршруты HTTP (945) перешли к `devserver`
     (единственный «сервис» среди владельцев), параметры кода (109) писались каждому из 21
     контейнера, а связь владельца миграций с базой стала `devserver → postgresql` вместо
     `self-hosted → postgresql`. Часть 2б это исправила правилом Д10 (ниже): программы
     каталога кода не получают, код снова у `self-hosted`. Связей с Kafka у Sentry 30: 20
     «доставляет» по `topic` и журналу фиксаций и 10 «публикует» по `dlq_topic` и
     `stale_topic`; два процесса только из реестра остаются в подсказках.
   - Д1 (решение исполнителя): тег образа считается признаком только у сервиса без `build`
     (образ берётся готовым). У сервиса с `build` ключ `image` называет результат локальной
     сборки: Forem `docker-compose.yml` даёт web, rails и sidekiq через якорь с
     `build: {target: development}` и `image: ghcr.io/forem/forem:1.0.0-development`, и по
     букве правила (последняя часть `development`) боевой файл целиком ушёл бы в подсказки.
     Варианты образов Chainguard не признак при последней части `dev` любого тега
     (`latest-dev` и версии с `-dev`), а не только `latest-dev`. Стадия сборки
     `build.target: development` признаком не сделана: пункт её не называет.
   - Д2: перечень обхода несёт отдельно файлы, исключённые только каталогами документации
     (`Listing.docs`); их видит лишь разборщик openapi, ссылки `$ref` разворачиваются и
     внутри таких каталогов (у Sentry `api-docs/openapi.json` снова в подсказке, 18 операций
     по `api-docs/paths/*.json`). Каталог с частью examples или samples (`docs/examples/`)
     документацией не считается.
   - Д3 (решение исполнителя): «package.json с зависимостями сервера» — серверный фреймворк
     словаря (`vocab.SERVER_FRAMEWORKS`) в `dependencies` корневого `package.json` без
     `workspaces` (у Zulip koa: имя `zulip`, как раньше). Язык корня без такого
     `package.json` выбирает `stack_of` среди остальных манифестов корня. Побочное: у PostHog
     корневой `package.json` (`@posthog/root`) серверного фреймворка не держит, и система
     называется `posthog` по `pyproject.toml`; объекты и связи PostHog те же.
   - Д4 (решение исполнителя): признак CI по пути (`walk.ci_sign`), а не по тексту признака
     разработки: каталог с частью `ci` после разбиения имени (`ci/`, `.ci/`, `ci-matrix/`),
     файл или каталог из `ci_rule` и compose с частью `ci` в имени. Файлы CI и такой compose
     обход и так не читает, поэтому на деле правило задевает каталог (и пути, возвращённые
     `--include`). Причина подсказки отдельная, «манифест CI: каталог ci/», чтобы рядом с
     объектами стенда разработки было видно, почему эти кандидаты объектами не стали; кандидат
     с именем сервиса стенда подсказки не даёт. У Envoy вместе с шестью объектами ушли 57
     параметров конфигурации их окружения (переменные матрицы сборки) и пометка «объекты
     собраны из манифестов разработки»: объект `envoy` из `distribution/docker/Dockerfile-envoy`
     боевой. Проверка стека С12 (матрица ci/ на Bazel) перенесена на compose в корне.
   - Д5 (решение исполнителя): кроме перечня, `coverage` убран и из пропусков яруса кода
     (`codebase.is_code_file`, `crontab`; `walk.CODE_SKIP_DIRS`), иначе файлы
     `pkg/util/coverage/` Kubernetes попадали бы в прочитанные, но код их не читал бы. Без git
     такие файлы в перечень не попадают, поэтому для обхода без git ничего не изменилось.
     Kubernetes: параметры `KUBE_COVERAGE_FILE` и `KUBE_COVERAGE_FLUSH_INTERVAL` из
     `pkg/util/coverage/coverage.go` в подсказках «общий код» (без владельца 32 → 34), объекты
     и связи те же; у Envoy `bazel/coverage/` и `tools/coverage/` ушли из исключённых.
   - Д6 (решение исполнителя): «смешанный проект» определяется языком контейнера: Gradle с
     плагином Kotlin собирает и Java того же модуля, поэтому контейнер на Kotlin владеет и
     `.java`, если среди владельцев каталога нет контейнера на Java (точное совпадение языка
     старше). Обратного нет: Gradle без плагина Kotlin и Maven файлы `.kt` не компилируют. Maven
     с `kotlin-maven-plugin` по-прежнему даёт язык Java, и его `.kt` теперь «нет контейнера на
     этом языке»; ярус кода JVM не читает, поэтому на выводе дымовых (OpenTelemetry Demo,
     Keycloak, Petclinic) правило не видно, вывод байт в байт тот же.
   - Д7 (решение исполнителя): «postgres*», «kafka», «redis» взяты по технологии словаря
     образов (`vocab.image_kind`: PostgreSQL, Redpanda, Kafka, Redis, то есть и `bitnami/postgresql`,
     `cp-kafka`, `valkey`), а не по началу имени: так `postgres-exporter` не задет. Клиенты
     хранилища — по пути образа (`minio/mc`, `rustfs/rc`) или имени (`minio-client`, `rclone`).
     «Не запускает сервер» — среди слов команды (entrypoint и command вместе) нет программы
     сервера образа на месте программы: слово после ключа (`psql -U postgres`) не программа,
     слово после `sh -c` программа; команда из одних обёрток (`docker-entrypoint.sh`)
     запускает сервер по умолчанию. Строки команды compose при разборе склеены в одну, поэтому
     позиция программы после перевода строки не видна, и упоминание сервера в любом месте
     скрипта (кроме значения ключа) оставляет сервис по прежним правилам: ошибка в безопасную
     сторону. У k8s признаком служит только `kind: Job` (Deployment со словом init не задача).
     Объект со своим каталогом кода (образ собирается) правилом не задет. Подсказка вида
     `container` в `hints.unassigned` в счёт семьи не входит, как и Dockerfile мобильного
     приложения. Правило А8 остаётся для задач без признака (оболочка и depends_on на тот же
     образ); фикстура `compose-task` переименовала kafka-init в topics, чтобы его проверять.
     PostHog: объекты `kafka-init` и `personhog-tables-ready` и их связи `→ kafka`, `→ db`
     ушли (в вердикте wrong-kind); Supabase: `minio-createbucket`, `rustfs-createbucket` и
     связь `minio-createbucket → minio`; остальные дымовые без изменений.
   - Д8 (решение исполнителя): «name_words» для имени проекта compose — части между `-` и `_`
     (`walk.name_tokens`): имя проекта compose по правилам Docker из строчных букв, цифр, `-` и
     `_`, разбиение по регистру ему не нужно. Значение раскрывается как остальные поля compose
     (`${VAR:-дефолт}`). Признак проверяется после чтения файла, как «Laravel Sail», поэтому
     файл со стендом читается в общем порядке, а его сервисы, которых нет в боевых файлах,
     становятся кандидатами разработки. PostHog: девять `clickhouse-*` из
     `docker-compose.multinode-clickhouse.yml` в `hints.profiles` («осталось» по объектам
     10 → 1, дубль `posthog-metrics-agent`); вместе с ними ушли девять связей `clickhouse-* →
     kafka`, которые вердикт отметил ok при объектах dev-only (связи между объектами
     разработки, как известные потери Lemmy и PostHog).
   - Д9 (решение исполнителя): имя системы для префикса — последняя часть имени системы
     после «/» (`@mastodon/mastodon` → `mastodon`) и имя каталога корня. Пара ищется только
     среди контейнеров (вид «сервис»), поэтому `mastodon-db` и база `db` не склеиваются; семьи
     манифестов разные, если у объектов нет общего разборщика (как у склейки по команде).
     Каталог кода у короткого не меняется, технология и роль остаются его, источники и
     окружение длинного переходят к нему (`_absorb`). Mastodon: `mastodon-web → web` и
     `mastodon-streaming → streaming` в `hints.merged`, «осталось (duplicate)» 2 → 0, ok-объекты
     3 и ok-связи 6 сохранены; на остальных шести репозиториях и 15 дымовых склеек нет.
   - Д10 (часть 2б, решение владельца 2026-11-08): процесс, заданный только командой
     (программа Procfile или `x-programs`, юнит systemd или supervisor без своего Dockerfile,
     образа и контекста сборки), каталога кода не получает, если есть контейнер со своей
     сборкой (Dockerfile или контекст сборки) того же языка или без определённого языка.
     Решение исполнителя: правило действует после склеек по имени и по команде (§13.5), иначе
     `mastodon-sidekiq` (systemd) потерял бы общий с compose `sidekiq` каталог и не склеился;
     сборка забирает код процесса, только если каталоги вложены (у Sentry `self-hosted/` в
     корне программ), а сборка без языка — только если её каталог охватывает каталог процесса
     (Procfile в `services/orders` рядом с контекстом сборки compose). Без этого уточнения
     logstash AWX (`tools/`, FROM logstash, язык не определён) забирал весь код `awx/` у
     программы supervisor `awx-uwsgi`: маршруты 339 и параметры ушли бы к нему. Технология
     процесса остаётся той, что дал корень (Python + Django у программ Sentry). Sentry:
     `facts/self-hosted.config.yaml` 109 параметров, остальные 21 файл конфигурации ушли,
     маршруты 945 у `self-hosted`, связь `self-hosted → PostgreSQL` вместо `devserver →
     PostgreSQL`; Mastodon: `mastodon-prometheus-exporter` (systemd) без каталога кода, файл
     его параметров из примера окружения корня ушёл (они у web и sidekiq); фикстура
     `procfile` (Procfile в каталоге сборки orders): у orders путь к коду, общего каталога нет.
     Остальные репозитории перемера и дым без изменений владельцев фактов.
   - Остаток после части 2 (перемер 2026-11-07 на fdd3e96e против выводов судьи части 1б):
     лишних объектов шести вердиктов 15 → 4 (PostHog `posthog-metrics-agent`, immich
     `immich-grafana` и `immich-prometheus`, Argo CD `gitops-agent`); ok-объекты сохранены,
     кроме прежней базы Lemmy под именем postgres; ok-связи сохранены, кроме связей объектов
     разработки (Lemmy 5, PostHog 16: к прежним семи добавились девять `clickhouse-* → kafka`
     с объектами стенда multinode, Д8). Кандидаты `[channels] KAFKA_EVENTS_PLUGIN_INGESTION`
     PostHog и `QueueName` immich в проверке судьи «нет», потому что она ищет имя реестра в
     тексте вывода, а в вывод идут сами каналы: Kafka PostHog 0 → 56, очереди Redis immich 19.
     Sentry: core 5 узлов и 52 канала прежние, «rule-candidate, но у сборщика есть» 19 узлов и
     30 связей, неучтённые объекты сверх них только `devserver` и `taskworker-sentry`, связь
     `devserver → postgresql` вместо `self-hosted → postgresql`; два процесса только из
     реестра консьюмеров в подсказках. Дым: Envoy 7 → 1, Supabase 18 → 16, Forem 8 → 7 (и
     связи `rails → db`, `sidekiq → db` из версий разработки в `container-compose.yml`, Д1),
     Nomad система `nomad` и 2 → 1 (объект корневого Dockerfile назывался `nomad-ui` по
     системе, теперь `nomad` и совпал с юнитом systemd), остальные 11 без изменений объектов
     и связей.
   - Остаток после части 2б (перемер 2026-11-08 на 2f47cf9a против выводов судьи части 2):
     регрессий шести вердиктов нет, кроме прежней базы Lemmy под именем postgres; «заменена
     связью с каналом» ровно две связи (`sidekiq → redis` Mastodon, `web → kafka` PostHog),
     «ушла с объектом» прежние связи объектов разработки (Lemmy 5, PostHog 16). Связи: Mastodon
     11 → 11 (минус «использует» `sidekiq → redis`, плюс `redis → sidekiq [scheduler]`),
     PostHog 133 → 132, Forem 12 → 11, `yarmarka.expected` 10 → 8. Sentry: layers-check
     проходит (core 24 узла, 30 связей, 52 канала; scanner_false `devserver` и
     `taskworker-sentry`), `facts/self-hosted.config.yaml` 109 параметров, маршруты 945 у
     `self-hosted`, связь `self-hosted → PostgreSQL`. Mastodon: параметры
     `mastodon-prometheus-exporter` из примера окружения корня ушли к web и sidekiq (Д10).
     Дым: объекты прежние, связи прежние, кроме Forem. Время на машине перемера выросло у
     всех репозиториев в 1,3–1,6 раза (PostHog 49 с, n8n 10 с при пределах 45 и 10 с); замер
     той же машиной сборок частей 2 и 2б подряд даёт те же числа (PostHog 49,4 и 48,9 против
     49,0 и 50,4 с, n8n в среднем 9,3 и 9,3 с), то есть это не код.
14. **Решения исполнителя части 3** (2026-11-08, ветка feat/scan-3d, сборщик 0.4.0 без выпуска;
   параметры через обёртки, связи второго порядка, таблицы Rails и Kysely, пути OpenAPI,
   Rust; владелец может отменить, числа перемера в конце пункта).
   - Е1 (решение исполнителя): обёрткой считается только функция, не метод: вызов метода
     (`cfg.Get("X")`) по импорту файла к пакету не привязать. Параметр-имя должен иметь тип
     `string` и стоять в `os.Getenv`/`os.LookupEnv` целиком (`"OTEL_" + name` не обёртка) или
     среди аргументов `viper.BindEnv`. Дефолт берётся из аргумента сразу за именем, только
     если у обёртки там параметр со словом default или fallback: у `mustMapEnv(target, envKey)`
     дефолта нет, а аргумент после имени у других обёрток бывает логгером или ключом.
     Обёртки через другую обёртку (транзитивные) не раскрываются. Пакет вызова
     `пакет.Имя(` находится по импорту файла: псевдоним, иначе последняя часть пути без
     `/vN` или строка `package` каталога; путь импорта переводится в каталог по `module`
     ближайшего `go.mod` (импорт не из модулей репозитория обёрткой и константой не
     считается). Константа — объявление верхнего уровня `Имя [Тип] = "литерал"` в `const`
     или `var` (одиночное или в блоке); её место идёт в основания параметра вместе с местом
     чтения, владелец по месту чтения. То же раскрытие действует и для прямых
     `os.Getenv(Имя)`. Чтение по параметру внутри самой обёртки подсказкой о динамическом
     имени больше не пишется: имена дают места вызова.
   - Е2 (решение исполнителя): обёртка — функция уровня модуля (не метод и не вложенная),
     читающая окружение по ПЕРВОМУ параметру; дефолт, как у Go, только при втором параметре
     со словом default или fallback (позиционно или именем этого параметра), тип по
     `type_cast=` (int, float, str, bool, str_to_bool). Пункт велит переиспользовать механизм
     В1: вызов обёртки сопоставляется с определением тем же путём, что голое имя реестра
     каналов (свой файл или импорт через `codebase.resolve_module`), а модуль-посредник
     («from posthog.settings import get_from_env») проходится по его импортам «from x import
     f» не больше трёх шагов; реэкспорт звёздочкой не раскрывается. Распознавание
     `get_from_env` в модулях-реестрах каналов (`pyregistry.literal_part`) не менялось:
     каналы вне пункта. Имя константой модуля (своего или импортированного) раскрывается и у
     прямых `os.getenv(ИМЯ)`, как у Go; место присваивания в основаниях.
   - Е3 (решение исполнителя): у immich схема `EnvSchema` объявлена в
     `server/src/dtos/env.dto.ts`, а к `process.env` её применяет другой файл
     (`server/src/repositories/config.repository.ts:209`), поэтому «в том же файле» прочитано
     как «файл применяет схему, объявленную у себя или импортированную по имени»: модуль
     ищется по относительному пути или как единственный файл кода с тем же хвостом пути без
     расширения (псевдоним `src/…`). Основание параметра — строка ключа в файле схемы (по ней
     и владелец), место применения — второе основание. Тип числа: int при `.int()` или целом
     дефолте, иначе float; `z.stringbool()` — bool; имя константы-валидатора того же файла
     (`stringBool.optional()`) раскрывается её цепочкой, импортированная схема
     (`ImmichEnvironmentSchema`) вида не даёт, и тогда required не ставится. Перечень
     `z.enum([...])` пишется полем `description` («Одно из значений: …»): это значения из
     кода, а не пересказ смысла; у `z.enum(TsEnum)` перечня нет. Применение к схеме без имени
     (`z.object({…}).parse(process.env)`) не читается.
   - Е4 (решение исполнителя): «иглы `Configuration[`» прочитаны без учёта регистра первой
     буквы (`configuration["X"]` из того же пункта иначе не находится); индексатор берётся у
     любого имени configuration (`builder.Configuration`, `_configuration`), но не у
     `IConfiguration[]` и не у `config[…]`: без типа словарь от конфигурации не отличить.
     `GetEnvironmentVariable` — только у `Environment`. Запись `Configuration["X"] = …` не
     чтение. Маска C# держит подстановки интерполированных строк кодом (`$"{configuration["X"]}/…"`
     у eShop Identity.API: пять адресов клиентов только так и читаются); дословная и сырая
     строки маскируются целиком. Дефолт C# — литерал после `??`, `?? throw` — обязателен;
     у Java дефолт только из `getOrDefault`, `Optional…orElse` не читается. Тип — по
     вызову, аргументом которого стоит чтение (`Integer.parseInt`, `bool.TryParse`,
     `Convert.ToInt32`, `TimeSpan.Parse`), иначе по дефолту. Имя константой: поле
     `String/string ИМЯ = "литерал";` с final, const или readonly в строке объявления; того же
     файла, файла класса по `Класс.ИМЯ` (файл с именем класса один, выбран импортом Java или
     лежит в том же каталоге) или статического импорта Java; константа интерфейса без
     модификатора не раскрывается. Каталог тестов по имени (`*Tests/`, `*.Tests/`, `*-tests/`)
     не читается; `src/test/` и `tests/` и так исключены обходом. В файле больше 2000 чтений
     одного вида — файл непрочитан (враждебный вход). Kotlin (`.kt`) не читается: пакет
     Gradle с плагином Kotlin остаётся языком Kotlin в `unsupported`. Покрытие: `.NET` и
     `Java` больше не называются в `unsupported` семьи config (`vocab.CONFIG_LANGUAGES`), но
     в маршрутах, каналах, воркерах и расписаниях называются по-прежнему
     (`vocab.CODE_LANGUAGES`); у пакета Java со Spring Boot в config остаётся
     «Java: Spring Boot» (`application.yml` и `@Value` не читаются, §6.4), иначе Petclinic
     получил бы covered без единого чтения.
   - Ж1 (решение исполнителя): под выбирается по одной метке селектора: сначала
     `app.kubernetes.io/name`, иначе `app`; прочие метки селектора не сверяются. Основание
     связи — строка этой метки в пире (`argocd-redis-network-policy.yaml:19`), иначе строка
     пира. Пир с `namespaceSelector` (и вместе с `podSelector`: поды другого пространства
     имён) или `ipBlock` молча пропускается; правило `ingress: - {}` без `from` (доступ
     отовсюду) связей и подсказок не даёт. `podSelector: {}` у политики (одна подсказка на
     политику, имя — `metadata.name`) и у пира (подсказка на пир) — `hints.unassigned` с
     причиной «политика сетевого доступа относится ко всем подам»; та же подсказка у пира,
     чья метка выбирает больше 50 пар подов (враждебный вход не размножает связи). Метка без
     Deployment или StatefulSet — «под по меткам не найден»; если конец не стал объектом
     (под из файла разработки), причина «другой конец связи не объект схемы». Технология связи —
     технология цели, если цель база или брокер, у сервиса пусто. Связь к самому себе
     (egress redis-ha → redis-ha) не рисуется. Пара из env (`REDIS_ADDR`) и из политики —
     одна связь со всеми основаниями; подсказка depends_on для пары, уже нарисованной
     политикой, не пишется.
   - Ж2 (решение исполнителя): ConfigMap для `configMapKeyRef` ищется в том же файле, затем
     в каталоге файла, затем в ближайшем каталоге-предке (у Argo CD значение
     `redis.server: argocd-redis-ha-haproxy:6379` приходит из отрендеренного
     `manifests/ha/namespace-install.yaml`, где Deployment и ConfigMap лежат вместе; оверлей
     `manifests/ha/base/overlays/` предком `manifests/base/server/` не является, и нагрузки
     обычной установки HA-значения не получают). Не найден — переменная без значения, как
     раньше. `envFrom.configMapRef` ищет ConfigMap так же, но без находки берёт последний
     с этим именем, как раньше (иначе пропали бы параметры). Строка `data` значения идёт в
     основания связи вместе со строкой env. Встроенный патч сливается с первой по пути
     нагрузкой того же имени: переменные того же имени заменяются, новые добавляются,
     образ и команда только если у нагрузки их нет; патч без такой нагрузки объекта не
     создаёт, патч без `metadata.name` (адресованный через `target`) не читается, элемент
     env с `$patch: delete` переменной не даёт. Патч JSON 6902 — `hints.unparsed` с местом
     ключа `patch`. Патчи файлами (`path:`) читает обход как обычные манифесты k8s.
     Каталоги `components/` и `overlays/` в `walk.DEV_TOKENS` нет, правка политики Б не
     понадобилась.
   - Ж3 (решение исполнителя): прокси — образ с ролью «прокси» в словаре (nginx, Traefik,
     HAProxy, Envoy) или имя образа `caddy`, `openresty` (Caddy в словарь образов не
     добавлен: технология и роль объекта не меняются). Том — bind-путь, начинающийся с
     «.», «/» или «~»: именованный том и путь только в контейнере (`/root/.caddy`) не
     файлы; абсолютный путь и путь выше корня — `hints.unparsed` «вне репозитория»,
     отсутствующий в обходе (в том числе исключённый соглашением) — `hints.unparsed`
     «не найден». Том-каталог читается своими файлами без подкаталогов, не больше 50.
     Caddyfile в environment — любое многострочное значение переменной прокси, строки
     считаются от строки после ключа (значение блоком `|`). nginx: `server` только внутри
     `upstream { }`, `proxy_pass` к имени upstream адресом не считается, `grpc_pass` — как
     `proxy_pass`; HAProxy: `server имя адрес` в секциях `backend` и `listen`; Caddy:
     аргументы `reverse_proxy` кроме матчеров (`@имя`, путь, `*`), подблок `to` не
     читается. Traefik и Envoy читаются теми же правилами (их собственные форматы —
     `url:` и `socket_address` — пунктом не названы и не разбираются). IP, localhost,
     unix-сокет и адреса с подстановкой связей не дают; не больше 200 адресов на файл.
     Технология связи HTTP и у цели-базы (MinIO `objectstorage` у PostHog). Связи едут с
     кандидатом (`Unit.links`): у сервиса разработки, не ставшего объектом, они пропадают
     вместе с ним, а не превращаются в подсказки.
   - З1 (решение исполнителя): `default:` читается, но не пишется: у колонки в
     `facts/*.tables.yaml` поля дефолта нет и у SQL-разборщика (контракт тот же). Первичный
     ключ `id` bigint ставится, если нет `id: false`; `id: :uuid` (символ) задаёт тип,
     `primary_key: "var"` — имя, список `primary_key: ["a", "b"]` — составной ключ без своего
     `id`, колонки ключа обязательны. Ссылка `add_foreign_key` без `column:` идёт в колонку
     `единственное_число_цели_id` по правилам Rails (`statuses` → `status_id`, `policies` →
     `policy_id`); колонка не найдена — ссылки нет. Тип `t.column "к", :тип` — второй
     аргумент. `enable_extension` и `create_schema` идут в `hints.unassigned` с причиной
     «расширение или схема базы в schema.rb: таблиц не задаёт»: в схему базы им писать некуда.
     Прочие инструкции define (`create_trigger` с цепочкой вызовов через «.» в конце строки и
     блоком `do … end` у Forem, `execute` с heredoc) пропускаются целиком, со счётчиком, если
     инструкции нет в перечне известных (`add_index`, `create_view`, `create_enum`,
     `create_function`, `create_trigger` и т. п.). Диалект без драйвера в Gemfile пакета
     файла не ставится (технология базы прежняя). `db/structure.sql` рядом отменяет чтение
     `schema.rb`: это тот же снимок, а два источника дали бы таблицы дважды.
     Владелец базы — по §7 без изменений. Mastodon: 116 таблиц у `db` (PostgreSQL по
     `gem "pg"`), `unsupported` таблиц ушёл. Forem: 133 таблицы, но все в `hints.unassigned`
     «несколько баз, владелец не определим»: в двух файлах compose две базы (`db` и
     `postgres`), а контейнеры rails, sidekiq и web собраны из корня и каталога кода не
     получили (§15 п. 13), поэтому база по каталогу не находится; правило владельца не
     расширялось.
   - З2 (решение исполнителя): кроме тегированных шаблонов ``sql`…` `` (и `sql<Тип>`)
     читается текстовый аргумент ``sql.raw(`…`)``: это тот же SQL для Kysely, и у immich
     переименование таблиц `StandardizeNames` идёт только им (с вставками имён, поэтому
     подсказка, а не переименование). Тело функции `down` (функция, свойство или
     переменная со стрелкой, метод) не читается: иначе откат удалял бы таблицы, созданные
     `up`. Из шаблона применяются только инструкции CREATE, ALTER, DROP и RENAME: фрагменты
     для построителя (``sql`now()` ``) и запросы данных пропуском не считаются. Зависимость
     kysely не требуется (шаблоны `sql` есть и у других библиотек), стек — пакет Node.js;
     владелец каталога миграций — контейнер Node.js (`file_owners` с языком). Вставка
     заменяется заглушкой `archmap_dyn_N`: таблица с ней в имени (CREATE TABLE
     `${sql.table(x)}`), цель инструкции таблицы (`ALTER TABLE "${old}" RENAME TO …`), колонка
     и ссылка на таблицу с ней в схему не попадают, а пишутся в `hints.dynamic_names` с
     `kind: table`, именем `${выражение}` и местом вставки; число таких подсказок —
     `coverage.tables.dynamic_names`. В типе колонки (`"embedding" ${sql.raw(t)}(512)`)
     остаётся текст вставки, на месте значения (`DEFAULT ${x}`) заглушка ничего не меняет.
     Стек «Kysely» снимается с `unsupported` у пакета, в каталоге которого прочитан набор
     kysely: иначе (построитель схемы) он остаётся. Пределы файла: 5000 шаблонов,
     20 000 «;» и вставок; сверх — файл непрочитан. `CREATE TABLE … AS SELECT`: имя колонки —
     псевдоним `AS имя` или имя колонки (`person_id`, `c.comment_id`; PostgreSQL называет её
     так же), тип не выводится, обязательность `false` до `ALTER … SET NOT NULL`; «*»,
     выражение без псевдонима и запрос не SELECT (`TABLE`, `VALUES`, `WITH`) оставляют
     подсказку «колонки из запроса» (её текст уточнён). Побочно: номер строки инструкции в
     `sqlddl.split_statements` считается от прошлой инструкции (было от начала текста, то
     есть квадратично по числу инструкций; враждебный файл из 80 000 `ALTER` шёл 29 с).
     immich: 72 таблицы у `database` (PostgreSQL по `"pg"` в `server/package.json`), 7
     удалены, одна подсказка о динамическом имени (`StandardizeNames.ts:40`); 30 таблиц,
     которые эта миграция переименовывает в цикле по массиву имён, остаются под прежними
     именами (`users`, `assets`), и `ALTER` поздних миграций к новым именам (`asset`) им не
     применяются. Lemmy: у `comment_actions` и семи других таблиц из запроса колонки и
     первичный ключ, подсказок «колонки из запроса» 8 → 0.
   - З3 (решение исполнителя): «среди нескольких контейнеров» прочитано так: среди сервисов,
     чей каталог кода содержит файл, а если таких нет, среди всех сервисов схемы. Имя
     сервиса ищется целиком с границами слова в пути файла, `info.title` и адресах
     `servers` (у Swagger 2.0 — `host` и `basePath`), слово команды — среди слов этого
     текста; общие слова команд (интерпретаторы, `bin`, `run`, `api`, `http`, `openapi`)
     и слова короче трёх букв не считаются. Файл чужого API — все адреса `servers` с
     хостом на внешнем домене (схема и хост с точкой, не localhost, не IP, без переменных
     `{…}`); относительный адрес и имя сервиса compose — свои, один свой адрес рядом с
     внешним делает файл своим; подсказка с причиной «спецификация чужого API». Маршрут
     из файла: метод и путь как в файле (без `basePath`), источник — строка ключа пути
     (у JSON — первая строка `"/путь":` в тексте), не больше 10 000 операций на файл.
     Совпадение с маршрутом кода владельца — по методу и пути с параметрами в одной форме
     (`{id}`, `:id`, `<int:id>`) без конечной «/», с префиксами пустым, путём относительного
     адреса `servers` и `basePath`; у записи кода появляется `openapi_source` (поле
     `entrypoints.yaml` добавлено, прежние не менялись), новая запись не заводится.
     Подсказка `hints.openapi_files` остаётся и у файла с владельцем (с `object`): по ней
     агент кладёт спецификацию в раздел «OpenAPI» объекта. Без сервисов в схеме и у файла
     без операций причина прежняя. В `coverage.http_routes.parsers` разборщик `openapi`
     появляется, только если дал маршрут; `from_code` от него не меняется. Argo CD: правило
     владельца не сработало, файл остался подсказкой «владелец не определим: контейнеры
     argocd-application-controller, …, argocd-server» (шесть сервисов). Причина: все
     нагрузки Argo CD — один образ `quay.io/argoproj/argocd` из корневого Dockerfile
     (`argocd-server` — ссылка на общий бинарник), каталога кода нет ни у одного
     контейнера, а в `assets/swagger.json`, заголовке «Consolidate Services» и пути нет ни
     имени, ни слова команды. Нужное уточнение (не сделано, решение архитектора): владелец
     по коду, который отдаёт файл (`assets/embed.go` встраивает `swagger.json`,
     `util/swagger` регистрирует путь `/swagger.json`, вызывает его `server/`), при
     каталоге кода у контейнеров образа, собранного в репозитории, либо ручной выбор
     агентом по подсказке. Grafana (вне перемера): 314 операций двух копий файла у
     `grafana`, 236 совпали с маршрутами кода, 78 новых записей.
   - И1 (решение исполнителя): Dockerfile подходит, если в нём объявлен `ARG X` и есть
     `--bin $X`, `--bin ${X}` или `--bin=$X`; Cargo.toml с `[workspace]` берётся только из
     каталога Dockerfile. Члены workspace — пути как написаны и шаблон `каталог/*`
     (подкаталоги с Cargo.toml); другие шаблоны и `exclude` не читаются, не больше 500
     членов. Крейт без `src/main.rs` (библиотека, только `src/bin/*.rs` у `logs-ingestion`
     PostHog) контейнером не становится, как велит пункт. Роль — по словам имени крейта
     (`batch-import-worker`, `flags-consumer` — воркеры), без слов — по общим правилам
     (сервис); воркером по умолчанию, как у Procfile, крейт не считается: бинарник бывает и
     сервером HTTP. Признак разработки — по пути Dockerfile (`walk.manifest_sign`) и по пути
     Cargo.toml крейта (`walk.dev_sign`): `personhog-test-harness` PostHog с частью `test`
     уходит в `hints.profiles`. Кандидат крейта получает Dockerfile (`Unit.dockerfile`),
     поэтому сам Dockerfile отдельного контейнера `rust` не даёт. Склейка по имени с
     сервисом compose или k8s: каталог кода объекта — каталог крейта, если сборка сервиса
     шла из каталога workspace или каталога не было (`assemble._crate_dir`); у сервисов с
     другим именем (`capture-ai` с `BIN: capture`) каталог прежний. PostHog: 19 новых
     контейнеров Rust (affected-services, batch-import-worker, capture-apm-metrics,
     capture-load-gen, cohort-event-shuffler, cohort-seeder, cohort-stream-processor,
     embedding-worker, flags-consumer, ingestion-consumer, ingestion-control-plane,
     kafka-assigner, kafka-deduplicator, personhog-parity-monitor, personhog-stateright,
     pgapi, pgcollector, property-vals-rs, replay-recorder-v4), у 13 сервисов compose
     каталог кода `rust/<крейт>` и `source.path`, `cymbal` и `personhog-changelog-relay`
     получили технологию Rust вместо имени образа; ok-объектов потеряно 0, связи прежние.
     Среди новых есть похожие на инструменты разработки (`capture-load-gen`,
     `personhog-stateright`, `affected-services`, `cohort-seeder`,
     `ai-research/replay-recorder-v4`): правило пункта их не отличает, вердикт за судьёй.
     Решение владельца 2026-11-08: крейты остаются объектами без нового признака разработки
     (слово `research` в `walk.DEV_TOKENS` не добавляется), код не меняется.
   - И2 (решение исполнителя): читаются только поля с атрибутом `#[envconfig(…)]`; поле
     структуры с `derive(Envconfig)` без атрибута (крейт читает и его) пунктом не названо и
     не читается. Поле ищется после атрибута через другие атрибуты (`#[serde(…)]`) и
     пробелы; основания — строка атрибута и строка поля. clap: атрибуты `#[arg(…)]` и
     `#[clap(…)]` только с ключом `env`; `env` без значения — имя поля в верхнем регистре,
     как у самого clap; флаг `bool` без дефолта не обязателен (у clap это ложь), поле
     envconfig без дефолта и не `Option` обязательно. Дефолт — строка или литерал (число,
     `true`, `false`); выражение (`default_value_t = DEFAULT_PORT`) — дефолт есть, текста
     нет. `env::var`: дефолт из `.unwrap_or("v")` и `.unwrap_or_else(|_| "v"…)`,
     `.unwrap()`, `.expect(…)` и `?` — обязателен, иначе не обязателен. Отклонение от
     буквы пункта: `option_env!("X")` пункт перечисляет среди параметров, но его, как и
     `env!`, подставляет компилятор, поэтому он тоже идёт в `hints.unassigned` «переменная
     времени сборки» (причина в `texts.ASIDE_REASONS`: в счёт «без владельца» не входит);
     переменные самого Cargo (`CARGO_*`) не пишутся вовсе. Модуль тестов `#[cfg(test)] mod …
     { … }` не читается, каталоги `*Tests/` — по правилу Е4. Маска Rust: сырые строки
     `r"…"`, `r#"…"#`, символ ровно из одного знака (время жизни `'a` литералом не
     считается). «Rust» больше не называется в `unsupported` семьи config
     (`vocab.CONFIG_LANGUAGES`), в маршрутах, каналах, воркерах и расписаниях — по-прежнему.
     PostHog: параметров с основанием в коде Rust 1477 записей у 33 контейнеров, 1082
     уникальных имени (`rust/capture/src/config.rs:306` KAFKA_REPLAY_ENVELOPE_COMPRESSION с
     дефолтом none); код общих крейтов `rust/common/*` достаётся сервисам compose с общим
     каталогом `rust/` (`capture-ai`, `replay-capture`, `personhog-router-leader`) по
     прежнему правилу общего каталога. Lemmy: у `lemmy` 2 → 13 параметров, из кода Rust 12
     (пять из clap в `crates/server/src/lib.rs`, семь из `env::var`, среди них `PGDATA` из
     `crates/db_views/post/src/db_perf/mod.rs:171`).
   - И3 (решение исполнителя): `pgautoupgrade` в словаре и обёртка ClickHouse по слову в
     имени были уже с части 2 (А13), поэтому Lemmy `postgres` и PostHog `clickhouse` базами
     были и до пункта; пункт обобщил правило ClickHouse на весь словарь. Порядок: точное имя,
     имя без хвоста сборки, последняя часть через дефис (как раньше), затем часть имени
     через дефис или подчёркивание. Слова программ вокруг базы (`_TOOL_PARTS`: клиент и
     консоль, экспорт метрик, координатор, резервные копии, оператор, веб-интерфейс,
     коннектор и REST-шлюз Kafka, служебный API `postgres-meta`, установщик, `test`, `e2e`,
     `init`, `migrate`, `setup`) снимают правило части целиком; две разные технологии в
     частях (`redis_mongodb`) тоже, вид наугад не выбирается. На образах всех клонов
     (корнер-кейсы и дым) вид сменили семь: `docker-redis-cluster` Sentry (сервис в режиме
     devservices, в `hints.profiles`), `nginx-certbot` Supabase и `nginx-proxy` Grafana
     (прокси nginx), `postgresql-15-c9s` Keycloak (тестовый ресурс оператора), стадия
     `envoy-base` Envoy, `kafka-assigner` и `kafka-deduplicator` PostHog (только в
     `.github/rust-images.yml`, манифестом не читается). Последние два показывают предел
     правила: свой сервис с именем на слово брокера по образу был бы брокером, но у
     контейнера с каталогом кода вид по образу не берётся.
   - Ф1 (раунд 3б, решение исполнителя): каталог `cmd/` берётся прямо в каталоге кода
     владельцев файла (у Argo CD корень), вложенные `pkg/cmd/…` (подкоманды kubectl)
     программами не считаются; программа — первый каталог после `cmd/`, файл прямо в `cmd/`
     (`cmd/main.go` Argo CD) программы не задаёт. Программа есть, если под ней лежит хоть
     один файл кода Go (`codebase.is_code_file`, не каталог разработки); список собирает
     `buildfiles` (`Findings.go_programs`), сборка кладёт имена программ каталога в
     `Obj.go_programs`. Соответствие ищется среди владельцев каталога после отбора по языку:
     имя контейнера или `vocab.command_program` одной из его команд (первое слово после
     обёрток, базовое имя пути). Контейнер без своего каталога кода программой не владеет:
     `argocd-dex-server` с командой `/shared/argocd-dex rundex` собран из образа dex, и
     `cmd/argocd-dex` уходит в подсказки. Правило только для файлов `.go`: манифесты сборки
     (`go.mod` в `cmd/<имя>/`) и миграции идут по прежним правилам. Цена точного совпадения:
     `cmd/argocd-notification` при команде `/usr/local/bin/argocd-notifications` контейнера
     `argocd-notifications-controller` уходит в подсказки (8 имён). Argo CD: параметров
     1772 → 830 (argocd-server 299 → 160, argocd-application-controller 296 → 157,
     argocd-applicationset-controller 292 → 141, argocd-repo-server 300 → 149,
     argocd-notifications-controller 290 → 109, argocd-commit-server 288 → 107); имён,
     записанных у всех шести, 287 → 100 (оставшиеся читает код `util/`, `common/`,
     `controller/`, `pkg/`, `reposerver/`, `server/`); в подсказки ушли программы `cmd/argocd`
     (9 имён), `cmd/argocd-notification` (8), `cmd/argocd-cmp-server` (7),
     `cmd/argocd-k8s-auth` (5), `cmd/argocd-dex` (3), `cmd/argocd-git-ask-pass` (1). Loki: два
     маршрута `cmd/logql-analyzer/main.go:47` и `:49` вместо подсказки «владелец не
     определим» у `backend` (команда `logql-analyzer`); Kubernetes и Nomad без изменений (у их
     контейнеров нет каталога кода Go с `cmd/`).
   - Ф2 (раунд 3б, решение исполнителя): предел `_MAX_NAMED` (= `clike.MAX_READS`, 2000)
     считает в файле чтения с именем не литералом обоих проходов go-env: идентификатор и
     `пакет.Имя` (раскрытие константой), выражение и склейку (подсказки). Сверх предела
     разбор файла прекращается, файл отмечается непрочитанным (`files.refuse`), и его
     параметры (литеральные тоже), подсказки, обёртки и константы не учитываются, в том
     числе найденные до предела. Кэш раскрытия по ключу (каталог пакета, идентификатор)
     стоит после выбора пакета по импорту файла, поэтому результат тот же. На
     `wrapper-calls` время уходило не в раскрытие, а в маску и `gocode.call_spans`, который
     проходил каждую «(» перевёрнутой маски. Теперь вызовы ищутся вперёд одним выражением по
     нужным именам (литерал имени в начале, проверка знака перед именем и точки перед ним,
     предел вызовов каждого имени, остановка, когда все имена набрали предел). Набор
     вызовов тот же, go-http (общий помощник) тоже быстрее. Минимум из пяти запусков:
     `named-reads` go-env 0,87 → 0,10 с, `wrapper-calls` go-env 0,68 → 0,51 с и go-http
     0,51 → 0,40 с, `const-block` прежний (около 0,4 с, это маска и блок констант). Вывод
     всех репозиториев с Go (Argo CD, Grafana, Online Boutique, PostHog, Zabbix, Airflow,
     Envoy, Kubernetes, Loki, Nomad, OpenTelemetry Demo) байт в байт тот же, что после Ф1.
     Имя пакета импорта без псевдонима берётся из первого файла каталога со строкой
     `package`, константы каталога читаются только при раскрытии имени. До этого второй
     проход размечал ради имени весь каталог каждого импорта. Время go-env на Argo CD
     0,61 → 0,51 с (минимум из трёх), вывод тот же.
   - Остаток после части 3 (перемер 2026-11-08 на c99c4591 против выводов судьи части 2б;
     перемер после блоков Е и Ж дал те же ok и те же новые связи). Регрессий шести вердиктов
     нет, кроме прежней базы Lemmy под именем `postgres` (теперь объект «база данных»
     PostgreSQL с 58 таблицами, вердикту нужен `expect: postgres`); «осталось» 4 объекта, как
     после части 2 (`posthog-metrics-agent`, `immich-grafana`, `immich-prometheus`,
     `gitops-agent`), ложных связей PostHog 2 (`asyncmigrationscheck → plugins`,
     `temporal-ui → db`). Новые связи без вердикта: Online Boutique 7 к
     `opentelemetrycollector` (Ж2), Argo CD 13 (Ж1 и Ж2, среди них `argocd-server →
     argocd-redis-ha-haproxy`), Lemmy `proxy → lemmy` и `proxy → lemmy-ui`, PostHog 10 от
     `proxy` по Caddyfile (Ж3); новые объекты без вердикта: 19 бинарных крейтов PostHog (И1).
     Параметры: Argo CD 354 → 1772, PostHog 2132 → 6151, immich 41 → 86, Lemmy 12 → 23, Online
     Boutique 78 → 97, Sentry 109 как было. Таблицы: Mastodon 0 → 116, immich 0 → 72. Маршруты
     Argo CD из swagger не получены, вместо них подсказка с причиной (З3). Кандидаты правил
     семей config, tables и containers в проверке судьи «есть»; кандидаты связей «нет», хотя
     все названные связи в выводе: проверка ищет текст «a -> b», а `schema.yaml` пишет связь
     полями `from` и `to`. Sentry: проверка слоёв проходит, core 24 узла, 30 связей и 52
     канала, как после части 2б. Дым 15 репозиториев: коды выхода 0, клоны чистые, объекты
     прежние; связи Loki 0 → 2 (`gateway` по тому nginx, Ж3); параметры eShop 0 → 12 (Е4),
     Airflow 106 → 115 (Е2), Nomad 43 → 48 (Е1); таблицы Forem из `unsupported` в covered с
     133 записями без владельца (З1); маршруты Keycloak 0 → 6 (файл
     `js/libs/keycloak-admin-client/openapi.json` достался `container` по слову `keycloak` в
     команде, З3). Время рядом со сборкой части 2б на той же машине: PostHog 32,9 → 35,4 с
     (+7 %, память 444 МБ), n8n 6,9 → 6,9 с, Airflow 5,6 → 6,0 с, Kubernetes 3,4 → 3,9 с
     (+15 %: второй проход go-env по вызовам обёрток, список файлов Go после перемера
     отбирается один раз), Keycloak 1,06 → 1,40 с (+32 %, то есть +0,34 с: java-env один раз
     читает 5,9 тыс. файлов Java, которых раньше не читал никто); память выросла не больше
     чем на 2 МБ. Не решено: владелец swagger Argo CD (код, который отдаёт файл:
     `server/`, `util/swagger`); 30 таблиц immich под прежними именами после
     `StandardizeNames`; таблицы Forem без владельца (две базы, контейнеры из корня);
     среди новых объектов PostHog похожие на инструменты разработки; параметры Spring Boot
     (`application.yml`, `@Value`), Kotlin, `config[…]` в C# и собственные форматы Traefik и
     Envoy не читаются.
   - Остаток после раунда 3б (перемер 2026-11-08 на a0053bf2 против выводов судьи части 3;
     сборка c22b0ca0 даёт тот же вывод на всех репозиториях с Go). Регрессий шести вердиктов
     нет, база Lemmy с `expect: postgres` сохранена (ok-объектов 5 из 5). «Осталось» те же 4
     объекта, ложных связей PostHog 2. Вывод Online Boutique, Lemmy, Mastodon, immich,
     PostHog и Sentry байт в байт прежний. У Argo CD сменились владельцы параметров (Ф1,
     числа выше), подсказки и три маршрута, которые раньше уходили в подсказку «владелец не
     определим»: `/api/webhook` у `argocd-applicationset-controller`, `/metrics` у
     `argocd-commit-server` и у `argocd-repo-server`. Различных имён параметров Argo CD
     317 → 300, без владельца 33. Кандидаты связей Online Boutique, Argo CD и PostHog в
     проверке судьи теперь «есть» при прежнем выводе, потому что судья поправил проверку.
     Sentry: проверка слоёв проходит, core 24 узла, 30 связей и 52 канала. Дым 15
     репозиториев: коды выхода 0, клоны чистые, вывод прежний, кроме двух маршрутов Loki
     (Ф1). Время рядом со сборкой части 2б, минимум из трёх по процессорному времени (своп
     заполнен, и время по часам между прогонами расходится до полутора раз): Airflow 7,3 →
     7,6 с (+5 %), Kubernetes 4,3 → 4,9 с (+13 %), Keycloak 1,3 → 1,7 с (+0,45 с, принято
     владельцем), PostHog 46,5 → 49,4 с (+6 %), Argo CD 2,8 → 3,5 с (+25 %). Argo CD выше
     предела с части 3 (там 3,7 с): второй проход go-env размечает файлы с вызовами обёрток
     пакета `util/env`, и go-env занимает 0,51 с вместо 0,10 с. Память Argo CD
     32 → 36 МБ, у остальных рост не больше 2 МБ. Не решено: время Argo CD;
     программа `cmd/` с именем не как у команды контейнера (`cmd/argocd-notification`)
     уходит в подсказки.
15. **Решения исполнителя части 4** (2026-11-09, ветка feat/scan-4, сборщик 0.5.0 без выпуска;
   маршруты Rails, ASP.NET Core, actix-web и NestJS, расписания через библиотеки и обёртки,
   хвосты части 3; владелец может отменить, числа перемера в конце пункта).
   - К1 (решение исполнителя): Ruby читается по своей маске (`codetext.RUBY`: комментарий `#`,
     `=begin` … `=end`, `__END__`, строки в `'` и `"` в несколько строк, литералы `%w[]`,
     `%i[]`, `%r{}` с одним уровнем вложенных скобок, heredoc `<<~ИМЯ`, `<<-ИМЯ`, `<<'ИМЯ'` и
     `<<ИМЯ` с заглавным именем, регулярное выражение `/…/` после `(`, `,`, `=`, `:`, `{`, `[`);
     конец heredoc ищется одним выражением по строкам из одного слова, без регулярного
     выражения на имя. Инструкция собирается из строк, пока скобки не закрыты или строка
     кончается `,`, `\`, `=>`, `||`, `&&`; блок открывают `do` в конце инструкции и `if`,
     `unless`, `while`, `until`, `case`, `begin`, `for`, `def`, `class`, `module` в её начале
     (внутри `def`, `class` и `module` записей нет: у Mastodon `def redirect_with_vary`).
     Вложенный ресурс идёт под `/имя/:<имя в единственном числе>_<param>` по правилу
     единственного числа схемы Rails (З1, `railsschema.singular`), как это делает сама Rails
     (`/users/:account_username/statuses/:id` у Mastodon), а не под `/имя/:имя_id` буквой
     пункта. Глагол прямо в блоке ресурса вложен так же, `member` и `on: :member` дают путь
     члена `/имя/:id`, `collection` — `/имя`; `namespace` и `scope` внутри ресурса берут
     префикс вложенного и сбрасывают ресурс. `concern :имя do … end` записей не даёт: его
     тело читается там, где его подключают (`concerns :имя` и `concerns:` у ресурса),
     основание — строка в теле concern; так у Mastodon `followers` и `outbox` идут под
     `/users/:account_username/` и `/ap/users/:account_id/`, а не от корня (буква пункта
     «содержимое без префикса» дала бы маршруты, которых в приложении нет). `scope
     '(:locale)'` даёт префикс как написан (`/(:locale)/about`), нормализацию Rails в
     `(/:locale)` сборщик не делает. `mount` — `hints.unassigned` с видом route, именем
     «движок путь» и причиной `REASON_RAILS_MOUNT`; в счёт «без владельца» она не входит
     (`texts.ASIDE_REASONS`). Перебор списка путей (`%w(…).each { |path| get path }` у
     Mastodon `web_app.rb`, `pages_actions.each do |action|` у Forem) даёт подсказку о
     динамическом пути, список не раскрывается. `devise_for`, `shallow:`, `path_names:` и
     неявный `(.:format)` не читаются. Карта маршрутов движка (`X::Engine.routes.draw`) даёт
     записи с `prefix_unresolved`. Файл отбирается по пути, игл нет. Пределы: 50 000 строк
     файла, 5000 записей на файл, 50 вложенных блоков, 50 000 инструкций на карту (тела
     concern и draw повторяются); сверх — карта не пишется, файл непрочитан. Владелец:
     `codefacts.route_owner` считает веб-сервером и команду с puma, unicorn, passenger, thin,
     falcon или `rails server` (`rails s`), а контейнер, чья команда запускает sidekiq, среди
     владельцев файла маршрутов не считается. Покрытие: Rails в `vocab.ROUTE_FRAMEWORKS`,
     язык Ruby с rails в зависимостях пакета в `unsupported` маршрутов не назван
     (`vocab.FAMILY_LANGUAGES`, по пакету, а не по языку целиком; с К3 язык с чтением маршрутов по
     стеку не называется вовсе, названы фреймворки без разборщика). Mastodon: маршрутов 4 → 715
     (`web` 711, из них `api.rb` 291, `admin.rb` 210, `routes.rb` 129, `settings.rb` 65,
     `fasp.rb` 16; `streaming` 4 прежние), подсказок `mount` 3 (`letter_opener`, `sidekiq`,
     `pghero`), динамических путей 1 (`web_app.rb:38`). Число скептика 332 считало объявления
     без раскрытия `resources`. Forem: 0 → 841 у `web` (команда `bundle exec rails server -b
     0.0.0.0`; у `rails` команда `bundle exec rails` без server, `sidekiq` исключён),
     `api.rb` подключён дважды (`draw :api` в scope `v1` и `v0` с `module:` без пути) и даёт те же
     пути, записанные один раз; подсказок `mount` 6, динамических путей 6 (пути с
     `#{ENV.fetch(…)}` и `probe_path`).
   - К2 (решение исполнителя): `parsers/aspnet.py` читает минимальный API и атрибуты
     контроллеров по маске C#. Группа берётся по последнему присваиванию имени до вызова в
     том же файле (`g = app.MapGroup(…)` дважды даёт разные префиксы), получатель не группа
     этого файла (`app`, `endpoints`) — корень, вызов на цепочке (`app.MapGroup("/x").MapGet`)
     пишется с `prefix_unresolved`. Строка `$"…"` без подстановки — литерал, с подстановкой —
     подсказка. `[controller]` — имя класса без суффикса `Controller` как написано, `[action]` —
     имя метода без суффикса `Async`, как их подставляет ASP.NET Core; несколько `[Route]` у
     метода дают по маршруту на каждый, глагол без шаблона берёт шаблоны `[Route]` метода.
     Сверх пункта: метод с `[Http*]` без шаблона в контроллере без `[Route]` у класса и метода
     идёт по маршруту по соглашению (`MapDefaultControllerRoute`, у eShop `Identity.API`):
     путь `/Контроллер/действие` с `prefix_unresolved`, шаблон соглашения не читается, методы
     без атрибутов записей не дают. `[Route]` класса не литералом — одна подсказка на класс.
     Покрытие: `.NET` в `unsupported` маршрутов не называется у пакетов без ASP.NET Core
     (библиотеки, воркер `Microsoft.NET.Sdk.Worker`, MAUI, решение `.sln`): маршрутов HTTP у
     .NET без него нет, а иначе у eShop семья осталась бы `partial` с «код на .NET сборщик
     пока не читает» при 48 найденных маршрутах (правило обобщено в К3). Проект только с
     `<FrameworkReference Include="Microsoft.AspNetCore.App" />` манифесты зависимостью не
     называют, его код не читается и не называется (смежный пробел, не исправлен). eShop:
     0 → 48 маршрутов у единственного контейнера `eshop` (`Catalog.API` 17, `Ordering.API` 7,
     `Webhooks.API` 4, `WebhookClient` 3, `eShop.ServiceDefaults` 3: `/`, `/health`, `/alive`;
     `Identity.API` 14 по соглашению с `prefix_unresolved`), `http_routes` из `unsupported` в
     `covered`; версии v1 и v2 одного пути `GET /api/catalog/items` — две записи со своими
     строками. Online Boutique: `cartservice` `GET /` (`Startup.cs:77`), `MapGrpcService` не
     маршрут; OpenTelemetry Demo: `cart` `GET /` (`Program.cs:125`).
   - К3 (решение исполнителя): `parsers/actix.py` идёт одним проходом по скобкам и
     разделителям маски Rust со стеком уровней: у уровня префикс снаружи и текущая цепочка
     `scope` или `resource`; цепочка кончается на «,» или «;» своего уровня или закрывающей
     скобке, а открытая на её цепочке скобка (`.service(`, `.configure(|cfg| { … })`) даёт
     уровень с её префиксом. Пути склеиваются подряд, как у actix-web (`scope("/api/v3")` +
     `scope("/post")` + `""` = `/api/v3/post`), без двойных «/» и от корня
     (`.well-known/webfinger` у Lemmy → `/.well-known/webfinger`). Имена без `web::` (у Lemmy
     `use actix_web::web::*`) читаются так же, определение `fn scope(` вызовом не считается.
     `.route("п", выражение)` с методом не из `web::get()` и подобных — ANY. Атрибуты
     обработчиков записываются как написаны, без префикса и без `prefix_unresolved`: scope, в
     котором обработчик подключён `.service(h)`, механически не находится (по пункту).
     `web::redirect("из", "в")` маршрутом не считается (у Lemmy 5). Пределы: выражение в
     скобках 200 тыс. знаков, вложенность 1000 уровней, 5000 записей и 400 тыс. скобок и
     разделителей на файл; сверх — файл непрочитан. Покрытие (сверх пункта, пересмотр правила
     К1 и К2): язык, маршруты на котором читаются по стеку пакета (`vocab.family_language`:
     Ruby, .NET, Rust), в `unsupported` маршрутов сам не называется, как Python, Node.js и Go;
     серверные фреймворки этих языков без разборщика названы по новому словарю
     `vocab.UNSUPPORTED_ROUTE_DEPS` (axum, Rocket, warp, poem, tide, Sinatra, Hanami, Grape,
     Roda, FastEndpoints, Carter; только покрытие, роль и технологию объекта он не меняет).
     Иначе у Lemmy семья осталась бы `partial` с «код на Rust сборщик пока не читает» из-за
     библиотечных крейтов без actix-web (`db_schema`, `db_views/*` и других). Lemmy: 0 → 240
     маршрутов у `lemmy` (`api/routes` 157, `api/routes_v3` 52, `apub` 18, `feeds` 8, `nodeinfo` 2,
     `webfinger` 1, `prometheus_metrics` 1, `server` 1: `/sitemap.xml`), подсказок 0, два вызова
     в модулях тестов не читаются; `http_routes` из `unsupported` в `covered`. Число скептика
     241. PostHog: actix-web в крейтах Rust нет, там axum, маршрутов не прибавилось, покрытие
     `Rust` → `Rust: axum`. OpenTelemetry Demo: `shipping` `GET /health` и `#[post]`
     `/get-quote`, `/ship-order`; email на Sinatra назван `Ruby: Sinatra` вместо `Ruby`.
   - К4 (решение исполнителя): перечисление ищется в файлах `.ts` всех пакетов Node.js
     репозитория (`export enum`, `const enum`, `declare enum`), сначала в пакете файла
     контроллера; нет в нём — в любом пакете, и при разных значениях члена в нескольких
     пакетах — подсказка с новой причиной `REASON_ENUM_AMBIGUOUS` (одинаковые значения
     неоднозначностью не считаются). Член числом, выражением или не найденный — подсказка о
     динамическом пути, маршруты контроллера с `prefix_unresolved`, как раньше. Индекс
     перечислений строится один раз за запуск и только при первом `@Controller(Имя.Член)`;
     пропуск кода для разработки при этом поиске в покрытие маршрутов не идёт (маршрутов там
     не искали). Пределы: 2000 перечислений на файл, тело до 50 тыс. знаков. immich: число
     маршрутов не меняется (318), потому что 46 маршрутов четырёх контроллеров
     `@Controller(RouteKey.Asset|User)` уже были записаны с `prefix_unresolved`, а в подсказках
     лежали 4 записи о самих контроллерах, а не 46; теперь у этих 46 решённый префикс (`asset`
     19, `user` 18, `asset-media` 5, `video-stream` 4; `/api/assets/…`, `/api/users/…`),
     подсказок о маршрутах 11 → 7. Ожидание пункта «318 → около 364» считало 46 подсказками.
     Кандидат судьи `RouteKey.Asset` ищется по имени в `entrypoints.yaml`, а после
     раскрытия там пути, а не имя: `remeasure.py` покажет «нет» (без ключа `expect`).
   - К5 (решение исполнителя): слева от «+» допускается имя или поле (`cfg.Base`), справа —
     один или несколько литералов до конца аргумента (`base + "/api" + "/v1"` → `/api/v1`);
     префикс групп получателя складывается, флаг `prefix_unresolved` ставится всегда, функция
     регистрации с параметром (п. 3) для такой записи места вызова не ищет. Склейка только
     литералов на любом получателе, кроме клиентов, даёт путь целиком: пункт прямо отменяет
     решение п. 10 А («склейка из двух литералов не исключение»), фикстура `go-http` и тест
     склейки обновлены (`"/api" + "/v2"` у `joinapi` теперь маршрут). Сверх пункта:
     `.Methods(http.MethodGet, http.MethodHead)` читается константами пакета http (у Online
     Boutique все методы так и записаны; без этого каждая запись была бы ANY). Online
     Boutique: `frontend` +16 записей из 13 регистраций (`/`, `/product/{id}` и `/cart` с GET
     и HEAD; `/cart/checkout` POST среди них; `/robots.txt` и `/_healthz` без `.Methods` — ANY),
     подсказок о маршрутах 14 → 1 (`url` в `frontend/packaging_info.go:54`); `PathPrefix(baseUrl +
     "/static/")` префиксом не считается, маршрута не даёт. Argo CD: +3 записи только этого
     вида (`server/server.go`: `extension.URLPrefix+"/"` и `common.DexAPIEndpoint+"/"` как
     `ANY /`, `base+"/argocd-linux"`), подсказок 8 → 5. Grafana: без изменений (531
     маршрут, 3 подсказки).
   - Л1 (решение исполнителя): обёртка — функция уровня модуля, в теле которой
     `add_periodic_task` (любой получатель: `sender.`, `app.`) получает её параметр на месте
     расписания; параметры задачи и `name=` берутся, только если на их местах тоже стоят
     параметры. Вызов `add_periodic_task` внутри обёртки расписанием не считается (у PostHog
     прежде давал мусорную запись `task_signature` с расписанием `schedule`). Вызовы обёртки
     ищутся в файлах того же каталога, где она определена (у PostHog определение и 64 вызова в
     одном `posthog/tasks/scheduled.py`); два определения с одним именем в каталоге —
     неоднозначно, такие вызовы не читаются; обёртка обёртки не ищется (глубина одна). Имя
     записи — `name=` строкой, иначе имя задачи; задача по аргументу на месте подписи, как у
     прямого вызова (`task.s()` → `task`). Расписание именем или полем (`settings.X`) —
     подсказка с новой причиной `REASON_SCHEDULE_VARIABLE` и именем как написано. Предел: не
     больше 100 обёрток за запуск (первые по порядку файлов), потому что имя каждой становится
     строкой поиска по файлам Python пакета; вызов `add_periodic_task` в теле остальных тоже
     не расписание. Второй проход разбирает только файлы каталогов с обёртками, где есть текст
     `имя(`. PostHog: 77 →
     140 расписаний (+64 вызова обёртки, −1 мусорная запись), кандидат `expire unused datasets`
     (`crontab(minute='37')`, `expire_datasets`, `scheduled.py:282`) есть. Владелец как и
     прежде не определён: `posthog/` — код нескольких контейнеров, все 140 записей в
     `hints.unassigned` с `REASON_MANY_OWNERS` (до пункта там же лежали 77). Остаток: планировщик
     у PostHog запускает `worker` из `docker-compose.base.yml` (`./bin/docker-worker-celery
     --with-scheduler`), но по команде через скрипт роль планировщика не опознаётся; правило
     владельца расписаний пункт не меняет.
   - Л2 (решение исполнителя): новый разборщик `parsers/gocron.py` читает только файлы,
     которые импортируют `github.com/robfig/cron` (у `AddFunc` и `Schedule` других библиотек
     другой смысл). Расписание: литерал, строковая константа или переменная верхнего уровня
     того же файла (`gocode.string_constants`, как у параметров Е1), выражение — текстом как
     написано (`fmt.Sprintf("@every %s", cacheExpiration)`); имя без строкового значения в файле
     (поле, параметр) — подсказка `REASON_SCHEDULE_VARIABLE`. Имя и задача — имя функции,
     метода (`s.cleanup`) или переменной задания вторым аргументом, у литеральной функции и
     прочего выражения — `файл:строка`. Файлы `_test.go` не читаются (walk), больше 2000
     вызовов в файле — файл непрочитан. Покрытие: robfig/cron убран из
     `vocab.UNSUPPORTED_SCHEDULE_DEPS` (gocron от go-co-op остаётся). Argo CD: +1 расписание
     (`controller/metrics/metrics.go:380`, `fmt.Sprintf("@every %s", cacheExpiration)`, имя
     `controller/metrics/metrics.go:380`: задача — литеральная функция). По Ф1 владельца у файла
     нет: `controller/` вне `cmd/<имя>`, это код всех контейнеров корня, запись в
     `hints.unassigned` с `REASON_MANY_OWNERS`; кандидат судьи `AddFunc @every` ищется в
     `entrypoints.yaml` и останется «нет». Grafana: 0 (robfig/cron только пустым импортом в
     `pkg/extensions/enterprise_imports.go`); Kubernetes из дыма: 0 (только `cron.ParseStandard`).
   - Л3 (решение исполнителя): новый разборщик `parsers/clokwerk.py`. Расписание — текст
     аргумента `every` как написан (`CTimeUnits::minutes(10)` у Lemmy, где clokwerk подключён
     под другим именем), `.at("…")` на той же цепочке добавляется через пробел; цепочка
     читается до десяти звеньев и кончается на следующем `every`. Имя и задача — первый вызов
     свободной функции в теле `run` (имя со строчной буквы без точки перед ним, кроме ключевых
     слов: `x.clone()`, `warn!(…)` и `Ok::<…>` не считаются), иначе `файл:строка`. Пределы:
     аргумент и звено до 2000 знаков, тело `run` до 20 тыс., больше 2000 вызовов в файле — файл
     непрочитан. Покрытие (сверх пункта, по образцу К3): clokwerk убран из
     `vocab.UNSUPPORTED_SCHEDULE_DEPS`, расписания Rust вошли в `vocab.FAMILY_LANGUAGES`, и
     Rust в `unsupported` расписаний сам не называется; известные планировщики Rust без
     разборщика (tokio-cron-scheduler, job_scheduler) добавлены в словарь и называются
     стеком. Lemmy: 0 → 4 расписания у `lemmy` (`crates/routes/src/utils/scheduled_tasks.rs`:
     `plugin_hook_after` каждую минуту, `update_hot_ranks` каждые 10 минут, `active_counts`
     ежечасно, `all_active_counts` ежедневно), семья из `unsupported` в `covered`. PostHog:
     clokwerk и других планировщиков в крейтах нет, расписаний не прибавилось, `Rust` ушёл
     из `unsupported` расписаний.
   - Л4 (решение исполнителя): новый разборщик `parsers/nodecron.py` с именем `node-cronjob`
     (пакет `node-cron` — другая библиотека со своим API, он остаётся в
     `vocab.UNSUPPORTED_SCHEDULE_DEPS` и назван в покрытии; `cron` оттуда убран). Механика
     immich: задания регистрируются не декоратором, а вызовом
     `this.cronRepository.create({ name, expression, onTick, start })` в сервисах
     (`queue.service.ts` ночные задания, `database-backup.service.ts` `backupDatabase`,
     `library.service.ts`, `version.service.ts`, `integrity.service.ts` три проверки);
     `CronRepository.create` сам зовёт `new CronJob(expression, onTick, …)`. Выражения берутся из
     системной конфигурации (`database.cronExpression` и другие поля; значения по умолчанию —
     члены `CronExpression.X` в `defaults` из `dtos/config.dto.ts`), ночное — из
     `asNightlyTasksCron(config)`, проверка версии — шаблоном со случайной минутой. Поэтому
     правило: объект с ключами своего уровня `expression` или `cronTime` и `onTick` —
     регистрация; без `onTick` (`update({ name, expression })`, схемы и индексы с ключом
     `expression`) — нет; тип или интерфейс (на своём уровне «;») и образец разбора параметра
     (`create({ name, expression, onTick }: CronCreate)`, `({ onTick }) =>`) — нет;
     `new CronJob(имя, …)` с параметром на месте выражения не читается вовсе (это код самой
     обёртки). Имя: `name:` строкой, членом строкового перечисления репозитория
     (`CronJob.NightlyJobs` у immich → `NightlyJobs`, тот же индекс, что у К4) или как написано; без
     ключа `name` — функция в `onTick: f`, иначе `файл:строка`. Выражение полем объекта —
     подсказка с новой причиной `REASON_SCHEDULE_CONFIG` и ключом как написан
     (`database.cronExpression`), именем или шаблоном с подстановкой —
     `REASON_SCHEDULE_VARIABLE`. Словарь `CronExpression` — по пункту, в виде из пяти полей;
     неизвестный член пишется как написан. Пределы: объект до 5000 знаков, больше 2000
     совпадений в файле — файл непрочитан. immich: 7 регистраций, все подсказками (5 полей
     конфигурации, `cronExpression` и `expression` переменными), записей 0; семья
     расписаний из `unsupported` (`cron`) в `empty` с `dynamic_names: 7`. Кандидат судьи
     `backupDatabase` ищется в `entrypoints.yaml` и останется «нет»: расписание этого задания
     известно только при запуске. Строка сводки о таких подсказках (после перемера 4b) —
     «Расписаний с именем или расписанием, заданным выражением в коде: N»: прежнее «с именем»
     было неверно для подсказок Л1 и Л4, где имя известно, а расписание нет.
   - Н1 (решение исполнителя): код, который отдаёт файл, ищет отдельный разборщик
     `parsers/served.py` (`openapi-served`, без семьи покрытия): он работает, только если в
     репозитории есть файлы OpenAPI вне каталогов документации, и ищет строковый литерал,
     равный базовому имени файла или кончающийся на `/имя` (`"swagger.json"`,
     `"assets/swagger.json"`, `"/swagger.json"`), в коде Python (ast), Node.js, Go, C#, Java,
     Rust и Ruby (маска; имя в комментарии не литерал). Литерал решает только за файл, базовое
     имя которого в репозитории одно (два `swagger.json` — литерал не говорит, какой).
     Владелец: у кого из сервисов файл кода с литералом единственный (`owners.file_owners`, Ф1),
     тот и владелец; если все такие файлы общий код, у файлов Go берутся файлы, импортирующие
     их пакет. Отклонение от пункта: не один шаг, а до трёх, через общий код: у Argo CD пакеты
     с литералом (`util/swagger`, `util/assets`) импортирует общий `server/server.go`, а его —
     `cmd/argocd-server/commands`, и одного шага не хватает. Сервис засчитывается по
     импортёру, который принадлежит только ему. Второе отклонение: по каждому литералу своё
     множество сервисов, владелец — единственный общий для всех литералов (пересечение), а не
     объединение. У Argo CD `util/assets` (`assets.Embedded.ReadFile("swagger.json")`)
     импортирует ещё `util/rbac`, а через него код почти всех программ: объединение дало бы
     четыре сервиса, пересечение с `util/swagger` (только `argocd-server`) даёт одного.
     Несколько общих или ни одного общего при непустых множествах — подсказка с новой
     причиной `texts.openapi_served_many` и перечнем. Пределы: 100 литералов на файл, 2000
     вхождений имени на файл, 2000 файлов-импортёров на литерал (больше — импортёры не
     считаются), заголовок файла Go до первого объявления не длиннее 200 тыс. знаков. Argo CD:
     `assets/swagger.json` теперь у `argocd-server`, +106 маршрутов (`framework: openapi`),
     подсказка о файле с владельцем. Цепочка: `util/swagger` → `server/server.go` →
     `cmd/argocd-server/commands/argocd_server.go`; `server` импортирует ещё
     `cmd/argocd/commands/headless` — это клиент `argocd`, у которого нет контейнера, он в
     счёт не идёт; литерал в `ui/src/app/webpack.config.js` — код без контейнера, тоже не в
     счёт. Keycloak и n8n: без изменений (у Keycloak владелец уже был, у n8n литералы
     `openapi.yml` в коде без контейнера). Фикстура `openapi-served`: программы `cmd/api` и
     `cmd/admin` (вторая программа — сервис, а не воркер: файл OpenAPI ищет владельца только
     среди сервисов, и при воркере владелец нашёлся бы прежним правилом).
   - Н2 (решение исполнителя): шаг (1а) цепочки §7 стоит в `owners.database_for` после адреса
     в окружении и только когда адрес не указал ни на одну базу. «Файл манифеста» объекта —
     файлы его единиц (`Unit.loc` и `extra_locs`): у compose сам файл, у k8s и Helm каталог
     файла (объекты одного развёртывания лежат в нескольких файлах каталога). Владельцы
     каталога миграций — все `owners.file_owners` каталога; их файлы объединяются, и если в
     объединении ровно одна реляционная база, таблицы у неё, иначе (две и больше или ни
     одной) дальше по прежней цепочке. Forem: 133 → 0 таблиц в подсказках, все 133 у
     `postgres`. Каталог `db/` принадлежит контейнерам с кодом из каталога `rails`, `web` и
     `sidekiq` (все в `docker-compose.yml`, адрес базы в их окружении `localhost`), а в этом
     файле одна база `postgres`; `db` из `container-compose.yml` описана рядом с контейнерами
     на готовом образе без кода из каталога, они каталогом миграций не владеют. Фикстура
     `two-compose-dbs`; ловушка в тесте: тот же `web` ещё в третьем файле рядом с `mysql` —
     подсказка «несколько баз», как раньше.
   - Н3 (решение исполнителя): правило в `owners._same_program` (его зовёт `_runs_program`).
     Имя контейнера по-прежнему сравнивается с программой точно; нечётко сравнивается только
     программа команды: равны, отличаются конечной «s» у одного из имён, или команда —
     `<имя>-controller`/`<имя>-server` при имени контейнера с тем же хвостом. Сверх пункта:
     нечёткое совпадение не действует, если у каталога кода есть своя программа с именем
     команды (`cmd/app` и `cmd/apps` при команде `apps` — только `cmd/apps`), иначе одна команда
     забрала бы две программы. Ловушки в тесте: `cmd/app` и `apps` совпадают, `cmd/app` и
     `application` нет, `-server` у команды контейнера `web` без такого хвоста не действует.
     Argo CD: код `cmd/argocd-notification/` теперь у `argocd-notifications-controller`
     (команда `/usr/local/bin/argocd-notifications`): 8 записей параметров и маршрут `ANY
     /metrics` ушли из подсказок к нему (`unassigned` параметров 33 → 25, маршрутов у него
     0 → 1). Число имён параметров остаётся 109, а не 117 из ожидания пункта: все восемь имён
     уже были у контейнера из окружения манифеста k8s, записи из кода к ним добавили тип и
     значение по умолчанию (`ARGOCD_NOTIFICATIONS_CONTROLLER_LOGFORMAT`: `string`, `json`).
   - Перемер части 4 (исполнитель, после блоков К, Л и Н; сборки 0.5.0 2741118a, fd375988,
     a60cc478 против базы судьи judge6): шесть вердиктов без регрессий после каждого блока;
     Sentry: `layers-check` с кодом 0, core 24/30/52 без изменений; дым 15 репозиториев с
     кодом 0, клоны чистые, изменения только по пунктам (OpenTelemetry Demo К2, К3, Л3; eShop
     К2; Loki К5; Forem К1, Н2; n8n Л4 и Kubernetes Л2 только списком разборщиков в покрытии).
     Кандидаты судьи «есть»: `/cart/checkout`, `/icon`, `health`, `/api/v1/applications`;
     «нет» по устройству проверки, которая ищет имя только в `entrypoints.yaml`:
     `cartservice GET /` (маршрут есть, `Startup.cs:77`), `RouteKey.Asset` (раскрыт в путь),
     `scheduler.every` (у Lemmy расписания под именами функций), `AddFunc @every`,
     `expire unused datasets` (в подсказках без владельца), `backupDatabase` (подсказка о
     расписании из конфигурации). Время после блока Н, минимум из трёх по процессорному
     времени против 0.4.0: Mastodon −3 %, Lemmy +8 %, immich +13 %, eShop +22 %
     (0,54 → 0,66 с), Argo CD +5 %, PostHog +2 %; память не больше +1 МБ. У eShop прирост
     не в разборе (все разборщики вместе 0,06 с), а в запуске: файл везёт исходники без
     байткода, и каждый запуск компилирует модули, а в части 4 их на 14 больше (под
     профилировщиком `compile` 0,41 → 0,48 с); на коротком прогоне это больше 20 %. Прирост
     принят владельцем 2026-11-09: сокращать время ценой качества не нужно, сборщик работает
     столько, сколько нужно, предел записей на файл у разборщиков Python не заводится. Не
     решено: владелец расписаний PostHog (`worker` с `--with-scheduler`).
16. **Решения исполнителя части 5** (2026-11-09, ветка feat/scan-5, сборщик 0.6.0 без выпуска;
   хвосты части 4, параметры .NET и hjson, поле envconfig без `from`, прокси Envoy,
   переименования таблиц Kysely; владелец может отменить, числа перемера в конце пункта).
   - П1 (решение исполнителя): новый модуль `scripts.py` раскрывает команды после всех
     разборщиков (`registry.collect`), потому что единицы и Dockerfile дают разные
     разборщики; поле `Unit.script_commands` (и `Dockerfile.script_commands` для CMD) не
     запись вывода и в основания не идёт. Скриптом оболочки считается файл без расширения
     или с `.sh`, `.bash`, у которого строка `#!` (если есть) называет оболочку: файлы Python
     и Node.js по пути (`./bin/tool.py`) текстом оболочки не читаются. Сама команда единицы
     тоже делится на простые команды: у PostHog `web` (`./bin/start-backend &
     ./bin/start-frontend`) раскрываются оба скрипта; в команды единицы добавляются только
     команды скриптов, своя команда остаётся одной строкой, как раньше. Сверх пункта:
     встроенные команды и утилиты, которые процессом не бывают (`echo`, `test`, `rm`,
     `export`, `kill`, `sleep`, `curl` и другие из `scripts._NOT_PROCESSES`), и присваивания
     перед программой (`CELERY_WORKER_QUEUES=$Q celery`) в слова команды не идут, иначе
     справка в `echo "start PostHog's Celery worker"` или имя переменной меняли бы роль
     веб-сервера.
     Второе отклонение: скрипты CMD Dockerfile не раскрываются, если другая единица объекта
     задаёт свою команду (compose `command` заменяет CMD образа). У PostHog CMD `./bin/docker`
     запускает и `./bin/docker-worker`, и `./bin/docker-server`, а образ общий у всех
     сервисов корня: без этого правила `web` получил роль «воркер» по слову worker и потерял
     220 маршрутов. Третье: правило владельца по `celery beat` действует только для
     расписаний разборщика celery-beat, а не для файлов crontab, как сказано в пункте: файл
     crontab исполняет cron, а не celery beat, и свидетельство Celery о нём ничего не говорит.
     Программа скрипта по имени `run` (`./run`) не опознаётся: `run` — обёртка в
     `vocab._WRAPPERS` (`uv run`), это прежнее поведение `command_program`. Пределы против
     враждебного входа: 64 КБ на скрипт, 2000 простых команд со скрипта, 5000 на единицу;
     прочитанный скрипт кэшируется на запуск и в покрытии не считается (`Files.head` без
     кэша и счёта непрочитанного). Разбор одним проходом с прыжками по особым символам
     (подряд идущие разделители, `\`, `$`, `(` и `<` одним шагом): 64 КБ худшего входа
     матрицы теста не дольше 50 мс. PostHog: 140 расписаний из `hints.unassigned` у `worker`
     (`docker-compose.base.yml:360` → `bin/docker-worker-celery` → `bin/docker-worker-beat`:
     `celery -A posthog beat -S redbeat.RedBeatScheduler`), строки «Расписаний без
     владельца: 140» в сводке нет, семья расписаний `covered` с `found: 140`; маршруты (220 у
     `web`), роли, связи и воркеры без изменений. Остальные шесть корнер-репозиториев и 15
     дымовых без изменений (Forem `./scripts/bundle.sh` даёт только `bundle install`, а
     `./bin/webpack-dev-server` в репозитории нет; Argo CD Procfile и
     `hack/start-redis-with-password.sh` — манифест разработки).
   - П2 (решение исполнителя): файлы sidekiq-cron читает разборщик `sidekiq` (тот же стек,
     тот же владелец по В3: контейнер, чья команда запускает sidekiq); общий цикл записей
     `_entries` у sidekiq-scheduler и sidekiq-cron, у второго запись без `class` не читается.
     Правило «без sidekiq-cron в Gemfile» понято по записи: в пакете без гема читаются записи
     с ключами `cron` и `class`, запись с `every` без гема не читается (так `every` пишет
     sidekiq-scheduler, у которого свой файл). `config/sidekiq_cron.yml` подходит и под
     прежнее имя `sidekiq*.yml`, но читается только как файл sidekiq-cron: `:queues:` в нём не
     ищутся. Ключ `queue` записи, как у sidekiq-scheduler, задаёт очередь потребления класса.
     Формат списком (`- name: x`) не читается: пункт его не называет, в корпусе его нет.
     Покрытие: расписания Ruby вошли в `vocab.FAMILY_LANGUAGES` (sidekiq-scheduler,
     sidekiq-cron), планировщики Ruby добавлены в `vocab.UNSUPPORTED_SCHEDULE_DEPS` под
     именами для людей (whenever, rufus-scheduler, Clockwork, GoodJob, Solid Queue). Отклонение
     от ожидания «остальные без изменений»: язык из `FAMILY_LANGUAGES` не называется у любого
     пакета этого языка (правило К3 и Л3), поэтому у Loki (Gemfile плагинов fluentd и logstash
     в `clients/cmd/`) семья расписаний из `unsupported: [Ruby]` стала `empty` (расписания в
     строке «Искали и не нашли»), а у OpenTelemetry Demo из списка `unsupported` ушёл Ruby. Враждебный
     вход: файл больше 256 КБ YAML не разбирается (общий предел `yamlload`), 2 МБ записей,
     вставок ERB, незакрытых `<%` и `[` укладываются в 0,7 предела; файл вплотную к 256 КБ
     читается целиком примерно за 1,3 с процессорного времени, почти всё из них общий разбор
     YAML (предел теста втрое шире). Forem: 0 → 48 расписаний у `sidekiq`
     (с `config/schedule.yml:1` `events_send_notifications` по `concept_daily_metrics`), семья
     из `unsupported` в `covered`; Mastodon: `unsupported: [Ruby]` ушёл, `partial` → `covered`
     (16 записей).
   - П3 (решение исполнителя): поля записи в подсказке собирают общие конструкторы
     `model.route_hint`, `model.schedule_hint` и `codefacts._unassigned` (через
     `model.hint_fields`), разборщики их не дублируют; `output/agent.ordered_hint` ставит
     их после общих ключей в порядке method, schedule, task. Метод пишется, когда его
     называет регистрация (`app.get`, `r.Put`, `@Post`, `MapPatch`, `delete` Rails,
     `#[get]`, декоратор с одним методом); ANY (`app.all`, `HandleFunc`, `match`,
     `MapMethods`, `@All`, `#[route]`, `path()` Django) не пишется: метод не назван.
     Подсказка о маршруте без владельца несёт метод записи. Задача расписания в подсказке
     та же, что была бы у записи: у `new CronJob(выражение, () => f())` и литеральной функции Go
     это место вызова (Argo CD `controller/metrics/metrics.go:380`), у объекта регистрации
     immich имя задания. Имя подсказки не меняется (выражение, как раньше), поэтому у
     подсказок из конфигурации и переменной `schedule` повторяет `name`. Сводка: семья с
     `dynamic_names` в «Искали и не нашли» не попадает только там, где строка «заданным
     выражением в коде» и пишется (семьи кода), иначе семья пропала бы из сводки совсем.
     Числа: immich без «Искали и не нашли: расписания», семь подсказок о расписаниях с
     `schedule` и `task` (`database.cronExpression` с задачей `backupDatabase` и шесть других);
     Argo CD `controller/metrics/metrics.go:380` с `schedule: fmt.Sprintf("@every %s",
     cacheExpiration)` и `task`; n8n: «каналы брокеров» ушли из «Искали и не нашли» (каналы
     только выражением). Поле `method` прибавилось у подсказок о маршрутах: Online Boutique 1,
     Mastodon 1, immich 7, PostHog 6 (без владельца), Airflow 23, Loki 2, Forem 6, Nomad 8, n8n
     17 и 21 без владельца, Kubernetes 1 и 29 без владельца; «Ярмарка» 1 (`STATUS_PATH`,
     `method: GET`, поэтому `yarmarka.expected` меняется не только строкой версии). Подсказки
     не исчезли и не появились ни у одного репозитория, ни одна запись не поменялась.
   - П4 (решение исполнителя): «один аргумент» определяется там, где разбор и так находит
     конец первого аргумента (литерал пути, обёртка, склейка, текст выражения для подсказки
     не дальше 80 знаков), без отдельного прохода по аргументам: проход по скобкам всего
     файла шёл 1,9 с на 2 МБ открывающих скобок. Отклонение от пункта: глагол с одним
     аргументом и цепочкой за скобкой остаётся маршрутом, потому что это построитель
     go-restful (`ws.Route(ws.GET("/").To(h))`): без этого Kubernetes потерял бы 29 маршрутов
     без владельца (`pkg/routes/logs.go:38`, `pkg/kubelet/server/server.go:748` и другие).
     Глаголы все семь (`OPTIONS` тоже: регистрации без обработчика не бывает), `Handle`,
     `HandleFunc`, `Any` и `All` не глаголы. `http.PostForm` под шаблон вызова и раньше не
     попадал. Подсказки ушли только о запросах клиентов: Online Boutique 1 → 0
     (`src/frontend/packaging_info.go:54` `http.Get(url)`), Grafana 2 (`generate.go:60`, `:89`
     `http.Get`), Loki 2 (`http.Get(readyURL)`, `http.Get(url)`), Kubernetes 1
     (`visitor.go:332`), Nomad 7 (два вызова `s.vLogical.Delete(fmt.Sprintf("/auth/%s/role/%s",
     vaultPath, role))` и подобный, пять `s.HTTPClient.Get(s.url("/v1/metrics"))` и
     подобных); Argo CD без изменений; записей `http:` и маршрутов без владельца не убыло ни
     у кого (`entrypoints.yaml` тот же). Фикстура: ловушки `http.Get(url)`, `http.Post(url, t,
     b)`, `r.Get(url)` и `r.GET(urlFor("/c"))` с одним аргументом (прежде маршрут `GET /c`),
     рядом маршруты `r.Get("/a", h)`, `http.HandleFunc("/b", h)` и `ws.GET("/logs").To(logs)`.
   - П5 (решение исполнителя): ASP.NET Core опознаётся по ключу `microsoft.aspnetcore` в
     `vocab.FAMILY_LANGUAGES` (зависимость равна ключу или начинается с «ключ.»), поэтому
     `FrameworkReference` пишется зависимостью как есть в нижнем регистре
     (`microsoft.aspnetcore.app`). Проект — ближайший вверх каталог с `.csproj`; шаблоны
     собираются со всех файлов проекта за один проход, маршруты по соглашению ждут конца
     прохода (файл, отвергнутый за предел записей, своих не отдаёт). Кроме `{x?}` в шаблоне
     ничего не отбрасывается: обязательный параметр (`{id}`), параметр с значением по
     умолчанию (кроме controller и action) и `{*slug}` остаются как написаны; имена
     controller и action без учёта регистра. `MapAreaControllerRoute`, старые `UseMvc`,
     `MapRoute` и `UseMvcWithDefaultRoute` не читаются (в корпусе их нет). eShop: 14 маршрутов
     `Identity.API` без `prefix_unresolved` с теми же путями (`/Account/Login` GET и POST,
     `/Account/Logout` GET и POST, `/Account/AccessDenied`, `/Consent/Index` GET и POST,
     `/Device/Index`, `/Device/UserCodeCapture`, `/Device/Callback`, `/External/Challenge`,
     `/External/Callback`, `/Grants/Index`, `/Grants/Revoke`), шаблон
     `src/Identity.API/Program.cs:55` `app.MapDefaultControllerRoute()`. `eShop.ServiceDefaults`
     без изменений: его маршруты читались и раньше по `Microsoft.AspNetCore.OpenApi`, новая
     зависимость `microsoft.aspnetcore.app` ничего не прибавила. OpenTelemetry Demo без
     изменений. Пределы: аргументы `MapControllerRoute` читаются не дальше 200 разделителей и
     2000 знаков, имя параметра шаблона до 200 знаков.
   - П6 (решение исполнителя): группа снимается вся, со вложенными (`a/(b(/c))/d` → `a/d`),
     «//» схлопываются; незакрытая или лишняя скобка оставляет путь как есть. Схлопывание
     дублей идёт по методу, пути и `prefix_unresolved` на весь набор маршрутов каталога
     `config/`: маршрут без группы остаётся (основание его строки), из двух маршрутов из
     группы остаётся первый, два маршрута без группы остаются оба, как раньше. Группа
     снимается и в имени подсказки `mount` (Forem `Blazer::Engine /admin/blazer` вместо
     `/(/locale/:locale)/admin/blazer`, пять подсказок). Неглубокие члены идут от префикса
     scope и namespace, а не от корня сайта: так делает Rails (`namespace :api` с
     `resources :posts, shallow: true` даёт `/api/comments/:id`); в корпусе неглубоких
     ресурсов нет, пункт проверен фикстурой. Модули devise читаются из всех вызовов
     `devise` модели (у Mastodon их три, `app/models/user.rb:61`, `:64`, `:67`) до 100
     вызовов, 50 строк продолжения через запятую на вызов и 200 имён; `:path => 'x'` читается
     как `path:`. `devise_for` в `namespace`/`scope` берёт их префикс, `scope module:` пути
     не меняет. `controllers:`, `format:`, `class_name:` и `router_name:` не читаются, модель
     ищется по единственному числу имени. Отклонение от ожидания: у Forem +23, а не +27, как
     и выходит сложением названных в пункте наборов (3 + 6 + 4 + 3 + 3 + 4); PUT, дубль
     PATCH, сборщик не пишет и у `resources`. Forem: 825 путей без группы
     (`/admin/customization/config`), путей со скобкой не осталось; 841 → 853 у `web`: +23
     devise (`config/routes.rb:6`) и −11 дублей (4 маршрута из группы совпали с записанными
     без неё: `/`, `/:slug`, `/feed`, `/rss`; 7 пар одинаковых маршрутов из группы в
     `config/routes/listing.rb:3` и `:10`); подсказка `invitable` на `config/routes.rb:6`.
     Mastodon: 715 → 730 (`web` 711 → 726): +16 под `/auth` (`config/routes.rb:88`, sessions,
     registrations, passwords, confirmations), четыре пути с `(*any)` без группы
     (`/@:username_with_domain`, `/media_proxy/:id`, `/web`, `/api/v1/streaming`), последний
     совпал с `config/routes/api.rb:74` и второй раз не пишется (отклонение от «остальные без
     изменений»: пункт эти пути не называет, но правило группы их касается).
   - П7 (решение исполнителя): все тесты времени сборщика (`time_limit()` и пределы числом в
     `test_code_hostile`, `test_hostile`, `test_buildfiles`, `test_alembic` и ещё 15 файлах)
     меряют процессорное время `time.process_time()` вместо `time.perf_counter()` с теми же
     пределами, через общий помощник `tests/helpers.timed`. Подпроцессов внутри замеров нет,
     поэтому процессорное время процесса pytest и есть время разбора. Сверх пункта: одного
     процессорного времени не хватило. При заполненной подкачке (2 ГБ из 2 ГБ) и работающем
     dev-стеке полный гейт с `process_time()` падал в трёх прогонах из пяти: alembic 1,20 с
     процессорного времени на случае, который поодиночке идёт 0,34 с, openapi-served 4,30 с
     против 0,34–0,49 с поодиночке. Это не сборка мусора (куча в 3 млн объектов время не
     меняет) и не системное время (оно около 0,04 с): гостевая машина WSL2 не видит занятости
     хоста, и процессорное время в ней растёт вместе с ним. Поэтому `timed` повторяет прогон,
     вышедший за предел, один раз и берёт меньшее из двух, как уже делала проверка маски
     (`test_mask_is_linear_on_hostile_input`, лучшее из двух прогонов): разбор, ставший
     квадратичным, выходит за предел в разы в обоих прогонах, а случайная нагрузка машины
     во втором уходит. Повтор идёт на тех же `Files`; разборщики без состояния. Коммит П7 идёт
     вторым, сразу после версии: без него pre-commit под нагрузкой не держал ни одного коммита
     (коммит версии дважды падал по часам на матрице `test_code_hostile`).
   - Р1 (решение исполнителя): `appsettings.json` читает отдельный разборщик
     `parsers/appsettings.py` (семья config, не ярус кода, отбор по имени файла и `.csproj` в
     том же каталоге); его записи идут как чтения кода с признаком `from_file`, поэтому
     владелец, служебные каталоги и подсказки те же, что у `dotnetenv`, а
     `codefacts._merge` берёт дефолт сначала из файла, тип сначала из кода. Разбор JSON свой,
     одним проходом по лексемам (номер строки ключа нужен, у `json` его нет): метка порядка
     байтов (`src/Ordering.API/appsettings.json` у eShop) снимается при чтении файла, повтор
     ключа даёт запись по последнему, как у .NET, ошибка синтаксиса пропускает файл без
     записей. Строка без `\` берётся как написана, с `\` раскодируется. Сверх пункта:
     `AddOptions<T>().BindConfiguration(nameof(T))` (у eShop так привязаны `CatalogOptions`,
     `PaymentOptions`, `BackgroundTaskOptions` и `WebhookClientOptions`, четыре из пяти
     привязок; пункт его не называет) и `AddOptions<T>().Bind(раздел)`; переменная раздела
     (`var s = configuration.GetSection("A")`) ставит раздел перед ключом `s.GetValue<T>("B")`
     и `s.GetSection("B")`, иначе имя вышло бы неверным. Класс ищется по индексу «имя класса →
     файлы проекта» (один на проект, строится при первой привязке); класс в двух файлах
     проекта или в другом проекте не берётся (тогда параметр раздела с типом `T`); вложенные
     классы и свойства без `set`/`init` и `static` не параметры. Тип свойства и `T`: `bool`,
     целые → `int`, `double`/`float`/`decimal` → `float`, `string`, `TimeSpan` → `duration`,
     массив и `List<T>` → `array`, иначе как написан. Пределы враждебного входа: привязок к
     классам в файле дают больше 2000 параметров (произведение привязок и свойств) — файл
     непрочитан; `.Bind(obj)` ищет объявление не больше 20 разных переменных на файл.
     Отклонение от ожидания «eShop около 90»: у eShop один контейнер `eshop`, и одинаковые
     ключи десяти файлов (73 ключа) сливаются в 28 имён; итог 12 → 45 параметров (+33): 21
     только из файлов, 5 из файла и кода (`BackgroundTaskOptions:CheckUpdateTime` и
     `GracePeriodTime`, `CatalogOptions:UseCustomizationData`,
     `EventBus:SubscriptionClientName`, `PaymentOptions:PaymentSucceeded`), 7 только из кода
     (`CatalogOptions:PicBaseUrl`, `ConnectionStrings:chatModel`, `orderingdb`,
     `textEmbeddingModel`, `EventBus:RetryCount`, `WebhookClientOptions:SelfUrl` и
     `ValidateToken`); `MauiCallback` и `WebhookClientOptions:Token` получили место в файле.
     По проектам ключи файлов: Basket.API 7, Catalog.API 9, Identity.API 6, OrderProcessor 6,
     Ordering.API 13, PaymentProcessor 5, WebApp 5, WebhookClient 4, Webhooks.API 15,
     eShop.AppHost 3. Дефолт `TokenLifetimeMinutes` (120) не пишется по правилу секретов
     (слово TOKEN в имени), адреса (`amqp://localhost`) тоже. Online Boutique `cartservice` 10
     → 15 и OpenTelemetry Demo `cart` 14 → 19: по пять ключей `Logging:LogLevel:*`,
     `AllowedHosts`, `Kestrel:EndpointDefaults:Protocols`; `GetValue<bool>` у `cart`
     (`src/cart/src/Program.cs:99`) слился с параметром из compose. Подсказки не изменились.
   - Р2 (решение исполнителя): `config/defaults.hjson` читает разборщик `parsers/hjson.py`
     (семья config, не ярус кода), записи с признаком `from_file`, как у `appsettings.json`.
     «Каталог config/ пакета» понят так: рядом с каталогом `config/` лежит манифест сборки
     любого языка; у Lemmy это корневой `Cargo.toml`, а `docker/lemmy.hjson` и файлы
     `docker/federation/` (настройки стендов) под имя не подходят. Значение без кавычек идёт
     до конца строки и включает `#` (так у hjson); число, `true`, `false` и `null` — литерал,
     если за ним конец строки, запятая, скобка или комментарий, поэтому два ключа на строке
     через запятую читаются. Многострочная строка `'''` берётся как написана (с переводами
     строк, дефолтом не пишется). Повтор ключа даёт запись по последнему. Массив длиннее
     1000 знаков проходится до парной скобки без разбора значений (его дефолт длиннее 200
     знаков и не пишется), ключи внутри массивов в предел 5000 не входят; строка без кавычек
     со скобкой внутри такого массива может сбить счёт скобок, тогда файл не разбирается
     (подсказка). Пределы: файл больше 1 МБ, вложенность глубже 50, больше 5000 ключей —
     файл непрочитан и подсказка `unparsed` с причиной «файл настроек hjson не разбирается
     или превышает пределы разбора»; ошибка синтаксиса — та же подсказка без записей. Lemmy:
     у `lemmy` 13 → 34 параметра (+21, все из `config/defaults.hjson`): `database.connection`,
     `database.pool_size`, `pictrs.url`, `pictrs.api_key`, `email.connection`,
     `email.smtp_from_address`, `setup.admin_username`, `setup.admin_password`,
     `setup.site_name`, `setup.admin_email`, `setup.bootstrap_instances`, `hostname`, `bind`,
     `port`, `tls_enabled`, `federation.concurrent_sends_per_instance`, `prometheus.bind`,
     `prometheus.port`, `cors_origin`, `json_logging`, `plugins`. Ожидание «около 38» не
     достигнуто: ключей в файле 21, имена через точку с переменными окружения (`LEMMY_*`) не
     сливаются. Дефолты адресов (`database.connection`, `pictrs.url`, `email.connection`),
     секретов (`pictrs.api_key`, `setup.admin_password`), почты (`setup.admin_email`,
     `email.smtp_from_address`) и длинный `plugins` не пишутся по инварианту 6.
   - Р3 (решение исполнителя): поле с атрибутом без `from` давало имя поля в верхнем
     регистре и раньше (часть 3, И2); новое правило только для поля без атрибута
     `#[envconfig]` в структуре, над которой `#[derive]` со словом `Envconfig` (между
     derive и `struct` допустимы другие атрибуты). Такое поле — параметр без дефолта
     (дефолт у envconfig задаёт только атрибут), обязателен, если тип не `Option<T>`, тип по
     типу поля, как у атрибута; основание — строка поля. Поля структур в модуле
     `#[cfg(test)]` не читаются, как и прежде. Тело структуры ищется до следующего
     `#[derive(` в файле (структура в структуре не объявляется), поэтому незакрытые тела не
     дают квадратичного прохода. Предел враждебного входа: структура больше чем с 2000 полей
     (`clike.MAX_READS`) — файл непрочитан, у PostHog самая большая структура
     (`rust/capture/src/config.rs`, `Config`) около 150 полей. PostHog: 2620 → 2706 имён
     параметров, 6151 → 6293 записей у контейнеров (+142): `capture` +47
     (`rust/capture/src/config.rs`: 24 поля `kafka_traces_*` и `kafka_metrics_*` в
     `KafkaConfig`, `redis_url`, `otel_url`, `concurrency_limit` и другие), `kafka-deduplicator`
     +22, `personhog-router-leader` +19, `replay-capture` +19, `capture-ai` +18 (крейт
     `capture` и общий `rust/common/kafka`), `personhog-parity-monitor` +6, `cohort-seeder` +3,
     `embedding-worker` +2, `personhog-identity` +2, `replay-recorder-v4` +2, `capture-logs` +1,
     `cymbal` +1 (`POSTHOG_API_KEY` трёх режимов); у `personhog-changelog-relay` и
     `personhog-writer` существующий параметр получил тип `string` и `required`. Подсказки и
     остальные репозитории без изменений.
   - С1 (решение исполнителя): вид прокси (`proxyconf.proxy_kind`) по технологии словаря
     образов или по имени образа: envoy, nginx (с openresty), haproxy, caddy, traefik. По
     Dockerfile прокси ищется, только когда образа в compose нет, он задан переменной или
     словарь образов его не знает (свой тег): сервис на образе словаря (postgres со своим
     Dockerfile) прокси не становится. Берётся базовый образ последней стадии, источники COPY
     и ADD тоже только последней стадии (ранние стадии в образ не попадают), без `--from`,
     адресов URL и шаблонов; каталог-источник даёт свои файлы без подкаталогов по имени вида.
     Файл конфигурации из COPY, которого нет в обходе, даёт подсказку `unparsed` с новой
     причиной «файл из COPY Dockerfile не найден среди файлов обхода, конфигурация прокси не
     прочитана». Подстановки в адресе Envoy раскрывает `compose.expand` (те же правила, что у
     полей compose), окружение единицы — её `environment`, где `- VAR` без значения берёт
     значение из закоммиченного `.env` рядом с файлом compose; без git `.env` не читается.
     Нераскрытая подстановка, IP и localhost связи не дают и подсказки не пишут, как у nginx
     сейчас (бриф называл подсказку, но прежнее поведение для этих адресов без подсказки;
     правило оставлено общим). Файлы Envoy из томов читаются тем же форматом, остальные
     файлы томов как раньше. Предел враждебного входа: смотрится не больше 200 источников
     COPY одного Dockerfile (прокси OpenTelemetry Demo копирует один файл), файл
     Envoy больше предела YAML (256 КБ) непрочитан, ошибка YAML — подсказка. Время разбора
     документа YAML предельного размера (около 1 с на плотном файле 256 КБ) — свойство
     общего загрузчика `yamlload`, а не обхода кластеров (обход такого документа 0,02–0,06 с).
     OpenTelemetry Demo: в `src/frontend-proxy/envoy.tmpl.yaml` 13 кластеров (бриф называл
     20), все с `${X_HOST}`, все раскрылись из `.env`: связи `frontend-proxy` → `frontend`,
     `image-provider`, `flagd`, `flagd-ui`, `load-generator`, `grafana`, `jaeger`,
     `opamp-server`, `telemetry-docs`, `otel-collector` (два кластера, два основания),
     `chatbot` (`compose.agent.yaml`) и `firepit` (`compose.profiling.yaml`): связей 20 → 32;
     8 подсказок depends_on `frontend-proxy` → X ушли, связь теперь нарисована. Loki без
     изменений.
   - М1 (решение исполнителя): цикл ищется по заголовку `for (const { a, b } of ИМЯ)` или
     `for (const [a, b] of ИМЯ)` (деструктуризация именами, `{ поле: имя }` тоже), тело — до
     парной фигурной скобки или до «;» у тела без скобок; шаблон относится к самому
     внутреннему такому циклу. СПИСОК — массив-литерал, объявленный `const`, `let` или `var`
     на верхнем уровне файла один раз (тип после имени допустим, `as const` тоже); элементы —
     объекты с полями-именами или строками и строковыми значениями или массивы строк;
     значение со вставкой, экранированием или кавычкой внутри, другой элемент или больше 1000
     элементов делают список нечитаемым, и шаблон читается как раньше (заглушка, подсказка
     `dynamic_names`). Вставки шаблона — только `${имя}` из деструктуризации; выражение
     (`${newName.toLowerCase()}`) оставляет прежнее чтение. Разворачивается только
     ``sql.raw(`SQL`)``: у тегированного шаблона ``sql`SQL` `` вставка — параметр запроса, а не
     текст SQL. Файл с одним `sql.raw(` без ``sql` `` тоже читается (раньше пропускался по
     признаку ``sql` ``; у immich таких файлов с шаблоном нет). Переименование таблицы или
     колонки в `sqlddl` (общий разбор с SQL-миграциями) переносит ссылки колонок других таблиц
     на неё («т.к» и «т»), как внешний ключ в базе: иначе после переименований immich ссылки
     указывали бы на исчезнувшие имена. Основание таблицы остаётся строкой создания, строка
     переименования добавляется в основания. Пределы: 100 циклов по спискам на файл, 1000
     элементов списка, 200 000 переписываний ссылок на цепочку (дальше ссылки остаются как
     написаны).
     immich: 72 таблицы, как и раньше, из них 30 под новыми именами (`album`, `album_asset`,
     `asset`, `asset_exif`, `asset_face`, `user`, `session`, `tag`, `stack` и другие по списку
     `StandardizeNames.ts:5`); с именами `@Table` в `server/src/schema/tables/*.table.ts`
     совпадают 71 из 72 (было 41), лишняя `migration_overrides` создаётся миграцией без
     описания таблицы. Колонок 513 → 528: изменения поздних миграций под новыми именами
     теперь применяются (`FixColumnNames.ts`: `album_asset.albumId`, `assetId` вместо
     `albumsId`, `assetsId`; `asset_face` без `personId` и с `personGroupId`; `album` без
     `ownerId`; `asset` с `width`, `height`, `isEdited`, `checksumAlgorithm` и без
     `deviceAssetId`, `sidecarPath`), как в описаниях таблиц. Ссылок 75, без цели 16 → 0.
     Подсказка `${oldName}` (`StandardizeNames.ts:40`) ушла, `dynamic_names` в покрытии
     таблиц 1 → 0. Таблицы `workflow_filter`, которую бриф называл примером
     переименования колонки, в клоне нет: `1778614946174-UpdateWorkflowTables.ts:6` удаляет
     её (DROP TABLE в up), переименование колонки до удаления применяется. Lemmy (общий
     разбор SQL): ссылки за переименованиями `user_` → `person` и `tag` → `community_tag`
     теперь следуют за таблицей, 8 ссылок без цели → 0 (`postgres.tables.yaml`, только поле
     `references`). Остальные репозитории и дым без изменений. Кандидат вердикта immich
     `[tables] users` теперь «нет»: таблица называется `user`.
17. **Решения исполнителя части 5б** (2026-11-10, ветка feat/scan-5b, сборщик 0.7.0 без выпуска;
   Java и Kotlin: маршруты Spring и JAX-RS, файлы настроек Spring и Quarkus, связи шлюза,
   Kafka в коде, расписания `@Scheduled`; владелец может отменить, числа перемера в конце
   пункта).
   - К1 (решение исполнителя): общий разбор Java и Kotlin вынесен в `jvm.py` (пакеты по стеку
     с совпадением артефакта по началу «ключ-» и «ключ_», пары скобок одним проходом,
     объявления типов, аннотации, их аргументы и члены класса под ними); разбор линеен:
     заголовок типа ищется до следующего объявления, член класса под аннотацией до следующей
     аннотации списка (её ответ берётся из памяти). Маска Kotlin своя (`codetext._mask_kotlin`):
     вложенный блочный комментарий считается по глубине, сырая строка кончается серией из
     трёх и более кавычек (последние три закрывают), подстановка `${…}` частью строки.
     Сверх пункта, по клону: весь код Petclinic лежит в пакете `org.springframework.samples`,
     и обход исключал его по сегменту `samples` (все 53 файла `src/main/java` восьми модулей
     были в `excluded`). Каталоги под `src/main/java/` и `src/main/kotlin/` теперь
     имя пакета (`walk.package_start`), соглашение действует только до корня исходников; у
     Keycloak по этому правилу из `excluded` ушли `operator/src/main/java/org/keycloak/operator/crds/v2beta1/deployment/spec/`
     (22 файла, пакет `spec`) и `test-framework/test-providers/src/main/java/org/keycloak/testframework/tests/` (2
     файла; каталог `test-framework/` по-прежнему не читается кодом по правилу тестов).
     Правило каталогов тестов (`clike.in_test_dir`, бриф ставил его в К2, нужно уже здесь):
     часть имени каталога через «-», «_» или «.» равна test, tests, testsuite или testsuites,
     либо имя начинается с test и заглавной буквы (наборы Gradle `testFixtures`); `latest`,
     `contest`, `attestation`, `testing` и пакеты под корнем исходников (`org/test/`) кодом
     остаются. Переменная пути с регулярным выражением `{id:[0-9]+}` пишется `{id}` и у
     Spring (бриф просил это для JAX-RS): путь маршрута от выражения не меняется.
     `method` у `@RequestMapping` класса задаёт метод `@RequestMapping` метода без своего
     `method`. Префикс приложения берётся из документа без профиля файла настроек модуля
     (каталог пакета, `jvmconf.py`; разбор файлов настроек общий с Е1). Константы путей
     раскрываются только у Java (`clike.Repo` знает `static final String`); у Kotlin
     `const val` не раскрывается, путь им даёт подсказку. Java и Kotlin в `unsupported`
     маршрутов языком больше не называются (правило К3 части 4): Online Boutique `adservice`
     (gRPC) и `fraud-detection` OpenTelemetry Demo тоже; серверы JVM без разборщика названы
     стеком (`vocab.UNSUPPORTED_ROUTE_DEPS`: Ktor, Micronaut, Javalin, Vert.x, Helidon по точным
     именам артефактов). Petclinic: 16 маршрутов у пяти контейнеров, как ожидал бриф
     (`customers-service` 8, `visits-service` 3, `vets-service` 1, `genai-service` 1,
     `api-gateway` 3), семья маршрутов `covered`, `parsers: [spring]`. Запас по времени на
     враждебном входе: строка и символ маски Java записаны развёрнутым циклом, пробелы маски
     собираются одним шагом (`codetext._blank`); маска та же (сверено со старым модулем на 128
     файлах фикстур и 24 000 случайных строках шести языков), строка в 2 МБ маскируется в десять раз
     быстрее. Разборщик строит пары скобок только у файла с нужными аннотациями, член класса
     ищется прыжками по важным знакам; худшая строка матрицы 0,18 с при пределе 1 с.
