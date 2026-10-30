# ArchMap — CLAUDE.md

Стек (проверено 2026-10-30 по package.json / requirements-prod.txt / pyproject.toml)
- Frontend: React 19 + Vite 8 + TypeScript 6; холст — @xyflow/react 12 + elkjs, схемы логики — mermaid 12
- Backend: Python 3.12 + FastAPI 0.143 (Starlette 1.8, Pydantic 2.14, uvicorn 0.54); SDK MCP (mcp 1.30) —
  в рантайме бэкенда: удалённый MCP-сервер /mcp живёт в его процессе
- БД: PostgreSQL 15+ (localhost:5432, БД `archmap`; второй экземпляр в демо-режиме — `archmap_demo`)
- ORM: SQLAlchemy 2.0 + Alembic (миграции)
- Аутентификация: JWT (PyJWT + pwdlib[bcrypt]); личные токены доступа `archmap_…` для ИИ-агентов и скриптов
  (в БД — sha256; без удалений и администрирования, «только чтение» — по методу)
- Тесты: vitest (фронт), pytest (бэк — на in-memory SQLite; MCP — поверх подменённого httpx)
- Линтеры: tsc + eslint + knip (фронт), ruff + mypy (бэк и MCP)
- Зависимости поставки: backend/requirements-prod.lock с хэшами (pip --require-hashes);
  обновления предлагает Dependabot (.github/dependabot.yml)
- CI: GitHub Actions (.github/workflows/ci.yml) — зеркало pre-commit-гейта плюс сборка фронта,
  дрейф api.gen.ts против app.openapi(), аудит зависимостей, проверка скриптов, Docker Compose
  и Helm-чарт в kind; выпуск по тегу vX.Y.Z — release.yml (образ amd64/arm64 и чарт в GHCR)
- Деплой: Docker Compose (compose.yaml), Kubernetes — Helm-чарт deploy/helm/archmap и образ
  ghcr.io/eidunyushkinhse/archmap (ванильный Kubernetes, без привязки к дистрибутиву), сервер с
  systemd и nginx (deploy/install.sh), см. DEPLOY.md; публичный стенд — https://archmap.tech
  (лендинг) и https://demo.archmap.tech (DEMO_MODE) на серверной поставке; пользовательская документация —
  ОТДЕЛЬНЫЙ репозиторий github.com/eidunyushkinhse/archmap-docs (docs.archmap.tech; вынесена из
  docs-site/ 2026-10-16, локально — ../archmap-docs; у него свои CLAUDE.md и README.md)

