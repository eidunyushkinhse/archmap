# ArchMap — QWEN.md

Стек (проверено 2026-08-01 по package.json / requirements.txt / pyproject.toml)
- Frontend: React 19 + Vite 8 + TypeScript 6
- Backend: Python 3.11 + FastAPI 0.111
- БД: PostgreSQL (localhost:5432, БД `archmap`)
- ORM: SQLAlchemy 2.0 + Alembic (миграции)
- Аутентификация: JWT (PyJWT + pwdlib[bcrypt])
- Тесты: vitest (фронт), pytest (бэк)
- Линтеры: eslint + tsc (фронт), ruff (бэк)
- CI: GitHub Actions (.github/workflows/ci.yml) — зеркало pre-commit-гейта
- Деплой: Railway (не настроен)

Структура проекта (проверено 2026-08-01)
archmap/
├── frontend/              # React + Vite
│   ├── src/
│   │   ├── api/           # клиент для бэкенда (auth, nodes, processes, projects, docsImport, projectScope)
│   │   ├── components/
│   │   │   ├── graph/     # движок холста: layout/ (роутер, раскладка, VPSC, ELK), interaction/ (драг, снап, анимации, undo)
│   │   │   ├── inspector/ # правая панель: NodeInspector, EdgeInspector, GhostInspector, DocOverlay
│   │   │   ├── processes/ # бизнес-процессы: sequence-диаграммы, рейл, композитор
│   │   │   ├── project/   # создание/редактирование проектов, импорт YAML, превью
│   │   │   ├── docsImport/# модалка «Доки от агента» (BYOA)
│   │   │   ├── __tests__/ # vitest-тесты (чистые функции раскладки/проекции)
│   │   │   ├── LevelGraph.tsx  # ядро холста (RF-обёртка, конвейер, locate, выделение)
│   │   │   └── ...        # модалки, дерево (NodeTreePanel), алерты, фильтр вида, палитра
│   │   ├── pages/         # ProjectShell (оболочка), ProjectHomePage, NodePage (страница объекта), MapEditorPage (редактор-карта), ProjectsPage (лендинг), LoginPage; TreePage — легаси за фиче-флагом
│   │   ├── types/         # api.gen.ts (генерат из OpenAPI), index.ts (фасад алиасов)
│   │   └── ui/            # общие UI-примитивы: Modal, ProfileMenu, иконки, стили, plural.ts
│   ├── package.json
│   └── vite.config.ts     # прокси /api → localhost:8000, vitest (jsdom)
├── backend/               # FastAPI
│   ├── app/
│   │   ├── models/        # SQLAlchemy: node, edge, project, user, node_doc, view_layout, view_state, business_process, process_*
│   │   ├── routers/       # API: auth, nodes, edges, projects, views, export, processes, node_docs, docs_import
│   │   ├── schemas/       # Pydantic: node, edge, project, auth, process, export, node_doc, docs_import, restore
│   │   ├── main.py        # FastAPI app, CORS, роутеры /api/v1
│   │   ├── config.py      # Settings (database_url, secret_key, cors_origins)
│   │   ├── export.py / import_yaml.py / import_merge.py / import_prompt.py  # экспорт/импорт YAML
│   │   ├── docs_import.py / docs_prompt.py  # BYOA-дозаливка доков
│   │   ├── templates.py   # каталог шаблонов проектов (6 пресетов C4)
│   │   ├── processes.py   # логика бизнес-процессов
│   │   ├── tree.py / projects.py / restore.py / view_state.py
│   │   └── auth.py / database.py / deps.py
│   ├── alembic/           # миграции БД
│   ├── tests/             # pytest (23 тестовых файла)
│   ├── requirements.txt
│   └── pyproject.toml     # ruff config
├── docs/
│   ├── specs/             # нормативные спеки движка (10 файлов + README)
│   ├── archive/           # рабочие доки закрытых эпиков (включая планы)
│   ├── tasks-archive.md   # журнал закрытых задач
│   └── plan-refactoring.md # план рефакторинга по итогам аудита 2026-08-01
├── scripts/
│   ├── git-hooks/pre-commit  # гейт: tsc+eslint+vitest (фронт) / ruff+pytest (бэк)
│   ├── arrow-metrics.mjs / dump-levels.mjs / spawn-probe.mjs / drift-probe.mjs / triple-probe.mjs / fps-probe.mjs  # полигонные зонды
│   └── setup-hooks.sh
├── .github/workflows/ci.yml # CI: зеркало pre-commit-гейта
├── dev.sh / stop.sh       # запуск/остановка всего стека
├── spec.md                # продуктовая спецификация
├── tasks.md               # живые задачи и бэклог
├── .mcp.json              # MCP-серверы LSP (python-lsp, typescript-lsp)
└── CLAUDE.md              # аналогичный файл для Claude Code (держать синхронным с этим!)

Команды
- Поднять весь сервис:   ./dev.sh         (бэк+фронт+миграции одной командой)
- Остановить:            ./stop.sh        (или Ctrl+C в терминале с dev.sh)
- Запуск фронта:         cd frontend && npm run dev
- Запуск бэкенда:        cd backend && ./venv/bin/uvicorn app.main:app --reload
- Миграции (создать):    cd backend && ./venv/bin/alembic revision --autogenerate -m "название"
- Миграции (применить):  cd backend && ./venv/bin/alembic upgrade head
- Тесты бэкенда:         cd backend && ./venv/bin/python -m pytest -q
- Тесты фронта:          cd frontend && npx vitest run
- Типизация фронта:      cd frontend && npx tsc -b
- Линтер фронта:         cd frontend && npx eslint .
- Линтер бэкенда:        cd backend && ./venv/bin/ruff check .
- Генерация типов из OpenAPI: cd frontend && npm run gen:api
    (дамп app.openapi() бэкендовым venv-python | openapi-typescript → src/types/api.gen.ts).
    Файл коммитится, идемпотентен.

Запуск сервиса (ВАЖНО)
- Поднимать сервис ТОЛЬКО через ./dev.sh — НЕ запускать uvicorn/vite вслепую
  вручную. Скрипт сам проверяет Postgres, создаёт БД, накатывает миграции,
  ставит зависимости и поднимает оба процесса согласованно. Подробности и
  ручной режим — в DEV.md.
- Запускать как фоновую задачу (is_background: true) — так процесс
  переживает teardown сессии.
- Останавливать через ./stop.sh. Если порт занят — сначала ./stop.sh, потом
  ./dev.sh; либо другие порты: BACKEND_PORT=8001 FRONTEND_PORT=5174 ./dev.sh.

Git
- Проект под git с 2026-06-07, ветка main. Remote: github.com/eidunyushkinhse/archmap
  (приватный, создан 2026-07-21). Пушить можно (пользователь дал разрешение).
- Коммитить ПРЯМО в main (solo-проект, фича-ветки не заводить).
- Перед коммитом убедиться, что приложение запускается / тесты проходят;
  заведомо сломанное состояние не коммитить. Pre-commit хук (scripts/git-hooks/)
  автоматически гоняет tsc+eslint+vitest (фронт) и ruff+pytest (бэк) по
  staged-файлам.
- Коммиты маленькие, по одной логической правке. Сообщения на русском,
  формат: "feat: …" / "fix: …" / "chore: …" / "docs: …".
- После коммита называть в ответе хэш и сообщение.
- Откат делать через git (reset/revert/checkout/stash), не правкой вслепую.
- Не коммитить: node_modules, venv, dist, .claude/mcp-servers/{venv,
  node_modules}, **/settings.local.json, реальные .env — уже в .gitignore.

Ключевые сущности (проверено 2026-07-21 по моделям SQLAlchemy)

Project (проект — изолированная схема)
- id UUID, name, description, archived_at (null = активен)
- created_at, updated_at, created_by_id, updated_by_id → User
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
- version     — CAS-версия для optimistic concurrency
- docs        — коллекция NodeDoc (именованные схемы логики, lazy="selectin")
- created_at, updated_at
- has_children — вычисляемое поле в API

NodeDoc (схема логики узла)
- id, node_id → Node, name (уникально в пределах узла)
- kind — обзор | операция | воркер
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

ViewLayout / ViewState
- view_layout: project_id, view_id, item_id, payload JSONB {x, y, expanded}
- view_state: version (fence для CAS батчей layout)

BusinessProcess / ProcessParticipant / ProcessMessage / ProcessFragment
- Бизнес-процессы — sequence-конструктор поверх C4

Архитектурные правила
- API всегда версионируется: /api/v1/...
- Все эндпоинты возвращают JSON
- Ошибки возвращаются в формате {"detail": "..."}
- Фронт общается с бэком только через /api/v1/ (прокси Vite)
- Никаких бизнес-логики на фронте — только отображение и запросы
- Миграции БД только через Alembic, не трогать схему руками

Правила разработки
- Комментарии в коде писать на русском
- После каждого изменения убедиться, что приложение запускается
- Косметические фронтенд-правки не проверять визуально. Триггер (оба условия):
  (1) правка только во фронтенде; (2) пользователь ЯВНО назвал её косметической.
  Тогда НЕЛЬЗЯ: запускать headless-браузер, делать скриншоты, гонять визуальную
  проверку. МОЖНО: ts_diagnostics на изменённых файлах.