Структура проекта (проверено 2026-10-14; счётчики и модули элемента архитектуры — 2026-10-30)
archmap/
├── frontend/              # React + Vite
│   ├── src/
│   │   ├── api/           # клиент бэкенда: client (общий запрос, 401, X-Project-Id), auth, admin, nodes,
│   │   │                  # processes, projects, docsImport, dataRefs, projectScope, tokens, versions, deployment (площадки и размещение)
│   │   ├── lib/           # общие механизмы без разметки: lazyOnce, useAsyncLoad, safeStorage, copyText,
│   │   │                  # connection (признак «нет связи»), motion (prefers-reduced-motion)
│   │   ├── ui/            # общие UI-примитивы: Modal, ConfirmDialog, ErrorBoundary, LoadError, UpdateNotice,
│   │   │                  # ConnectionNotice, InfoPopover, ProfileMenu, icons, styles, plural
│   │   ├── components/
│   │   │   ├── graph/     # движок холста: layout/ (конвейер в Web Worker, роутер стрелок, раскладка, VPSC, ELK),
│   │   │   │              # interaction/ (хуки useLevel*, драг, снап, анимации, undo), узлы, рёбра, проекция
│   │   │   ├── inspector/ # правая панель: NodeInspector, EdgeInspector, GhostInspector, ObjectInspector, DocOverlay
│   │   │   ├── processes/ # бизнес-процессы: sequence-диаграммы, рейл, композитор, импорт из mermaid
│   │   │   ├── project/   # создание и правка проектов, ввоз (ImportPane), догрузка, доступ, превью схемы
│   │   │   │   └── remainder/  # разбор остатка слияния вопросами (блок, статус, свёртка, чистый модуль вопросов)
│   │   │   ├── docsImport/# окна «Доки от агента» (BYOA): схемы логики, разведка, факты, синк из репозитория
│   │   │   ├── anchor/    # поле и тексты источника объекта (source_ref; в коде понятие зовётся anchor)
│   │   │   ├── element/   # элемент архитектуры: строка «Тип» (TypeSelect, useTypePick) и справка «?»,
│   │   │   │              # варианты поля «Тип» по контексту (typeOptions), окно первого вложенного объекта
│   │   │   │              # при переносе, смена элемента с последствиями, «Перенести документацию» /
│   │   │   │              # «Собрать с компонентов»
│   │   │   ├── users/     # меню профиля (смена пароля, «Токены для MCP»), окна экрана «Пользователи»
│   │   │   ├── login/     # анимированное превью схемы на странице входа
│   │   │   ├── demo/      # демо-режим: плашки и тосты пределов проекта
│   │   │   ├── tour/      # обучающий тур демо: шаги, машина состояний, слой подсказок, пилюля «Обучение»
│   │   │   ├── nodePage/  # части страницы объекта: свойства (в т.ч. строка «Размещение»), секции «Логика»/«OpenAPI»/«Схема» по элементу, группы потомков
│   │   │   ├── deployment/# режим «Развёртывание»: проекция графа площадок на холст, окна «Размещение» и «Площадки»,
│   │   │   │              # конфликты размещения контейнера целиком (placementConflicts, PlacementConflictList)
│   │   │   ├── __tests__/ # vitest-тесты компонентов и чистых функций (всего во фронте 256 тестовых файлов)
│   │   │   ├── LevelGraph.tsx  # ядро холста (RF-обёртка, конвейер, locate, выделение)
│   │   │   ├── nodeTerms.ts    # подписи форм, статусов и видов схем — один словарь на весь фронт
│   │   │   └── ...        # секции фактов (БД, каналы, конфигурация), модалки, дерево (NodeTreePanel; режимы
│   │   │                  # карта / страницы / развёртывание — nodeTree.mode), алерты, фильтр вида
│   │   ├── pages/         # ProjectShell (оболочка), ProjectHomePage, NodePage (страница объекта), DeploymentPage
│   │   │                  # (холст «Развёртывание»: дерево слева, режим размещения — useDeploymentPlacing), MapEditorPage
│   │   │                  # (редактор-карта), ProjectsPage, UsersPage, LoginPage, DemoLoginPage; хуки страниц:
│   │   │                  # useLevelSchema, useRemoteSync (поллинг и startPollLoop), useNodePatch, useToast;
│   │   │                  # workMode — режим оболочки «Объекты · Процессы · Развёртывание» и его память (archmap_mode)
│   │   ├── types/         # api.gen.ts (генерат из OpenAPI), index.ts (фасад алиасов)
│   │   └── embed/         # живая схема для лендинга: холст на снимке демо-проекта без бэкенда (embed.html, npm run build:embed)
│   ├── scripts/           # replay-prof.ts, route-quality.ts — замеры роутера (npm run replay-prof / route-quality)
│   ├── knip.json          # поиск мёртвого кода (npm run knip; в CI)
│   ├── package.json
│   └── vite.config.ts     # прокси /api и /mcp → localhost:8000, vitest (jsdom), пороги покрытия
├── backend/               # FastAPI
│   ├── app/
│   │   ├── models/        # SQLAlchemy: project, project_member, user, node, edge, node_doc, view_layout, view_state,
│   │   │                  # db_table/db_column, broker_channel/channel_field, config_param, business_process, process_*,
│   │   │                  # personal_token, node_version, deployment_site/deployment_instance (площадки и экземпляры)
│   │   ├── routers/       # 26 роутеров /api/v1: auth, admin, users, tokens, demo, projects, nodes, edges, views, export, search,
│   │   │                  # processes, node_docs, docs_import, recon, data_refs, db_docs, data_import,
│   │   │                  # broker_channels, channels_import, config_params, config_import, versions, deployment,
│   │   │                  # facts (перенос и сбор фактов), uploads (одноразовая ссылка загрузки)
│   │   ├── schemas/       # Pydantic-контракт API (30 модулей; из него генерируется api.gen.ts)
│   │   ├── main.py        # FastAPI app, CORS, lifespan, роутеры /api/v1, /health, /ready и /mcp
│   │   ├── config.py      # Settings — все поля описаны в backend/.env.example
│   │   ├── domain_types.py  # словари предметной области (Literal формы, статусы, роли…) и pick
│   │   ├── auth.py / deps.py / access.py  # JWT, личные токены и пароли; общие зависимости (node_or_404, commit_change…); роль в проекте
│   │   ├── personal_tokens.py / mcp_http.py  # личные токены (выпуск, поиск по хэшу, тексты запретов);
│   │   │                  # /mcp — клей удалённого MCP (демо, метод, Origin, лимиты, проверка токена, lifespan)
│   │   ├── database.py / column_limits.py / view_state.py  # сессия и пул; длины строк до flush (422, а не 500); CAS-версии
│   │   ├── tree.py / reparent.py / restore.py / projects.py / copy_plan.py / transition.py
│   │   │                  # дерево узлов, перенос, Undo удаления, копия проекта, «Принять переход»
│   │   ├── element.py / element_rules.py / element_marks.py / element_change.py / facts_transfer.py /
│   │   │   import_element.py / container_hints.py  # элемент архитектуры: действующий элемент, правила
│   │   │                  # записи, адаптер к БД, последствия смены, перенос и сбор фактов, санитизация
│   │   │                  # ввоза, вопрос «похоже на контейнер»
│   │   ├── graph_queries.py / context_graph.py / alerts.py / connectivity.py  # граф уровня, контекст-схема, алерты
│   │   ├── export.py / import_yaml.py / import_merge.py / merge_report.py / merge_warnings.py
│   │   │                  # YAML C4: экспорт, импорт, слияние прогонов, отчёт и анализаторы слияния
│   │   ├── identity.py / node_ref.py / name_match.py  # источник объекта; адреса узлов (NodeIndex); «похоже на …»
│   │   ├── sync_plan.py / sync_apply.py  # синк живой схемы с прогоном агента
│   │   ├── unified_import.py / unified_remarks.py / unified_preview.py / unified_apply.py / unified_into.py
│   │   │                  # единый ввоз N входов: план, остаток и тексты, превью, применение, догрузка
│   │   ├── archive_export.py / archive_import.py  # архив знания (zip)
│   │   ├── docs_import.py / docs_pkg.py / recon_import.py / data_refs.py  # доки от агента (план, разбор пакета), разведка, пометки
│   │   ├── facts_import.py / data_import.py / channels_import.py / config_import.py  # табличные факты: общее и три семьи
│   │   ├── *_prompt.py    # промпты агенту (import, docs, recon, data, channels, config, skeptic) — под снапшотами
│   │   ├── processes.py / process_import.py / process_export.py / process_copy.py  # бизнес-процессы
│   │   ├── search.py / text.py / mmd_header.py  # поиск по знанию проекта; нормализация текстов; шапка .mmd
│   │   ├── project_cards.py  # карточки списка «Проекты» (счётчики, мини-граф, роль)
│   │   ├── admin.py       # серверная команда create-admin (первый администратор)
│   │   ├── demo.py / demo_limits.py / demo_package.py  # демо-режим (гость, песочница, уборка); пределы проекта; посев пакета
│   │   ├── rate_limit.py / standalone.py  # счётчик событий по адресу; API и фронт одним процессом (образ без nginx)
│   │   └── template_packages/  # демо-пакет «Ярмарка» — распакованный архив знания, сеется единым импортом
│   ├── alembic/           # миграции БД
│   ├── tests/             # pytest (87 тестовых файлов, in-memory SQLite; snapshots/ — снимки промптов)
│   ├── requirements.txt   # dev-окружение: requirements-prod.txt + тесты и линтеры
│   ├── requirements-prod.txt / requirements-prod.lock  # то, что едет на сервер; lock — с хэшами
│   ├── .env.example       # шаблон backend/.env — все поля Settings
│   └── pyproject.toml     # ruff, mypy, порог покрытия
├── mcp/                   # MCP-сервер ArchMap для ИИ-агента ПОЛЬЗОВАТЕЛЯ (не для разработки): локально по stdio
│   │                      # и удалённо — /mcp в процессе бэкенда (пакет едет в поставки рядом с app/)
│   ├── archmap_mcp/       # client.py (логин или личный токен, скоуп, перевод отказов), tools.py (37 инструментов:
│   │                      # чтение, поиск, промпты, превью → применение, точечные правки, версии документации, размещение;
│   │                      # удалений нет; удалённый набор — 34, без диска агента), remote.py (Streamable HTTP без состояния, журнал вызовов),
│   │                      # render.py, server.py (stdio; отказы — isError)
│   ├── tests/             # pytest поверх подменённого транспорта httpx (живой сервис не нужен)
│   ├── requirements.txt / requirements-dev.txt  # рантайм; инструменты гейта по пинам, как в CI
│   ├── .env.example       # ARCHMAP_URL + ARCHMAP_TOKEN (или USERNAME/PASSWORD) → копировать в mcp/.env (в .gitignore)
│   └── README.md          # удалённое и локальное подключение, токен, строки клиентов, каталог, HTTPS с корпоративным CA
├── scripts/
│   ├── git-hooks/pre-commit  # гейт по staged: фронт / бэк / mcp
│   ├── setup-hooks.sh     # установка хука
│   ├── agent-docs.py      # сборка QWEN.md из CLAUDE.md (--check — сверка в хуке и CI)
│   ├── dev-demo.sh        # второй экземпляр в демо-режиме (БД archmap_demo, порты 8001/5174)
│   ├── *-probe.mjs / arrow-metrics.mjs / dump-levels.mjs / page-fit-diag.mjs  # полигонные зонды
│   │                      # (токен — probeToken.mjs, учётка-читатель — probe-reader.py)
│   ├── hub-survey.py      # метрики формы по всем уровням проектов (перф)
│   ├── refresh-demo-template.py  # обновление пакета демо-шаблона из живого эталона в БД
│   ├── seed-alerts-demo.py  # стенд, на котором горят все классы алертов
│   ├── landing-shots.mjs / landing-videos.mjs / landing-embed-scene.mjs  # кадры, видео и живая схема лендинга
│   ├── c4-compare/        # измеритель сверки C4-схем (QA импорта)
│   └── fixtures/          # mock-import.yaml — фикстура кадров лендинга
├── deploy/                # поставка (DEPLOY.md)
│   ├── build-bundle.sh    # офлайн-архив с переносным Python → dist-bundle/
│   ├── install.sh         # сервер: systemd, nginx, копия базы перед миграциями, откат релиза по /ready
│   ├── archmap.service / archmap.env.example / archmap-admin  # юнит с песочницей systemd, шаблон настроек, команды
│   ├── backup.py / preflight.py / runenv.py  # pg_dump перед миграциями; проверка базы; чтение archmap.env
│   ├── docker/            # старт образа: ключ подписи (из env или тома /data), preflight и миграции
│   │                      # (MIGRATE_ON_START), archmap-admin
│   └── helm/              # Helm-чарт archmap (Secret, init-миграции, Ingress/HTTPRoute, Pod Security
│                          # «restricted») и e2e-kind.sh — установка в kind (CI-джоба helm, так же локально)
├── Dockerfile             # единый образ для Compose и Kubernetes: amd64/arm64, UID 10001, корень только
│                          # для чтения, базовые образы по digest (Dependabot)
├── compose.yaml           # «Поставить себе»: docker compose up -d → :8080 (ArchMap + PostgreSQL; CI-джоба compose)
├── docs/
│   ├── specs/             # нормативные спеки движка (12 файлов + README)
│   ├── tasks/             # ТЗ фич (демо-режим и тур, доступ к проектам, админка, вход, поиск…)
│   ├── archive/           # рабочие доки закрытых эпиков (включая планы)
│   ├── plan-*.md / qa-*.md / review-*.md  # живые планы эпиков, полевые замеры, ревью
│   ├── refactoring-lessons.md  # уроки и playbook рефакторинга
│   ├── tasks-archive.md   # журнал закрытых задач
│   ├── docs-delta.md      # что изменилось в продукте относительно docs.archmap.tech (пополнять в коммите фичи)
│   ├── plan-refactoring.md # план рефакторинга по итогам аудита 2026-08-01
│   └── plan-audit-2026-10.md # аудит 2026-10-13: реестр находок (безопасность, надёжность, зависимости, дубли) и план фаз 0–8
├── .claude/               # LSP-серверы (mcp-servers/), агент-исполнитель (agents/), строка статуса, settings.json
├── .github/               # CI (workflows/ci.yml) и Dependabot (dependabot.yml)
├── dev.sh / stop.sh       # запуск/остановка всего стека
├── DEV.md                 # локальный запуск: подробности и ручной режим
├── DEPLOY.md              # установка: Docker Compose, Kubernetes (Helm), сервер; обновление, журналы, копии
├── README.md              # витрина репозитория
├── LICENSE                # AGPL-3.0-only (решение 2026-10-15); разрешение раздела 7 для elkjs (EPL-2.0) — в README
├── spec.md                # продуктовая спецификация
├── tasks.md               # живые задачи и бэклог
├── .mcp.json              # MCP-серверы: LSP (python-lsp, typescript-lsp) + archmap (учётка — в mcp/.env);
│                          # пути относительные — сессию запускать из корня репозитория
├── .nvmrc                 # версия Node для разработки и CI
└── QWEN.md                # тот же файл для Qwen Code — собирается из этого (scripts/agent-docs.py)

Команды
- Поднять весь сервис:   ./dev.sh         (бэк+фронт+миграции одной командой)
- Остановить:            ./stop.sh        (или Ctrl+C в терминале с dev.sh)
- Поставка на сервер:    deploy/build-bundle.sh   (→ dist-bundle/*.tar.gz; установка — DEPLOY.md)
- Образ:                 docker build -t archmap .   (Dockerfile в корне; готовые версии — GHCR по тегу vX.Y.Z)
- Helm-чарт в kind:      deploy/helm/e2e-kind.sh  (KIND/HELM/KUBECTL — пути к утилитам; NODE_IMAGE=kindest/node:v1.34.11
    на Docker Desktop с cgroup v1; KEEP=1 — оставить кластер)
- Docker Compose:        docker compose up -d --build  (→ http://localhost:8080; первый админ —
    docker compose exec archmap archmap-admin create-admin admin; DEPLOY.md «Docker Compose»)
- Запуск фронта:         cd frontend && npm run dev
- Запуск бэкенда:        cd backend && ./venv/bin/uvicorn app.main:app --reload
- Миграции (создать):    cd backend && ./venv/bin/alembic revision --autogenerate -m "название"
- Миграции (применить):  cd backend && ./venv/bin/alembic upgrade head
- Тесты бэкенда:         cd backend && ./venv/bin/python -m pytest -q
- Тесты фронта:          cd frontend && npx vitest run
- Документация (сайт):   отдельный репозиторий ../archmap-docs (github.com/eidunyushkinhse/archmap-docs):
    там npm run dev → http://localhost:8800, вход автора /login, редактор /edit/, правки коммитит сам
    сервер; команды и правила — его README.md и CLAUDE.md
- Живая схема лендинга:  cd frontend && npm run build:embed   (→ frontend/dist-embed; снимок сцены —
    node scripts/landing-embed-scene.mjs при поднятом ./dev.sh)
- Типизация фронта:      cd frontend && npx tsc -b
- Линтер фронта:         cd frontend && npx eslint .
- Линтер бэкенда:        cd backend && ./venv/bin/ruff check .
- Типизация бэкенда:     cd backend && ./venv/bin/mypy app/
- Мёртвый код фронта:    cd frontend && npm run knip
- Гейт MCP-сервера:      cd mcp && ./venv/bin/ruff check . && ./venv/bin/mypy && ./venv/bin/python -m pytest -q
- Снапшоты промптов:     ПОСЛЕ ОСОЗНАННОЙ правки любого промпта (app/*_prompt.py):
    cd backend && UPDATE_PROMPT_SNAPSHOTS=1 ./venv/bin/python -m pytest tests/test_prompt_snapshots.py -q
    Затем ОБЯЗАТЕЛЬНО посмотреть `git diff backend/tests/snapshots/` — это ревью правки —
    и закоммитить снимки вместе с правкой промпта. Тексты промптов под абсолютным
    сторожем: относительные сентинелы «байт-в-байт» правку безусловной строки не видят.
- Генерация типов из OpenAPI: cd frontend && npm run gen:api
    (дамп app.openapi() бэкендовым venv-python | openapi-typescript → src/types/api.gen.ts).
    Файл коммитится, идемпотентен.

Запуск сервиса (ВАЖНО)
- Поднимать сервис ТОЛЬКО через ./dev.sh — НЕ запускать uvicorn/vite вслепую
  вручную. Скрипт сам проверяет Postgres, создаёт БД, накатывает миграции,
  ставит зависимости и поднимает оба процесса согласованно. Подробности и
  ручной режим — в DEV.md.
- Claude запускает его как фоновую задачу (run_in_background) — так процесс
  переживает teardown харнесса.
- Останавливать через ./stop.sh. Если порт занят — сначала ./stop.sh, потом
  ./dev.sh; либо другие порты: BACKEND_PORT=8001 FRONTEND_PORT=5174 ./dev.sh.

Git
- Проект под git с 2026-06-07. Remote: github.com/eidunyushkinhse/archmap
  (ПУБЛИЧНЫЙ с 2026-09-26). Пушить можно (пользователь дал разрешение).
  История до 2026-09-26 переписана при публикации: хэши коммитов, упомянутые
  в документах и памяти, в этом репозитории не открываются.
- РЕПОЗИТОРИЙ ПУБЛИЧНЫЙ: в код, тесты, документацию, планы и сообщения
  коммитов не попадают названия рабочих систем владельца и чужих
  инфраструктур. Живые сцены dev-базы называть так, как они названы в базе
  сейчас; для примеров брать демо-сцены («Ярмарка», «Плёнка») и открытые
  проекты (Zabbix, Grafana, Zulip, Sentry, Mastodon). Сомневаешься, можно ли
  называть систему, — спроси владельца.
- Рабочая ветка — main (solo-проект): эпик пивота страниц слит merge-коммитом
  9c7a830 (2026-08-09), ветка feat/pages-pivot удалена. Мелкие правки —
  коммитом прямо в main; под новый ЭПИК заводить отдельную ветку и сливать её
  через --no-ff (merge-коммит даёт границу эпика и точку отката revert -m 1).
- ПОСТОЯННОЕ РАЗРЕШЕНИЕ коммитить самому: после каждого логически
  завершённого и проверенного изменения сразу делать коммит, НЕ дожидаясь
  отдельной просьбы. Это переопределяет дефолт «коммитить только по запросу».
- Перед коммитом убедиться, что приложение запускается / тесты проходят;
  заведомо сломанное состояние не коммитить. Pre-commit хук (scripts/git-hooks/)
  автоматически гоняет tsc+eslint+vitest (фронт) и ruff+pytest (бэк) по
  staged-файлам. CI (.github/workflows/ci.yml) дублирует гейт на сервере.
- Коммиты маленькие, по одной логической правке. Сообщения на русском,
  формат: "feat: …" / "fix: …" / "chore: …" / "docs: …". Последней строкой —
  Co-Authored-By с моделью, которая писала коммит, например:
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
- После коммита называть в ответе хэш и сообщение. Состояние видно в
  statusline: «⎇ main ✓» — всё закоммичено, «⎇ main ±N» — N несохранённых.
- Откат делать через git (reset/revert/checkout/stash), не правкой вслепую.
- Не коммитить: node_modules, venv, dist, .claude/mcp-servers/{venv,
  node_modules}, **/settings.local.json, реальные .env — уже в .gitignore.

Ключевые сущности (проверено 2026-08-01 по моделям SQLAlchemy)

Project (проект — изолированная схема)
- id UUID, name, description, archived_at (null = активен)
- visible_to_all — «Виден всем пользователям»: не-участники получают чтение
  (иначе проект виден только участникам)
- created_at, updated_at, created_by_id, updated_by_id → User
- graph_rev — курсор изменений СХЕМЫ (узлы/рёбра/раскладка), meta_rev — курсор
  изменений МЕТЫ (атрибуты узла/доки/openapi); поллинг конкурентных сессий
- Все доменные сущности несут project_id (NOT NULL, каскад)

Node (узел)
- id UUID, project_id → Project, name, description
- role        — свободная строка: "сервис", "БД", "брокер"
- technology  — свободная строка: "Python", "Kafka", "Redis"
- parent_id   — ссылка на родителя (null = корень дерева)
- shape       — форма C4: service | database | broker | person
- is_external — флаг «внешний узел» (на чужих уровнях — «гость»)
- status      — жизненный цикл: existing | planned | deprecated
- openapi_spec — OpenAPI YAML (опционально)
- source_ref — ИСТОЧНИК (в интерфейсе, документации и спеках; до 2026-10-17 — «якорь», в коде
  понятие по-прежнему anchor/source_ref): чем ArchMap опознаёт объект при обновлениях из кода
  (мердж, догрузка, синк) вместо имени. Видов два: код (`git:repo#path`) и имя
  зависимости (`host:name`); в API — разобранным `source {repo, path, host}`,
  задаётся и чистится PATCH-полем `source` (app/identity.py, docs/plan-anchor-ux.md)
- version     — CAS-версия для optimistic concurrency
- docs        — коллекция NodeDoc (именованные схемы логики, lazy="selectin")
- created_at, updated_at
- has_children — вычисляемое поле в API
- element     — элемент архитектуры: system | container | NULL (NULL — «не сказано»: узел с детьми
  читается системой, как до эпика docs/plan-c4-elements.md); задаётся только у сервиса и не внутри
  контейнера, без базы, брокера и другого контейнера внутри (app/element_rules.py, 422); лист с
  хранимым system — пустая система (Р39, 2026-10-30). В интерфейсе — тип из шести значений
  (nodeTerms.typeOf: система, контейнер, компонент, база данных, брокер, пользователь); первый
  вложенный объект задаёт элемент родителя полем NodeCreate.parent_element (Р38)
- element_effective — вычисляемое в API: system | container | component, у person — null; считает
  ТОЛЬКО app/element.py (адаптер к БД — app/element_marks.py), фронт и MCP его не вычисляют
- container_name — вычисляемое в API: имя ближайшего контейнера у компонента (у остальных null)

NodeDoc (схема логики узла; прежнее единственное поле Node.flowchart перенесено сюда)
- id, node_id → Node, name (уникально в пределах узла)
- kind — операция | воркер (оба — точки входа; вид «обзор» удалён 2026-08-18)
- operation — привязка к операции спеки («METHOD /path»), опционально
- content — текст Mermaid
- version — CAS

Edge (связь)
- id UUID, project_id → Project
- label, technology
- source_id, target_id → Node
- is_synchronous — тип канала (null = дефолт синхронный)
- version — CAS
- created_at

ConfigParam (параметр конфигурации сервиса — третья семья фактов после структуры БД
и каналов брокера; docs/plan-config-docs.md)
- id, node_id → Node (CASCADE), name (уникально в пределах узла)
- description — «что переключает», value_type — свободная строка, required — булево
- default_value — ТЕКСТ ДЕФОЛТА ИЗ КОДА. ЗНАЧЕНИЙ СРЕД НЕ ХРАНИМ НИКОГДА
- version — CAS
- Владелец параметра — КОНТЕЙНЕР (сервис с действующим элементом «контейнер»: лист вне
  контейнера или контейнер с компонентами); одинаковый параметр у двух контейнеров — две записи.
  Пометка «зависит от: ИМЯ» в тексте схемы логики резолвится ТОЛЬКО среди параметров ближайшего
  контейнера владельца схемы (у компонента — контейнера-предка), поэтому «неоднозначно»
  по-прежнему невозможно по построению (класс алертов AL33 называет контейнер). Свои параметры у
  системы и компонента — старые данные, их ловят AL24 и AL36

ProjectMember (участник проекта)
- ключ (project_id → Project, user_id → User), оба CASCADE; role — owner | editor | reader
- владелец ровно один (держит код app/access.py, передача — POST /projects/{id}/transfer)
- права ВНУТРИ проекта решает только effective_role: админ → owner, участник → его
  роль, visible_to_all → reader, иначе 404. Общая роль: architect создаёт проекты и
  бывает owner/editor/reader; viewer («Пользователь») — только reader (can_edit в
  app/access.py: назначение, передача владения, понижение роли); администратор
  (признак is_admin) — всегда architect и owner в любом проекте: полные права

ViewLayout / ViewState
- view_layout: project_id, view_id, item_id, payload JSONB {x, y, expanded}
- view_state: version (fence для CAS батчей layout)

BusinessProcess / ProcessParticipant / ProcessMessage / ProcessFragment
- Бизнес-процессы — sequence-конструктор поверх C4

Архитектурные правила
- API всегда версионируется: /api/v1/...
- Все эндпоинты возвращают JSON
- Ошибки возвращаются в формате {"detail": "..."}
- Коллекции объявляются БЕЗ хвостового слэша (`@router.get("")` → `/api/v1/nodes`);
  `redirect_slashes` выключен — промах формы даёт 404, а не тихий 307 с пустым
  телом (полевая находка эпика MCP 2026-09-04)
- Фронт общается с бэком только через /api/v1/ (прокси Vite)
- Никаких бизнес-логики на фронте — только отображение и запросы
- Миграции БД только через Alembic, не трогать схему руками

Правила разработки
- Комментарии в коде писать на русском
- ЖАРГОН В ПРОДУКТ НЕ ТАЩИМ (незыблемое правило владельца, 2026-10-29). Слово «спека» в любой
  форме не пишется нигде, где его увидит пользователь или его агент: интерфейс, сообщения API и
  превью, промпты, MCP (описания инструментов, рендер, README), сайт документации, лендинг,
  демо-пакет. Только «спецификация». Между собой — комментарии в коде, docs/, память, разговор —
  можно. Сторож: grep -rP '(?<![а-яёА-ЯЁ])[Сс]пек(а|и|у|ой|е|ам|ах|ами)?(?![а-яёА-ЯЁ])' по строкам
  в кавычках и JSX-тексту frontend/src, backend/app, mcp/ должен находить только комментарии и
  докстринги. Тот же принцип для любого нового текста: пользователь не обязан знать внутренний
  словарь («доки», «алерты», «рамка», «гость») — в UI говорим словами продукта
- После каждого изменения убедиться, что приложение запускается
- Косметические фронтенд-правки не проверять визуально. Триггер (оба условия):
  (1) правка только во фронтенде; (2) пользователь в промпте ЯВНО назвал её
  косметической (слова «косметика»/«косметическая»/«косметический» о самой правке).
  Тогда НЕЛЬЗЯ: запускать headless-браузер (Playwright/Chromium), делать скриншоты,
  читать вычисленные стили, гонять визуальную проверку рендера. Пользователь смотрит
  результат глазами сам — это быстрее и без лишних токенов. МОЖНО (и нужно) оставить
  дешёвую статику: ts_diagnostics на изменённых файлах. Если сомневаешься, косметическая
  ли правка, или она затрагивает не только фронт — правило НЕ применять, спросить.
- Не менять существующие API-контракты без явного запроса
- TypeScript: не использовать any, типизировать всё явно
- Типы контракта на фронте ГЕНЕРИРУЮТСЯ из OpenAPI, не пишутся руками.
  src/types/api.gen.ts — артефакт openapi-typescript (правится только
  перегенерацией, баннер в шапке); src/types/index.ts — фасад алиасов на него с
  привычными именами. ПРАВИЛО: изменил Pydantic-схемы (backend/app/schemas/*) →
  сразу `cd frontend && npm run gen:api`, проверь `tsc -b` и закоммить
  обновлённый api.gen.ts вместе с правкой схем. Если генерат вышел слабее нужного —
  чинить Pydantic-схему (Literal/required), а НЕ накладывать патчи на фронте.
- Работа с git — см. секцию «Git» выше (коммитить самому на чекпойнтах)
- Документация всегда актуальна (кроме чисто косметических изменений):
    при появлении новой фичи — сразу обновить spec.md;
    при её реализации — отметить в tasks.md (перенести в «Сделано» / обновить статус).
    Косметику (правки стиля, отступы, переименования подписей и т.п.) можно не документировать.
- QWEN.md — тот же файл для Qwen Code, собирается из CLAUDE.md: правишь CLAUDE.md →
  python3 scripts/agent-docs.py и коммитишь оба (хук и CI сверяют их через --check);
  строки про самого агента — в таблице AGENT_LINES скрипта.
- Элемент архитектуры считает ТОЛЬКО `app/element.py`; факт процесса — у ближайшего контейнера,
  факт кода — у листа или компонента (docs/plan-c4-elements.md, раздел 1)

Архитектурные привычки (фронтенд)
- Это дефолты, реагирующие на видимый «смелл» в коде, а НЕ чек-лист для сверки
  перед каждой правкой. Замечаешь смелл — применяешь; нет смелла — не думаешь.
- Один модуль — одна ответственность. Смелл: файл > ~400 строк, либо в нём
  одновременно рендер + вычисления + сайд-эффекты, либо скроллишь в поисках
  функции. Реакция: вынести по границе ответственности сразу, не ждать God
  Component (ориентир — разбивка graph/* из Фазы 2). LevelGraph разобран
  (1678→1055, пропсы 43→19, 7 хуков useLevel* в graph/interaction/) — эталон;
  NodePage тоже похудел. Уроки и playbook — docs/refactoring-lessons.md.
- God-компонент разбирать ТОЛЬКО после поведенческих тестов: characterization-
  тесты на оркестрацию (рендер внутреннего компонента с моком тяжёлых зависимостей,
  перехват колбэков) — страховочная сетка; без неё разбор вслепую ломает ядро
  (кейс LevelGraph — фаза 3а). Порядок выноса: сначала изолированные хуки (только
  читают: locate/selection), потом центральные узлы (persistence/commitLayout —
  точка схождения), потом зависимые (drill). Один хук — один коммит; новые хуки в
  тестах НЕ мокаются (исполняются по-настоящему), иначе тесты ничего не ловят.
- Пропсы god-компонента группировать в НЕСКОЛЬКО связных доменных бандлов
  (persistence/mode/drill/edgeCallbacks/delete/drop/undo), в точках вызова — через
  useMemo (ссылочная стабильность, без ре-рендеров канваса). Общие типы — в общий
  модуль (graph/types.ts), чтобы не было type-only циклов компонент↔хуки.
- Атомарные ядра с инвариантом порядка эффектов НЕ выносить: конвейер раскладки
  LevelGraph (сборщик обязан быть объявлен до data→computeNow эффекта; частичный
  вынос молча ломает батчинг анимации, тесты не ловят). Чистый пол LevelGraph
  ~1055 строк; <800 достижимо только фрагментацией JSX (осознанно не делалось).
- Производное состояние — в рендере (useMemo), не в useEffect. Смелл: эффект,
  заканчивающийся setState. Зеркалирование пропсов/стейта в стейт через эффект —
  источник рассинхрона.
- Строгость типов/линтеров в гейте (TS strict + eslint strict + mypy на бэке с
  pydantic-плагином) дёшева при дисциплине «без any»: код был strict-чист ДО
  включения флага (0 ошибок). Что машина может проверить — отдаём машине.
- Сломанные контракты (обязательный проп без обновления вызовов и т.п.) НЕ держим
  в голове — их ловит гейт «зелёный билд/тесты перед коммитом» (pre-commit гоняет
  ВСЕ тесты + CI-зеркало; --no-verify не используется).
- Коммитить и пушить по фазам: долгие фоновые ИИ-сессии могут встать при обрыве
  сети — запушенный в origin прогресс не теряется.
- Ошибка загрузки показывается пользователю (ui/LoadError, lib/useAsyncLoad); `void
  promise` без catch не пишем — молча пустая страница хуже честного «не загрузилось».
- Экспорт без потребителя не заводится: knip в CI (`npm run knip`) красит сборку.
- Экран входа держать лёгким: страницы после входа — React.lazy (App.tsx), Suspense
  внутри страничной границы ошибок. Статический импорт тяжёлого модуля ради редкого
  запасного пути — тоже лениво (lib/lazyOnce).
- Окна поверх холста — один стек в порядке открытия (processes/useOverlayStack): верхнее
  рисуется последним и первым закрывается по Escape. Приоритет закрытия списком и порядок
  наложения разметкой расходятся молча (подтверждение открывалось под панелью).
- Нативный <dialog> (ui/Modal) сам владеет своим Escape: document-обработчик, который
  гасит клавишу (preventDefault), глушит его cancel — и вопрос «закрыть без сохранения?».
  Свой Escape — только для div-оверлеев, и не тогда, когда сверху модалка.
- God-компонент режется правками-функциями с общим контекстом (processes/editCtx,
  *Edits): без своего состояния и хуков, зовутся каждый рендер — замыкания видят свежие
  данные, как в теле компонента. Перед выносом — страховочный тест, зелёный и на старой
  версии (файл старой версии подставляется на время прогона).
- N параллельных классов (разделы алертов, семьи фактов) — одна запись на класс в одном
  списке, сумма и разметка — по нему же (SchemaAlerts.ALERT_SECTIONS); три параллельных
  списка расходятся незаметно.
- CSS-класс импортирует каждый модуль, который его ставит (ui/smallButton.css): стили
  чужого ленивого чанка на этой странице могут быть не загружены.
- Эффект, которому нужно свежее состояние на момент события, — useEffectEvent, а не
  eslint-disable exhaustive-deps (nodeTree.useLazyTree).

Архитектурные привычки (бэкенд и процесс) — уроки аудита 2026-10
- Любая запись строк по id из тела запроса проверяет принадлежность проекту — и
  «служебная» (restore, импорт, снимки). Сторож — тесты чужих ссылок в test_restore.
- Длины строк проверяет app/column_limits до flush (422 текстом, а не 500 Postgres);
  новая String-колонка подхватывается сама, сторож — test_column_limits. Обход предков —
  с seen или счётчиком шагов: данные снимков и импорта бывают циклическими. Регулярка
  на пользовательском тексте — с замером на враждебном входе (тест времени).
- Общее — в одном месте, копию не заводить: deps (node_or_404, owned_or_404, name_taken,
  check_cas, commit_change), node_ref.NodeIndex (путь узла), facts_import (семьи фактов),
  data_refs.doc_ref_hits (обход пометок), name_match (подсказка «похоже на …»), yaml_io.
- Словари предметной области (формы, статусы, роли, виды) — только app/domain_types;
  колонки — Mapped[Literal], разбор входа — через pick (проверка «in» тип не сужает).
- Домен — в app/*, роутер — HTTP: 404/422, перевод доменной ошибки (ProcessRuleError,
  AnchorError) в ответ и коммит. Правило предметной области в роутере — смелл.
- Сложность > 15 (C901) — пофайловый ratchet в backend/pyproject.toml: распилил модуль —
  убери его из списка; новые модули в список не добавляются.
- Рефакторинг алгоритма сверяется со старой версией на всех проектах dev-базы: старый
  модуль из `git show HEAD:…` грузится рядом с новым, ответы сравниваются (только чтение).
- Оптимизация — только после замера; кэш с инвалидацией по курсорам — только если замер
  показывает боль (риск устаревших данных при любой записи без сдвига курсора).
- Зависимости: аудит в CI, обновления предлагает Dependabot, поставка — по lock с хэшами.

Спецификации движка (docs/specs)
- docs/specs/ — нормативный реестр поведения движка/холста, 12 спек: edge
  (связь), node (узел), container (контейнер), guest (гость), canvas (холст и
  выделение), history (Undo/Redo), view (уровень и вид), alerts (алерты),
  context (контекст-схема), transitions (анимации переходов), perf
  (производительность рендерера), deployment (холст «Развёртывание»); формат
  инвариантов, правило старшинства и карта «модуль → спека» —
  docs/specs/README.md.
- ПРАВИЛО: правишь движок/холст (модули из карты README: graph/**,
  LevelGraph/TreePage, бэк-эндпоинты графа/вида/алертов/контекста) → пройди
  регрессионный чек по затронутым спекам (процедура в README) и прогони
  указанные в инвариантах тесты; осознанно меняешь поведение или константу →
  обнови спеку В ТОМ ЖЕ коммите. При расхождении спеки с кодом сначала выясни,
  что из двух — баг.

LSP-навигация
- В проекте НЕТ встроенного LSP. Единственный доступный LSP — это два MCP-сервера,
  объявленные в .mcp.json. Пользоваться только ими, других LSP-инструментов не существует:
    Бэкенд (Python):  mcp__python-lsp__python_definition / python_references /
                      python_diagnostics / python_hover
    Фронтенд (TS):    mcp__typescript-lsp__ts_definition / ts_references /
                      ts_diagnostics / ts_hover
  Если в начале сессии этих инструментов в списке нет — значит .mcp.json не подхватился,
  нужен рестарт сессии. Не выдумывать «встроенный LSP» и не выдавать обычный Read за LSP.
- Для определений, ссылок и диагностики использовать эти MCP-инструменты, а не grep/Read.
- Read применять только когда нужен контекст вокруг кода, а не навигация.

- ВАЖНО — статус инструментов (проверено 2026-05-30 на реальных файлах):
    TypeScript: работают все 4 функции (definition, references, diagnostics, hover).
                Курсор ставить точно на идентификатор: ts_definition при позиции вне
                границ строки падает с внутренней ошибкой tsserver, а не возвращает пусто.
    Python:     работают definition, references, diagnostics.
                python_hover СЛОМАН — всегда отвечает «Информация недоступна», даже на
                валидных символах. Это не ошибка позиции.
- Воркэраунд для типа Python-символа (раз hover не работает):
    1) mcp__python-lsp__python_definition на символе → получить файл:строку определения;
    2) Read этого диапазона, чтобы увидеть сигнатуру/аннотацию типа.
  Для типа TS-символа hover работает — пользоваться ts_hover напрямую.

- СТОП-ПРАВИЛО: если LSP-серверы не поднялись, недоступны в списке инструментов,
  выдают ошибки или отвечают не так, как описано выше (кроме известного сломанного
  python_hover), — НЕМЕДЛЕННО прервать любую работу над проектом и честно
  предупредить пользователя. Не продолжать через grep/Read как замену, не делать вид,
  что LSP работает, не строить догадки о коде вслепую. Сначала сообщить о проблеме
  и дождаться решения пользователя.

Что читать для контекста
- spec.md   — описание продукта и MVP
- docs/specs/ — нормативные спеки поведения сущностей движка (реестр инвариантов)
- tasks.md  — текущие задачи и бэклог (только живое)
- DEV.md    — локальный запуск: подробности и ручной режим
- docs/tasks-archive.md — журнал закрытых задач (история решений)
- docs/archive/ — рабочие доки закрытых эпиков (аудиты, планы)
- docs/plan-refactoring.md — план рефакторинга (аудит 2026-08-01: метрики, риски, фазы)
- docs/plan-audit-2026-10.md — план исправлений по аудиту 2026-10-13 (уязвимости, 500/зависания,
  зависимости, мёртвый код, дубли, god-компоненты): реестр с местами в коде и фазы 0–8