- Не менять существующие API-контракты без явного запроса
- TypeScript: не использовать any, типизировать всё явно
- Типы контракта на фронте ГЕНЕРИРУЮТСЯ из OpenAPI, не пишутся руками.
  src/types/api.gen.ts — артефакт openapi-typescript; src/types/index.ts —
  фасад алиасов. ПРАВИЛО: изменил Pydantic-схемы (backend/app/schemas/*) →
  сразу `cd frontend && npm run gen:api`, проверь `tsc -b` и закоммить
  обновлённый api.gen.ts вместе с правкой схем.
- Документация всегда актуальна (кроме чисто косметических изменений):
  при появлении новой фичи — сразу обновить spec.md;
  при её реализации — отметить в tasks.md.
- QWEN.md и CLAUDE.md — аналоги для разных ИИ-агентов: менять ОБА одновременно.

Архитектурные привычки (фронтенд)
- Дефолты, реагирующие на видимый «смелл», а НЕ чек-лист.
- Один модуль — одна ответственность. Смелл: файл > ~400 строк, либо в нём
  одновременно рендер + вычисления + сайд-эффекты. Реакция: вынести по границе
  ответственности сразу. LevelGraph разобран (1678→1055, пропсы 43→19, 7 хуков
  useLevel* в graph/interaction/) — эталон декомпозиции.
- God-компонент разбирать ТОЛЬКО после поведенческих тестов (characterization-
  тесты на оркестрацию как страховка). Порядок выноса: сначала изолированные хуки
  (только читают: locate/selection), потом центральные узлы (persistence/commitLayout),
  потом зависимые (drill); один хук — один коммит, новые хуки в тестах НЕ мокаются.
  Пропсы — в доменные бандлы с useMemo (без ре-рендеров канваса); общие типы — в
  graph/types.ts (без type-only циклов). Атомарные ядра с инвариантом порядка
  эффектов (конвейер раскладки) НЕ выносить. Playbook: docs/refactoring-lessons.md.
- Производное состояние — в рендере (useMemo), не в useEffect. Смелл: эффект,
  заканчивающийся setState.
- Строгость типов/линтеров в гейте (TS strict + eslint strict + mypy на бэке) дёшева
  при дисциплине «без any»: код был strict-чист ДО включения флага (0 ошибок).
- Сломанные контракты ловит гейт «зелёный билд/тесты перед коммитом» (pre-commit
  гоняет ВСЕ тесты + CI-зеркало; --no-verify не используется).
- Коммитить и пушить по фазам: фоновые сессии могут встать при обрыве сети —
  запушенный в origin прогресс не теряется.

Спецификации движка (docs/specs)
- docs/specs/ — нормативный реестр поведения движка/холста, 10 спек: edge,
  node, container, guest, canvas, history, view, alerts, context, transitions;
  формат инвариантов, правило старшинства и карта «модуль → спека» —
  docs/specs/README.md.
- ПРАВИЛО: правишь движок/холст (модули из карты README: graph/**,
  LevelGraph/TreePage, бэк-эндпоинты графа/вида/алертов/контекста) → пройди
  регрессионный чек по затронутым спекам и прогони указанные тесты;
  осознанно меняешь поведение → обнови спеку В ТОМ ЖЕ коммите.
- При расхождении спеки с кодом сначала выясни, что из двух — баг.

LSP-навигация
- В проекте НЕТ встроенного LSP. Единственный доступный LSP — два MCP-сервера
  из .mcp.json:
    Бэкенд (Python):  mcp__python-lsp__python_definition / python_references /
                      python_diagnostics / python_hover
    Фронтенд (TS):    mcp__typescript-lsp__ts_definition / ts_references /
                      ts_diagnostics / ts_hover
- Для определений, ссылок и диагностики использовать эти MCP-инструменты,
  а не grep/Read. Read — только когда нужен контекст вокруг кода.
- Статус инструментов (проверено 2026-05-30):
    TypeScript: работают все 4 функции. Курсор ставить точно на идентификатор.
    Python:     работают definition, references, diagnostics.
                python_hover СЛОМАН — всегда отвечает «Информация недоступна».
- Воркэраунд для типа Python-символа: python_definition → Read диапазона.
- СТОП-ПРАВИЛО: если LSP-серверы не поднялись или выдают ошибки —
  НЕМЕДЛЕННО прервать работу и предупредить пользователя.

Что читать для контекста
- spec.md          — описание продукта и MVP
- docs/specs/      — нормативные спеки поведения сущностей движка
- tasks.md         — текущие задачи и бэклог (только живое)
- docs/tasks-archive.md — журнал закрытых задач (история решений)
- docs/archive/    — рабочие доки закрытых эпиков
- docs/plan-refactoring.md — план рефакторинга (аудит 2026-08-01: метрики, риски, фазы)
- DEV.md           — инструкция локального запуска
