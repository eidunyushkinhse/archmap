# План исправлений по итогам аудита 2026-10-13

Аудит репозитория на мёртвый и неоптимальный код, уязвимости и анти-паттерны.
Предыдущий аудит и рефакторинг (2026-08-01) — `docs/plan-refactoring.md`; закрытое
там не повторяется. Этот документ — реестр находок с доказательствами и поэтапный
план их закрытия. Статусы фаз обновлять здесь же, по мере выполнения.

## Статус выполнения

| Фаза | Статус | Содержание |
|---|---|---|
| 0. Дыры и надёжность | **сделана** 2026-10-13…14: п.1 97250ef3; п.2 f3878a2b; п.3 dd17e28b 6c305c3d; п.4 bcbdb89f db859655; п.5 834b3ada 881439c9 874bb9d6 3a4f8f0f 3c892363; п.6 17055a01; п.7 b9a7604b; п.8 — коммит «общий предел распаковки». Отступления от плана — в тексте пунктов 3 и 7 | изоляция restore, циклы, регулярка, bcrypt, длины полей, индексы, установщик, заголовки, MCP-пути |
| 1. Зависимости | в работе, ветка `chore/deps-2026-10`: шаг 1 (независимые бампы, P-5, P-26) 73376ff5 | бэкенд 2024 → 2026 (две ступени), фронт `npm audit fix`, lock с хэшами, Dependabot |
| 2. Устойчивость фронтенда | в работе, ветка `refactor/frontend-robustness`: R-1 2201881a | ErrorBoundary, ошибки загрузки, 401 вне демо, выкат без F5, хранилище, откаты, буфер обмена |
| 3. Гейты и CI | не начата | permissions/пины/сборка/дрейф api.gen/аудит/coverage; ruff/mypy строже; зонды полигона |
| 4. Мёртвый код, дубли, документация | не начата | knip/vulture, хелперы-дубли, устаревшие ссылки, CLAUDE.md/QWEN.md/README MCP |
| 5. Структура бэкенда | не начата | семейство фактов на общей базе, domain_types, домен из роутеров, распил import_merge/unified_import |
| 6. Производительность | не начата | кэш индекса проекта, N+1 импортов, выборки, бандл фронта |
| 7. Структура фронтенда | не начата | god-компоненты (после страховочных тестов), дубли секций и модалок |
| 8. Уроки | не начата | правила в «Архитектурных привычках» CLAUDE.md/QWEN.md, сторожевые тесты |

## 1. Метод

- Автоматика: `pip-audit` (requirements-prod/dev, mcp), `bandit`, `vulture` (порог 60 %),
  `npm audit`, `knip`, `depcheck`, `npm outdated`, `pip index versions`; продакшн-билд
  фронта в scratchpad для состава чанков; дамп `Base.metadata` для индексов; `alembic heads`.
- Пять параллельных разведок с проверкой каждого утверждения по коду: безопасность
  бэкенда (все 21 роутер, карта «мутация → зависимость доступа»), качество бэкенда
  (AST по 792 функциям, difflib-сходство тел), структура фронтенда, рантайм фронтенда
  (гонки, ошибки, бандл), периферия (MCP, скрипты, поставка, CI, документация).
- Три находки доказаны исполнением: межпроектная запись через `POST /nodes/restore`
  (ответ 204 и строки в чужом проекте), зависание на циклическом снимке, квадратичная
  регулярка (4 КБ → 0,16 с, 32 КБ → 11 с). Остальное — чтением кода; где 500 проявился
  бы только на Postgres (длины колонок), помечено «вероятно».
- Ведущий перепроверил своими руками все находки уровня «критично/высоко» и выборочно
  средние (bcrypt, uvicorn/X-Forwarded-For, install.sh, README MCP, ErrorBoundary,
  NodePage, mermaidLoader, pipelineClient, мёртвые константы, `install()` при импорте).
- Идентификаторы: S — безопасность бэкенда, Q — качество бэкенда, F — структура
  фронтенда, R — рантайм фронтенда, P — периферия, M — проверки ведущего. Полный реестр
  с местами в коде, сценариями и правками — раздел 5; фазы ниже ссылаются на него.

## 2. Оценки по направлениям

| Направление | Оценка | Коротко |
|---|---|---|
| Авторизация и изоляция проектов | **B** | Карта доступа всех мутаций чистая, IDOR закрыт везде, кроме одного пути: `POST /nodes/restore` вставляет дочерние строки снимка с FK из тела без проверки проекта (S1, критично). Пределы демо проверяются центрально и обходу не поддаются. |
| Надёжность бэкенда (500 и зависания) | **C+** | Пароль > 72 байт → 500 (M1); схемы без `max_length` → 500 на Postgres (S4, S5, S8, M2); циклический снимок вешает воркер (S2); квадратичная регулярка на mermaid (S3); пул без `pool_pre_ping` (S6); 16 архивов × 64 МБ в памяти (S7). |
| Зависимости | **D** | Поставка бэкенда — срез весны 2024: starlette 0.37, python-multipart 0.0.9, PyJWT 2.13 с открытыми CVE (M7); фронт — 15 предупреждений, из прямых только js-yaml в рантайме (M8); Dependabot нет (M9). |
| Устойчивость фронтенда | **C** | Ни одного ErrorBoundary (R-1), ошибки загрузки глотаются (R-2, R-9, R-10), истёкший токен вне демо не ведёт на вход (R-15), после выката схемы «ломаются» до F5 (R-7), localStorage без защиты на уровне модуля (R-8), откаты оптимистичных правок неполные (R-11…R-14). |
| Безопасность фронтенда | **B+** | Mermaid strict + DOMPurify, нет CDN и сторонних скриптов, URL-параметры ограничены, токен только в заголовке. Открыто: внешние `$ref` в swagger-ui (R-3), отсутствие CSP/заголовков (R-4), js-yaml 5.2.1 на чужом тексте (R-5). |
| Мёртвый код | **B** | Мало: один мёртвый компонент, ~48 лишних экспортов/типов, три мёртвые константы, одна неиспользуемая зависимость доступа, устаревшие ссылки на переехавшие планы (M16, Q-27…Q-32, P-40). |
| Дублирование и структура бэкенда | **C+** | Семейство дозаливки фактов — четыре копии одного каркаса (Q-2, Q-3), три способа считать путь узла и цикл импортов (Q-4), 22 `type: ignore` от `Mapped[str]` вместо Literal (Q-5), `compute_alerts` 488 строк (Q-7), роутеры наросли обратно после фазы 4 прошлого плана (Q-9…Q-11). |
| Производительность | **B−** | 14 внешних ключей без индекса (Q-1), полный разбор всех схем логики на каждое чтение алертов/usage/поиска (Q-6), N+1 в применении импортов (Q-12), главный чанк 1,2 МБ без `React.lazy` (R-18…R-20). |
| Дублирование и структура фронтенда | **C** | Хост персиста схемы написан трижды при готовом хуке `useLevelSchema`, семь окон агента и три секции фактов — клоны (F-9, F-10, F-13); LevelGraph вырос обратно с 1055 до 1634 строк (F-1); MapEditorPage держит 11 `eslint-disable` как симптом нестабильного `load` (F-6); пять механик тостов (F-17). React-гигиена в целом хорошая (нет вложенных компонентов, `nodeTypes` стабильны, `JSON.parse` в try), но async без alive ×8 и объекты-литералы в пропсах ReactFlow (F-49, F-57). |
| Поставка, CI, инструменты | **B−** | Установщик переключает релиз до проверки и без отката (P-1), пустой VERSION сносит релизы (P-2), копии БД перед миграцией нет (P-3); CI без `permissions`/пинов/сборки/дрейфа `api.gen.ts`/аудита (P-18…P-20); порог покрытия никем не проверяется (M12); ruff/mypy в минимальных режимах (M13). |
| Документация для агентов | **C** | CLAUDE.md и QWEN.md расходятся на 173 строки и оба — с кодом (P-7); README MCP учит класть пароль в трекаемый файл (P-4) и описывает несуществующий аргумент (P-12). |

Интеграл: ядро продукта (движок, доступ, импорт) по-прежнему крепкое; долг сосредоточен
в периферии надёжности (входные данные → 500/зависание), в зависимостях и в том, что
фронтенд молчит об ошибках.

## 3. Риски

### 3.1. Если не чинить
- S1 — любой редактор общего проекта пишет в чужой проект (нужен UUID чужого узла;
  он утекает из URL, экспорта, ссылок в процессах). На публичном демо каждый гость —
  редактор своей песочницы, UUID демо-проекта у всех разные, но путь открыт.
- S2/S3 — один запрос вешает воркер; на двух воркерах демо-стенда это отказ сервиса.
- M7 — поставка с известными CVE в парсере multipart, которым мы принимаем файлы.
- R-1/R-2/R-15 — пользователь видит белый экран или вечную «Загрузку…» и не знает, что
  делать; это портит и демо, и закрытый контур.
- P-1/P-3 — обновление стенда без отката и без копии базы: одна неудача — простой.

### 3.2. Риски самих правок
- Обновление FastAPI 0.111 → 0.143 тянет Starlette 1.x и Pydantic 2.14: меняются лимиты
  разбора форм (`max_part_size`, `max_files`), генерация OpenAPI (перегенерировать
  `api.gen.ts`), сигнатуры middleware. Делать отдельной веткой, под полным гейтом и ручной
  проверкой импорта файлов и экспорта архива; план отката — ветка.
- Распил семейства фактов (Q-2…Q-4) и домена роутеров (Q-9…Q-11) — под существующими
  1386 тестами бэка, риск низкий, но делать по одному модулю в коммит.
- Структура фронтенда (фаза 7) — тот же урок, что в 2026-08: god-компоненты разбирать
  только после страховочных тестов; LevelGraph уже вырос с 1055 до 1634 строк.
- Строгие линтеры (фаза 3) — включать с ratchet, не красить гейт лавиной.
- Заголовки CSP — сначала Report-Only: mermaid и swagger ставят inline-стили.

## 4. Поэтапный план

Порядок — по риску и отдаче: сначала дыры и всё, что даёт 500/зависание, потом
зависимости, потом видимые пользователю ошибки, потом гейты, потом долг структуры.
Каждый пункт — отдельный коммит под зелёным гейтом; фазы 0–4 можно вести вперемешку
с продуктовой работой, фазы 5–7 — отдельными ветками.

### Фаза 0 — Дыры и надёжность (сразу, 2–3 захода)
1. **Изоляция restore (S1, S2, S9).** В `restore.restore_from_snapshot` для каждой
   дочерней строки (доки, таблицы, колонки, каналы, поля, параметры, рёбра, раскладка)
   проверять, что родитель либо в снимке, либо `scoped_node`/`scoped_edge` текущего
   проекта; снимок с циклом `parent_id` → 422; дубли имён → 409. `tree.ancestors`,
   `tree.node_depth`, `restore.depth`, `routers/projects.root_of` — обход с `seen`.
   Тест: снимок с чужим `node_id` → 422 и ноль строк в чужом проекте; снимок a↔b → 422.
2. **Регулярка mmd_header (S3).** `_UNPAIRED` → `[\w-]{1,64}` (или линейный разбор по
   строкам), лимит длины mermaid до разбора; тест на время для входа `"a-"*20000`.
3. **Пароль и длины (M1, M2, S4, S5, S8).** `password_problem`: не длиннее 72 байт в
   UTF-8; `verify_password` ловит `ValueError` → False. `Field(max_length=…)` по длинам
   колонок в `UserCreate` (username 64, role — `UserRole`), `NodeCreate/NodeUpdate`
   (name 256, role/technology 128), `NodeSource` (под `source_ref` 512), `EdgeCreate/Update`
   (label 256), `ProcessCreate` (256), `ViewLayoutBatch` (item_id 128). Сторожевой тест:
   для каждой колонки `String(n)` у моделей найти поля схем с тем же именем и проверить
   `max_length ≤ n` (ловит класс ошибок навсегда, см. фазу 8).
   **Сделано иначе (2026-10-13).** Длины проверяет не схема, а слушатель `before_flush`
   (`app/column_limits.py`): каждая колонка `String(n)` у новых и изменённых строк, отказ —
   422 `{"detail": "Поле «name» длиннее 256 символов"}`. Причины: (1) в те же колонки пишут
   импорт, restore, синк и доки от агента мимо схем запросов — разведка нашла ≈50 полей без
   предела, не 6; (2) отказ pydantic — 422 со списком, фронт показал бы «[object Object]».
   Сторож — тест «проверка видит каждую `String(n)` каждой модели»; на SQLite проверка
   исполняется так же, как на Postgres. `role` в `UserCreate` оставлен строкой: роутер уже
   отвечает 400 «Недопустимая роль», `Literal` сменил бы контракт на 422 со списком.
4. **Пул и индексы (S6, Q-1/M10, M5, P-16).** `create_engine(pool_pre_ping=True,
   pool_recycle=1800)`; `index=True` на 14 FK + одна миграция; `AddressLimiter` удаляет
   пустые ключи; `/ready` с `SELECT 1` для readiness и установщика.
5. **Установщик и nginx (P-1, P-2, P-3, M3/P-13/R-4, P-14, M4/P-17).** `trap rollback ERR`
   до проверки `/health`; валидация `VERSION`; `pg_dump -Fc` перед `alembic upgrade`
   (или явный `--no-backup`); сниппет security-заголовков (nosniff, Referrer-Policy,
   Permissions-Policy, CSP `frame-ancestors 'none'; base-uri 'self'; object-src 'none'`,
   HSTS в TLS-ветке, полная CSP как Report-Only), `server_tokens off`, `ssl_session_*`,
   `limit_req` для `/api/v1/demo/start` и `/api/v1/auth/register`; те же заголовки в
   `standalone.py`; hardening `archmap.service`; один helper адреса клиента (последний
   X-Forwarded-For) для `routers/demo.py` и `standalone.py`, оговорка в DEPLOY.md для k8s.
   Готовые фрагменты конфигов — приложения А–В отчёта разведки периферии (в scratchpad
   сессии; перенести в DEPLOY.md при выполнении).
6. **MCP (P-4, P-8, P-9, P-10, P-11).** README: учётка только в `mcp/.env`; парсер `.env`
   с BOM/`export`; второй `except` с понятным текстом; `out_path` — только `.zip`, отказ
   на симлинк, запись через временный файл и `os.replace`, `ARCHMAP_EXPORT_DIR`;
   `st_size ≤ 64 МБ` до чтения, манифест ≤ 1 МБ.
7. **Swagger и YAML (R-3, R-5).** `requestInterceptor`, отклоняющий внешние URL в
   `$ref`; js-yaml → 5.4.3; разбор сохранённой спеки — в эффекте (R-22).
   **Сделано (2026-10-13):** внешние `$ref` вырезаются из спеки до swagger-ui
   (`components/openapiRefs.ts`), `requestInterceptor` отклоняет любой запрос, `validatorUrl:
   null`; js-yaml 5.4.3. R-22 не делался: перенос разбора в эффект лишь откладывает ту же
   синхронную работу на кадр, причину DoS снимает версия js-yaml.
8. **Общий кап распаковки (S7).** Суммарный распакованный объём всех входов единого
   импорта на запрос ≤ 64 МБ (поверх пер-архивного).
   **Сделано (2026-10-14):** `archive_import.check_unpacked_total` по центральным каталогам
   до чтения файлов — и в ввозе в новый проект, и в догрузке; самоархив живого проекта,
   который догрузка собирает сама, в предел не считается.

### Фаза 1 — Зависимости (ветка `chore/deps-2026-10`, после фазы 0)
1. **Независимые бампы бэка (M7, часть).** python-multipart 0.0.32, PyJWT 2.15.1,
   python-dotenv 1.2.2, pwdlib 0.3.1, psycopg2-binary 2.9.13, alembic 1.20, PyYAML 6.0.3
   в mcp; mcp 1.28.1 + `mcp/requirements-dev.txt` с пинами (P-5), снять три ненужных
   `type: ignore` в `server.py` (P-26). Гейт: pytest бэка и MCP.
2. **FastAPI 0.143 + Starlette 1.x + Pydantic 2.14 + pydantic-settings 2.15 + uvicorn 0.54
   + SQLAlchemy последний 2.0.x (M7).** Проверить лимиты форм (`max_part_size`,
   `max_files`, `max_fields`) против импорта архивов до 64 МБ, `lifespan`, `TestClient`,
   `--proxy-headers`; `npm run gen:api` и `tsc -b`; ручная проверка: импорт zip, экспорт
   архива, вход, демо-старт. SQLAlchemy 2.1 — отдельное решение позже.
3. **Фронт (M8).** `npm audit fix` (транзитивные), vite 8.3, vitest 4.1.11, @xyflow/react
   12.12, react 19.3, @types/*; mermaid/katex — ждать релиза mermaid; TypeScript 7 —
   отдельной задачей; убрать `@types/js-yaml` (M16).
4. **Воспроизводимость и слежение (P-22, M9/P-43, P-32).** `pip-compile --generate-hashes`
   → `requirements-prod.lock`, установка `--require-hashes`; `dependabot.yml`
   (github-actions, pip ×2, npm, weekly, grouped); `.nvmrc` = 22, `engines` в package.json.

### Фаза 2 — Устойчивость фронтенда (параллельно фазе 1)
1. **Границы и сессия (R-1, R-15, R-7).** ErrorBoundary вокруг маршрутов с карточкой
   «обновить / к проектам» и `onUncaughtError`; `onUnauthorized` во всех режимах с плашкой
   «Сессия истекла»; сброс кэша `loadMermaid` на отказе и обработчик `vite:preloadError`
   («вышла новая версия — обновите страницу»).
2. **Загрузки (R-2, R-9, R-10, R-23).** Общий хук `useAsyncLoad` (номер прогона +
   состояние `error` + отмена) для NodePage, MapEditorPage, useLevelSchema, SchemaPreview;
   экраны ошибки с «Повторить»/«К проекту». Он же снимает кластер
   `eslint-disable react-hooks/set-state-in-effect` на загрузках.
3. **Хранилище и токен (R-8, R-25).** `safeStorage` с in-memory фолбэком в семи местах;
   base64url в `tokenClaims`.
4. **Откаты и обратная связь (R-11, R-12, R-13, R-14, R-6).** Тост на отказ записи
   раскладки; откат `is_external`/`status`/инверсии связи из `beforeRef`; `try/catch` у
   переноса в дереве; один `copyText()` с фолбэками для всех кнопок «Скопировать промпт».
5. **Пределы и фон (R-16, R-17, R-24, R-27).** Порог mermaid с «Показать всё равно»;
   сторож воркера конвейера; экспоненциальный откат поллинга и признак «нет связи»;
   плейсхолдер в `ProjectAccessGate`.

### Фаза 3 — Гейты и CI (дёшево, в любой момент)
1. **CI (P-18, P-19, P-20, P-5, M14).** `permissions: contents: read`, `concurrency`,
   `timeout-minutes`, actions по SHA, `npm run build` и `build:embed`, проверка дрейфа
   `api.gen.ts` против `app.openapi()`, `npm audit --omit=dev --audit-level=high`,
   `pip-audit -r requirements-prod.txt` (сначала предупреждением), job для скриптов
   (`bash -n`, shellcheck); pre-commit видит `deploy/*.sh`, `scripts/*.sh`, `deploy/*.py` (P-33).
2. **Покрытие (M12).** `vitest run --coverage` в CI (пороги уже в vite.config);
   `pytest-cov` с базовым порогом и ratchet.
3. **Строгость (M13, P-30).** ruff: `S`, `PERF`, `SIM`, `RUF`, `PIE`, `RET`, `C90`
   (`max-complexity` ~15) с `per-file-ignores`-ratchet; mypy `warn_unused_ignores`,
   `disallow_untyped_defs` по пакетам; `target-version py312`; оценить
   `noUncheckedIndexedAccess` (кластеры `no-non-null-assertion` в channelNudge,
   coincidentLegs, edgeJumps).
4. **Инструменты (P-6, P-23, P-21, P-25, P-42).** Зонды полигона — токен по учётке без
   роли в claim, `ARCHMAP_PROBE_USER`, второй пользователь-reader через API; оговорка в
   `docs/specs/README.md`; npm-скрипты для `replay-prof`/`route-quality` с `vite-node`/`tsx`
   в devDependencies; `stop.sh` по пути бинаря; `umask 077` в `dev.sh`.

### Фаза 4 — Мёртвый код, дубли, документация (мелкими коммитами)
1. **Фронт по knip (M16).** Удалить `LegLegend.tsx`; снять `export` у 24 экспортов и 24
   типов, используемых только в своём файле (список в реестре Б.5); `@types/js-yaml`.
2. **Бэк по vulture и разведке (Q-27…Q-34, Q-39).** Удалить `MAX_MERMAID_LEN`,
   `MAX_SPEC_LEN`, решить `MAX_LOGIC_PER_NODE`; `require_project_owner` — удалить или
   перевести на неё семь owner-ручек; параметры без вызывающих; relationship'ы без обхода
   — задокументировать или снять; `demo_limits.install()` из `lifespan`; локальные
   импорты наверх; узкий `except` в `dry_run_excess`; устаревшие комментарии (`tree.py`,
   `docs_import.py`, ссылки на планы в `docs/archive/` — P-40).
3. **Хелперы-дубли бэка (Q-21, Q-23, Q-24, Q-25, Q-36, Q-37, Q-43, Q-44).** `app/text.py`,
   `deps.commit_change`, `ViewLayoutItem.parsed`, dataclass'ы вместо кортежей,
   `app/errors.py`, `StrEnum` ролей, `_graph_for`, `demo_limits.preview_excess`.
4. **Дубли фронта с готовыми общими кусками (F-11, F-17, F-19…F-23, F-25, F-27…F-29, F-33, F-34, F-62, F-67).**
   `mergeViewLayout` (+ тест), `ui/useToast<T>` и `useCopiedFlag`, `ui/useDismiss`, `Modal title/subtitle` +
   `DialogFooter` + `ConfirmDialog tone`, `ui/useBusyAction`, словари `SHAPE_LABEL`/`STATUS_ORDER`/`KIND_LABEL`
   в одном месте, `lib/emitter.ts`, `graph/layout/rect.ts` + `lib/hash.ts` + `lib/motion.ts`, `ui/pageChrome.ts`,
   `useLocalPref`, иконки только из `ui/icons`, `api/auth.ts` через общий клиент, `factApi`/`importFamilyApi`,
   `mustGet` вместо 21 `!`-disable, `resetSession(notice)`. Параллельно — третий курсор в `createRemoteSyncTick`
   вместо копии поллинга в ProcessWorkspace (F-24) и единый предел размера файла для drop и «Загрузить файлы…» (F-31).
5. **Документация (P-7, P-12, P-15, P-27, P-28, P-37, P-38, P-39, P-41, P-31, M6, M17).**
   Переписать «Структура проекта» в CLAUDE.md по факту и синхронизировать QWEN.md;
   README MCP (убрать `target`, «три семьи», абзац про CA, описания аргументов);
   `--no-systemd` в `--help`/DEPLOY.md; поля `Settings` в `.env.example`; журналы и
   ротация в DEPLOY.md; `mock-import.yaml` → `scripts/fixtures/`; относительные пути в
   `.mcp.json`; зафиксировать в spec.md осознанные решения по токену/ролям.

### Фаза 5 — Структура бэкенда (ветками, под 1386 тестами)
1. **Путь узла (Q-4).** Публичный `NodeIndex` в `node_ref.py`; `routers/nodes` через
   `node_addresses`; цикл `docs_import ↔ data_refs` исчезает.
2. **Семейство фактов (Q-2, Q-3, Q-8, Q-15).** `app/facts_import.py` (resolve_owner,
   as_*, nodes_hint, warn_*, MergedEntry, merge_by_key, live_by_key); фабрика роутера или
   `run_preview/run_apply`; `data_refs.usage_index`; общие `node_or_404`, `owned_or_404`,
   `name_taken`, `check_cas`, `apply_patch`. Ожидание: −700…900 строк.
3. **Типы (Q-5).** `app/domain_types.py`; `Mapped[NodeShape]` и т.д. через
   `type_annotation_map` (без миграции); dataclass'ы на алиасах; `type: ignore` → 0.
4. **Домен из роутеров (Q-7, Q-9, Q-10, Q-11, Q-16, Q-38).** `AlertContext` + функция на
   класс алерта; `processes.validate_message/check_fragment/channels_between`;
   `identity.parse_source_patch`, `graph_queries.external_edges`,
   `view_state.reset_view_layout`; `projects.project_cards`, `sync_plan.plan_for`;
   `apply_sync_plan` через `setattr`.
5. **Распил крупных модулей (Q-18, Q-19, Q-17, Q-42).** `merge_warnings.py`,
   `unified_remarks.py`, `unified_preview.py`, `docs_pkg.py`, `name_match.py` (Q-22);
   функции > 150 строк по секционным комментариям; `schemas/alerts|view|transition.py`.
6. **Тесты (Q-47, Q-48).** `tests/factories.py`; `test_node_ref.py`; прямые тесты
   `apply_sync_plan`; при распиле модулей делить и тесты (Q-49).

### Фаза 6 — Производительность
1. **Индекс проекта (Q-6, Q-20, Q-14).** `app/project_index.py` — LRU по
   `(project_id, graph_rev, meta_rev, process_rev)`: каталог фактов, разрешённые пометки
   по докам, единицы поиска, превью списка проектов, self-архив для import-into.
2. **Запросы (Q-12, Q-13, Q-26, Q-40, Q-45, Q-46).** `live` в элементах плана и один
   flush; `ProjectChannels`-контекст; `in_`-фильтры вместо загрузки таблиц; предки
   поверх `load_nodes`; раскладка перехода без wildcard-LIKE; одноразовая чистка
   легаси-строк пучков.
3. **Бандл (R-18, R-19, R-20).** `import("./pipeline")` в фолбэке; `React.lazy` для
   DemoTour, ProcessWorkspace, UsersPage, docsImport/*, CreateProjectDialog/ImportIntoModal;
   js-yaml лениво. Ожидание: −150…250 КБ raw из входного чанка. ELK дважды (R-21) —
   зафиксировать как принятое.

### Фаза 7 — Структура фронтенда (после страховочных тестов; реестр Б.7)
Порядок — по отдаче на единицу риска; характеризационные тесты уже есть у LevelGraph
(levelGraph.*), ProcessCanvas (6), секций фактов (3), окон агентов (кроме ConfigAgentModal).
1. **Хосты схемы (F-10, F-12, F-26, F-6).** `useLevelSchema({ load })` с инъекцией
   загрузчика + `usePersistenceHost` (ресинк, 409-переигровка, retryPatch) → SchemaSection,
   MapEditorPage, ProjectHomePage худеют на ≈40 строк каждый; `useEffectEvent`/latest-ref
   для `load`/`navigateToLevel`/`dispatch*` — 15 `eslint-disable` уходят, `useMemo`-бандлы
   LevelGraph становятся честно стабильными; `ancestorPath` (лучше — `GET /nodes/{id}/ancestors`
   на бэке, он же снимет ручную сборку GhostNode); `useEdgeChoice` сам строит resolve/label.
2. **LevelGraph (F-1, F-57).** Шесть безопасных хуков по одному коммиту: `useLevelAutoFit`,
   `useOncePerViewToast` + `CanvasNotice`, `useLevelRehang`, `useLevelDragLifecycle`,
   `useLevelHistory`, `useFarZoom`, `CanvasToolbars`; `useRouteMemory` — отдельно и с тестом
   порядка эффектов (его эффект сброса обязан идти раньше эффекта раскладки); модульные
   константы для пропсов `<ReactFlow>`. Цель ≈1150–1200 строк без касания конвейера.
3. **Семейства-клоны (F-9, F-13, F-14, F-15, F-16).** Окна агента: сначала тест
   ConfigAgentModal, затем `useAgentPackageFlow<TReport>` + `AgentModalShell` +
   `FactAgentModal` с тремя конфигами (−650…750 строк); секции фактов: `useFactRows<T>`,
   `FactSection`, `GroupedList`, `UsageList`, один `factRows.css`; NodeInspector на
   `useNodePatch`, `EdgeFields`/`useEdgeCreate`; `useRemainderAnswers` + `ImportDoc` с id.
4. **Процессы (F-18 → F-3 → F-2 → F-4, F-36, F-39, F-63, F-65).** `runMutation` с единым
   catch; `useOverlayStack` вместо 12 useState и ручного Escape-стека; `useProcessDetail` +
   три хука мутаций + `ProcessToolbar`; `computeSeqGeometry` под useMemo с юнит-тестами и
   слои SequenceDiagram; сброс `error`; `ConfirmDialog variant="card"` вместо ручных подтверждений.
5. **Дерево и тур (F-7, F-8, F-38, F-52).** Пять хуков NodeTreePanel и явный `mode`;
   `tourStore` как внешний стор + чистая `computeFrame`; `tourPersist.ts`, `TourCard.tsx`;
   общий `useNodeSearch` с guard по номеру запроса.
6. **NodePage и алерты (F-5, F-35, F-37).** `NodePropertiesCard` + `Dropdown`,
   `DescendantGroups<T>`, `LogicSection`, `OpenApiSection`, `DocRow` (7 копий строки);
   data-driven `ALERT_SECTIONS[]` (≈150 строк вместо 468); `useDescendants` + селекторы.
7. **Типы (F-59, F-60, F-61, F-62).** `graph/layout/diag.ts` с `declare global`; алиасы
   `*In` в `types/index.ts` и API на snake_case напрямую; общие `LayoutPatch`/`NavigateMap`/
   `ViewMetaRef`/`StepDoc`; решение по `noUncheckedIndexedAccess` (78 гвардов + 21 disable).
8. **React-мелочи по ходу (F-49…F-56, F-58, F-70, F-71).** `useAsyncResource` везде, где
   async без alive; `useReducer` для файлов пакета; cleanup из ref-колбэков (React 19); CSS
   `:hover` вместо стейта; `key` с version у неуправляемых инпутов; `key` ветвей фрагмента.

Ожидание по фазе: −1500…2000 строк дублей, LevelGraph ≈1150, NodePage ≈450, оболочки
ProcessCanvas/SequenceDiagram ≈150–300 строк, `eslint-disable` на страницах — 0.

### Фаза 8 — Уроки (по итогам каждой фазы)
Добавить в «Архитектурные привычки» CLAUDE.md/QWEN.md и закрепить сторожами:
1. Любая запись строк по id из тела запроса проверяет принадлежность проекту — даже
   «служебная» (restore, импорт, снимки). Сторож: тест на межпроектный снимок.
2. Схемы Pydantic зеркалят длины колонок; SQLite в тестах этого не ловит — ловит
   сторожевой тест «`max_length` ≤ `String(n)`».
3. Обход предков всегда с `seen`; данные из снимков/импорта — потенциально циклические.
4. Регулярка на пользовательском тексте проверяется замером на враждебном входе
   (удвоение входа → не более чем удвоение времени).
5. Экспорт без потребителя не заводится; knip — в гейт фронта (хотя бы предупреждением).
6. Ошибка загрузки показывается пользователю; `void promise` без `catch` не пишем.
7. Аудит зависимостей — в CI; обновления — Dependabot; поставка — по lock с хэшами.
8. Обновлять CLAUDE.md и QWEN.md одним коммитом с правкой структуры (прошлый урок не
   прижился: дрейф 173 строки).

## 5. Реестр находок

Колонки: критичность (критично / высоко / средне / низко / инфо), место в коде (пути —
относительно `backend/app/` для S/Q, `frontend/src/` для F/R, корня репозитория для P),
суть и правка, объём (S — до часа, M — до дня, L — несколько дней).

### Б.1. Безопасность и надёжность бэкенда (S — разведка «безопасность», M — проверки ведущего)

| ID | Крит. | Где | Суть → правка | Объём |
|---|---|---|---|---|
| S1 | критично | `routers/nodes.py:137` restore_nodes → `restore.py:157` restore_from_snapshot | Дочерние строки снимка (node_docs, db_tables, db_columns, broker_channels, channel_fields, config_params, edges, layout_items) вставляются с FK из тела запроса без проверки принадлежности проекту: редактор проекта A пишет доки/таблицы на узел проекта B и создаёт рёбра с чужими концами (подтверждено прогоном, 204). → Каждая дочерняя строка: родитель либо в самом снимке, либо `scoped_node`/`scoped_edge` текущего проекта; иначе 422. Тест на межпроектный снимок. | M |
| S2 | высоко | `restore.py:174` depth(); `tree.py:20,38` ancestors/node_depth; `routers/projects.py` root_of | Снимок с `parent_id == id` (или a↔b) проходит гарды и вешает воркер в бесконечном `while` (подтверждено). Хелперы дерева тоже без защиты от цикла (цикл в БД достижим только через S1-путь; PATCH защищён validate_reparent). → `seen`-множество в обходах предков + 422 на цикл в снимке. | S |
| S3 | высоко | `mmd_header.py:191` `_UNPAIRED`; вызовы `docs_import.py:148`, `unified_import.py:395` | Регулярка квадратична на входе вида `"a-"*n`: 4 КБ 0,16 с, 32 КБ 11 с (замер); предел файла 2 МБ → часы CPU одним запросом редактора. → `[\w-]{1,64}` или линейный разбор; лимит длины mermaid до разбора. | S |
| M1 | высоко | `auth.py` hash_password / verify_password | bcrypt 5.0 бросает ValueError на пароле длиннее 72 байт → 500 на /auth/register, /auth/login, /auth/password, /admin/users, /admin/users/{id}/password (проверено). → password_problem: ≤72 байт UTF-8 с текстом; verify_password ловит ValueError → False. | S |
| M2, S4, S5, S8 | средне | `schemas/auth.py` UserCreate; `schemas/node.py` NodeCreate/Update, NodeSource; `schemas/edge.py`; `schemas/process.py` ProcessCreate; `routers/views.py:245` item_id | Нет `max_length` под длины колонок (username 64, name 256, role/technology 128, label 256, source_ref 512, item_id 128): на Postgres DataError → 500, SQLite-тесты не ловят. → `Field(max_length=…)` по длинам колонок; role в UserCreate — `UserRole` (Literal). | S |
| S9 | низко | `restore.py:187-213` | Дубль имени дока/таблицы в снимке → IntegrityError 500 (в CRUD `_name_taken` → 409). → пре-чек или перехват IntegrityError → 409. | S |
| S6 | средне | `database.py:5` | `create_engine` без `pool_pre_ping`/`pool_recycle`: после простоя или рестарта БД первый запрос на каждом соединении — 500. → `pool_pre_ping=True, pool_recycle=1800`. | S |
| S7 | средне | `unified_import.py:76-80` + `archive_import.py:23-25` | 16 архивов × 64 МБ распаковки из одного запроса ≤64 МБ (zip из нулей) → до ~1 ГБ строк в памяти → OOM контейнера. → Общий кап распакованного объёма на запрос. | M |
| M4, P-17 | средне | `routers/demo.py:19` request.client.host; `deploy/openshift/Dockerfile:60` FORWARDED_ALLOW_IPS=*; uvicorn 0.29 proxy_headers.py:32 | При доверии всем прокси uvicorn берёт ПЕРВЫЙ адрес X-Forwarded-For (его присылает клиент) → лимит стартов песочниц на IP и адреса в журнале подделываются заголовком (в чистом k8s; OpenShift-роутер заменяет XFF). `standalone.client_address` берёт последний — два источника адреса в одном процессе. Серверная поставка (nginx + `--forwarded-allow-ips 127.0.0.1`) корректна. → Один helper адреса клиента для всех лимитеров; DEPLOY.md: ingress должен заменять XFF либо `FORWARDED_ALLOW_IPS=<CIDR>`. | S |
| M5 | низко | `rate_limit.py` AddressLimiter | Ключи адресов не удаляются после опустошения очереди → рост памяти по числу уникальных IP за жизнь процесса. → удалять пустые ключи. | S |
| M6 | инфо | `auth.py`, `routers/auth.py` | Осознанные решения, зафиксировать в spec/README: токен 7 дней без отзыва (is_active — kill switch на каждом запросе), смена пароля не инвалидирует токены, регистрация позволяет выбрать роль architect (ALLOW_SIGNUP=true по умолчанию). | — |
| P-16 | средне | `main.py:105` /health | Не трогает БД: readiness и установщик считают сервис готовым при недоступной базе. → `/ready` с `SELECT 1` (таймаут 2 с, 503). | S |

Проверено — чисто (не перепроверять): карта «мутирующая ручка → зависимость доступа» по всем 21 роутеру — записи под чтением нет; IDOR по id в теле/пути закрыт везде, кроме restore (S1); `deny_guest` на участниках/видимости/передаче/пароле/списке пользователей; пределы демо — центрально через слушатели сессии (before_flush/before_commit), обойти записью мимо нельзя; YAML — везде `safe_load`, «billion laughs» не амплифицирует память; zip — капы по central directory до чтения; прочие регулярки линейны; циклы дерева через PATCH невозможны; CAS/FOR UPDATE на месте; `except Exception` ×2 оправданы; detail без внутренностей; фоновые сессии закрываются.

### Б.2. Фронтенд в рантайме (R — разведка «устойчивость/безопасность/производительность»)

| ID | Крит. | Где | Суть → правка | Объём |
|---|---|---|---|---|
| R-1 | высоко | `main.tsx:11`, `App.tsx` | Ни одного ErrorBoundary: исключение в рендере → белый экран без текста. → Границы вокруг маршрутов с карточкой «обновить / к проектам»; `createRoot(..., { onUncaughtError, onCaughtError })`. | S |
| R-2 | высоко | `pages/NodePage.tsx:85-113` | `load` без catch: 404/403/сеть → `finally` снимает loading, node = null → «Загрузка…» навсегда. → состояние ошибки с текстом и «К проекту». | S |
| R-15 | средне | `App.tsx:112-124` | `onUnauthorized` подписан только в демо: вне демо истёкший токен → пустые страницы, на вход не ведут. → подписка во всех режимах + плашка «Сессия истекла». | S |
| R-9, R-10 | средне | `pages/MapEditorPage.tsx:153-275`, `pages/useLevelSchema.ts:34-51` | `load` без номера прогона: фоновый тик поллинга + быстрый drill → ответ корня ложится под крошками контейнера; ошибки загрузки не ловятся (пустой холст / «проект пуст»). → `loadSeqRef` + состояние ошибки с «Повторить». | S |
| R-7 | средне | `components/mermaidLoader.ts:9` | Отклонённый `import()` кэшируется навсегда; нет обработчика `vite:preloadError` → после выката все схемы в открытой вкладке «Ошибка в синтаксисе» до F5. → сброс промиса на отказе; `vite:preloadError` → тост/перезагрузка. | S |
| R-8 | средне | `api/projectScope.ts:9`, `api/client.ts:88`, `api/auth.ts`, `schemaView.ts`, `labelsPref.ts`, `ProjectShell.tsx:61`, `ProcessWorkspace.tsx:76` | localStorage без try/catch, в том числе на уровне модуля: заблокированное хранилище (политика, Safari, iframe) → приложение не стартует; квота в эффекте → размонтирование. → `safeStorage` с in-memory фолбэком, 7 мест. | S |
| R-11 | средне | `graph/interaction/persistGuard.ts:13`, `useLevelPersistence.ts:93` | Отказ записи раскладки (сеть/403) — только console.error + ресинк: узлы молча прыгают назад. → тост через onPersistError (один на серию). | S |
| R-12, R-13, R-14 | средне | `pages/useNodePatch.ts:118,175`; `inspector/NodeInspector.tsx:102,155`; `inspector/useEdgeEdit.ts:176`; `MapEditorPage.tsx:425,801` | Оптимистичные правки без отката при не-409 отказе (is_external, status, инверсия связи); handleReparent без try/catch. → откат из beforeRef; try/catch → тост + перечитать дерево. | S |
| R-6 | средне | `docsImport/PromptCopyButton.tsx:48` и 10 вызовов (OpenApiPane, FlowchartDocs, Channels/Recon/Config-модалки, SyncRepoModal, DocsAgentPanel, SpecAgentPanel) | `navigator.clipboard` без feature-detect и с проглоченным отказом: на http:// не-localhost (поддерживаемый режим установки) и в Safari после await главная кнопка BYOA «не работает» молча. → один `copyText()` (ClipboardItem(promise) → textarea/execCommand → показать текст), ошибки в окно. | M |
| R-3 | средне | `components/OpenApiViewer.tsx:46` | swagger-ui сам резолвит внешние `$ref` (fetch same-origin): спека редактора с `$ref: http://10.0.0.5/…` заставляет каждого открывшего оверлей слать GET из своего браузера (зонд интранета). Try-it-out выключен. → `requestInterceptor`, отклоняющий внешние URL / вырезать внешние `$ref`; CSP `connect-src 'self'` вторым слоем. | S |
| R-5, R-22 | средне | `inspector/docValidate.ts:5,48`; `inspector/OpenApiDoc.tsx:34` | js-yaml 5.2.1 (квадратичные DoS) синхронно разбирает `openapi_spec` другого участника в инициализаторе стейта. → js-yaml ^5.4.3; разбор в эффекте. | S |
| R-16 | низко | `mermaidLoader.ts:15-21` | maxTextSize 1 000 000 / maxEdges 4 000 обоснованы «ввод — свои данные»; после эпика доступа схема редактора рендерится у читателя на главном потоке (минуты). → порог с «Показать всё равно». | S |
| R-17 | низко | `graph/layout/pipelineClient.ts:36-100` | У воркера нет таймаута/`onmessageerror`: патологический прогон держит очередь до перезагрузки. → сторож + пересоздание воркера. | M |
| R-23, R-24, R-25, R-27 | низко | `project/SchemaPreview.tsx:52`; `pages/useRemoteSync.ts:51`; `api/auth.ts:74`; `pages/ProjectAccessGate.tsx:30` | computeLayout без catch; поллеры без экспоненциального отката и признака «офлайн»; atob без base64url (кириллица в sub); пустой экран между проектами. | S |
| R-26 | низко | `processes/ProcessCanvas.tsx` ×10, `pages/NodePage.tsx` ×5, `inspector/NodeInspector.tsx` ×2, AddDocsMenu, CrossLevelEdgePicker, ProcessRail | 20 кликабельных div/span без role/tabIndex — недостижимы с клавиатуры. → `<button type="button">`. | M |
| R-18, R-19, R-20 | низко | `pipelineClient.ts:20`; `App.tsx:8-15`; `docValidate.ts:5` | Главный чанк 1 200 КБ (358 КБ gz) грузится на экране входа: статический импорт конвейера ради фолбэка, ни одного `React.lazy` (тур, процессы, админка, 6 окон BYOA, импорт), js-yaml в главном чанке. → `import("./pipeline")` в фолбэке; `lazy()` для DemoTour, ProcessWorkspace, UsersPage, docsImport/*, CreateProjectDialog/ImportIntoModal; js-yaml лениво (−150…250 КБ raw). | M |
| R-21 | инфо | сборка | ELK лежит дважды (воркер IIFE 1 690 КБ + elk.bundled 1 399 КБ для mermaid/фолбэка); immutable-кэш, цена разовая на релиз. Зафиксировать как принятое. | — |

Проверено — чисто: токен только в Authorization; mermaid 12 strict + DOMPurify, click-callback отключён; swagger без try-it-out, sanitizeUrl; `target=_blank` с noopener; внешних ресурсов и CDN нет; sourcemap/define/VITE_* нет; параметры URL ограничены регэкспом; воркер без eval; размеры файлов проверяются до чтения; routeCacheStore/tourStore с try/catch и лимитами; гонки под флагом в 9 местах; поллинг пропускает фон/жесты/диалоги; слушатели и обсерверы чистятся; nodeTypes/edgeTypes — константы, reconcileRf, троттлинг pointermove; модалки на `<dialog>`; кэши ограничены; статика gzip/immutable.

### Б.3. Периферия: деплой, CI, MCP, скрипты, документация (P — разведка «периферия», M — проверки ведущего)

| ID | Крит. | Где | Суть → правка | Объём |
|---|---|---|---|---|
| P-1 | высоко | `deploy/install.sh:136-170` | Симлинк `current` переключается до перезапуска службы; если /health не ответил за минуту — `die` без отката: сервис лежит до ручного `ln`. → `trap rollback ERR` (вернуть PREV + restart), снять после проверки. | S |
| P-2 | высоко | `deploy/install.sh:12,90-96` | Пустой файл VERSION → `REL=$PREFIX/releases/` → `rm -rf "$REL"` сносит все релизы. → валидировать VERSION регэкспом. | S |
| P-3 | высоко | `deploy/install.sh:133`, `DEPLOY.md:272` | Резервная копия перед `alembic upgrade` — устная просьба; откат схемы только из копии. → `pg_dump -Fc` в `ARCHMAP_BACKUP_DIR` перед миграцией либо явный `--no-backup`. | M |
| P-4 | высоко | `mcp/README.md:104-121` | README учит класть ARCHMAP_PASSWORD в трекаемый `.mcp.json` (репозиторий публичный); `mcp/.env` не упомянут. → учётка только в `mcp/.env`. | S |
| M3, P-13, R-4 | средне | `deploy/install.sh:173-250` nginx; `standalone.py:56-80` | Нет security-заголовков (nosniff, Referrer-Policy, Permissions-Policy, CSP frame-ancestors/base-uri/object-src, HSTS в TLS-ветке), `server_tokens off`, ssl_session_*/ssl_ciphers, proxy-таймаутов; `add_header` в location перекрывает серверные; `limit_req` только на login — нет на `/api/v1/demo/start` и `/api/v1/auth/register`. → include-сниппет заголовков (готовый фрагмент — приложение А отчёта разведки), зоны archmap_signup 3r/m и archmap_demo 6r/m, полная CSP сначала Report-Only; те же заголовки в standalone на index.html. | M |
| P-14 | средне | `deploy/archmap.service` | Базовый hardening есть; добавить ProtectKernel*/PrivateDevices/RestrictNamespaces/RestrictAddressFamilies/SystemCallFilter=@system-service/CapabilityBoundingSet=/UMask=0077 (приложение Б отчёта), проверять `systemd-analyze security`. | S |
| P-6, P-23 | высоко | `scripts/{dump-levels,perf-probe,spawn-probe,triple-probe,drift-probe,fps-probe}.mjs`, `scripts/hub-survey.py:12`; `docs/specs/README.md:35,79` | Зонды чеканят JWT с ролью в claim и `sub=admin`; после эпиков admin/access роль из токена игнорируется → нормативный полигон спек ([полигон]) тихо нерабочий/ложный. → `makeToken(username)` без role, `ARCHMAP_PROBE_USER`, второй пользователь-reader через API; оговорка в README спек. | M |
| P-5, P-32 | средне | `.github/workflows/ci.yml:74`; версии | Инструменты MCP-гейта не пинованы (CI ставит latest); Node 22 в CI/README vs 24 локально; Python 3.11 в доках vs 3.12 везде; нет `.nvmrc`/`engines`. → `mcp/requirements-dev.txt`, `.nvmrc`, `engines`, доки. | S |
| P-18, P-19, P-20, P-33, M14 | средне | `.github/workflows/ci.yml`; `scripts/git-hooks/pre-commit:33` | Нет `permissions: contents: read`, `concurrency`, `timeout-minutes`; actions по мажорным тегам; нет `vite build`/`build:embed`; нет проверки дрейфа `api.gen.ts` против `app.openapi()`; нет аудита зависимостей; хук и CI не видят `deploy/*.sh`, `scripts/*.sh`, `deploy/*.py` (`bash -n`/shellcheck/ruff). → фрагмент CI — приложение В отчёта разведки. | M |
| M12 | средне | `frontend/vite.config.ts` coverage.thresholds | Порог покрытия 45/37/32/45 никем не проверяется: CI и хук гоняют `vitest run` без `--coverage`; бэк без pytest-cov. → `vitest run --coverage` в CI (ratchet по факту), pytest-cov с порогом по модулям. | S |
| M13, P-26, P-30 | средне | `backend/pyproject.toml`, `mcp/pyproject.toml`, `tsconfig.app.json` | ruff — минимальный набор (E4,E7,E9,F,I,B,UP); mypy без strict; `target-version py311` при 3.12; три ненужных `# type: ignore` в mcp/server.py; нет `noUncheckedIndexedAccess`. → ruff += S, PERF, SIM, RUF, PIE, RET, C90 (max-complexity ~15) с ratchet; mypy `warn_unused_ignores`, `disallow_untyped_defs` по пакетам; py312. | M |
| P-22 | средне | `deploy/build-bundle.sh:78`, `requirements-prod.txt` | Транзитивные зависимости не пинованы, нет `--require-hashes`: сборки одного коммита могут отличаться, аудит проверяет не то, что едет. → `pip-compile --generate-hashes` → `requirements-prod.lock`; детерминированный tar. | M |
| M9, P-43 | низко | `.github/` | Нет Dependabot/Renovate: отставание накапливается молча. → `dependabot.yml` (github-actions, pip ×2, npm; weekly, grouped). | S |
| P-8, P-9, P-10, P-11 | средне | `mcp/client.py:41`; `mcp/server.py:54`; `mcp/tools.py:356,438,462` | Парсер .env не понимает BOM и `export`; ловится только ArchMapError (KeyError/JSONDecodeError уходят модели голым текстом); `out_path` от модели без ограничений (абсолютные пути, `..`, overwrite любого файла, dangling-симлинк, неатомарная запись); входные файлы и ответ архива читаются в память без лимита. → utf-8-sig/removeprefix; второй except → понятный текст; `.zip` обязателен, is_symlink → отказ, tmp + os.replace, `ARCHMAP_EXPORT_DIR`; `st_size ≤ 64 МБ`. | S |
| P-12, P-24, P-27, P-28, P-29, P-38 | низко | `mcp/README.md`, `mcp/tests`, `mcp/tools.py`, `mcp/render.py:202` | README описывает несуществующий аргумент `target` и «четыре семьи» при трёх; нет тестов на 5xx/HTML-тело прокси/второй 401/BOM; нет слова про корпоративный CA; 46 аргументов без description; `alerts()` 145 строк, тексты причин не сторожатся тестом. | S |
| P-21 | средне | `frontend/scripts/replay-prof.ts`, `route-quality.ts` | Запуск через `npx vite-node` (не в devDeps, vitest 4 не тянет) → в закрытом контуре не работают, knip считает мёртвыми. → npm-скрипты + vite-node/tsx в devDependencies. | S |
| P-25, P-42 | низко | `stop.sh:7`; `dev.sh:43` | `pkill -f vite` гасит чужие процессы со строкой vite; backend/.env с паролем БД пишется под umask 0644. → по пути бинаря/порту; `umask 077`. | S |
| P-15, P-34, P-35, P-36, P-37, P-39 | низко | `deploy/*`, `DEPLOY.md`, `backend/.env.example` | `--no-systemd` невидим в --help/DEPLOY.md; WEB_CONCURRENCY в двух местах; `/robots.txt`, `/.well-known/*` отдаются как SPA; archmap-admin работает от root; нет абзаца про журналы/ротацию; 6 из 12 полей Settings не описаны в .env.example. | S |
| P-7 | высоко (для агентов) | `CLAUDE.md`, `QWEN.md` | 173 строки расхождений между файлами; оба расходятся с кодом: Python 3.11 → 3.12, «24 тестовых файла» → 62, «10 спек» → 11, TreePage удалён, роутеров 11 → 21, схем 10 → 23, ~30 модулей `app/*.py` не перечислены, 33 живых плана и `docs/tasks/` не описаны. → переписать «Структура проекта» по факту, синхронизировать QWEN.md. | M |
| P-40, P-41, M17 | низко | `demo_package.py:16`, `test_template_package.py:14`, `routerVersion.ts:338`, `autoRoutes.ts:8`, `ports.ts:1`, `arrowsPolygon.perf.test.ts:5`, миграция b7c8d9e0f1a2; `mock-import.yaml` | Ссылки на планы, переехавшие в `docs/archive/`; фикстура лендинга в корне репозитория. | S |
| P-31 | низко | `.mcp.json`, `.claude/settings.json` | Абсолютные пути домашнего каталога в трекаемых конфигах. | S |

Проверено — чисто: секретов и `.env` в истории нет, ключей/IP/e-mail в трекаемых файлах нет; MCP: TLS verify, токен только в памяти, валидация аргументов SDK по схеме, мёртвых функций в render.py нет, 152 теста зелёные; поставка: переносной CPython пинован SHA256, mktemp+trap, `set -euo pipefail`, секреты не в argv, в архиве нет лишнего; сервер: миграции до переключения, advisory lock alembic, `archmap.env` 640 root:archmap, служба от отдельного пользователя; OpenShift: пробы, limits, runAsNonRoot, readOnlyRootFilesystem, drop ALL, секреты через Secret; битых ссылок в .md нет, карта «модуль → спека» 124/124, 31 инструмент MCP совпадает с документацией.

### Б.4. Зависимости и схема БД (M — проверки ведущего)

| ID | Крит. | Где | Суть → правка | Объём |
|---|---|---|---|---|
| M7 | высоко | `backend/requirements-prod.txt` | Срез весны 2024 с открытыми CVE в поставке: starlette 0.37.2 (транзитивно через fastapi 0.111.0; multipart без имени части, большие файлы, Host, max_fields), python-multipart 0.0.9 (DoS/traversal/Content-Length; fix 0.0.32), PyJWT 2.13.0 (14 PYSEC, у нас HS256 с одним алгоритмом — не эксплуатируемо, fix 2.15.1), python-dotenv 1.0.1. Актуально: fastapi 0.143, uvicorn 0.54 (у нас 0.29), pydantic 2.14 (2.7.1), pydantic-settings 2.15 (2.2.1), sqlalchemy 2.0.30 → последний 2.0.x (2.1 — отдельное решение), alembic 1.20 (1.13.1), psycopg2-binary 2.9.13. mcp 1.27.1 → 1.28.1 (PYSEC-2026-3481/3482/3483; 2.x — мажор), PyYAML 6.0.2 в mcp vs 6.0.3 в бэке. → Два шага: независимые пакеты (python-multipart, PyJWT, python-dotenv, pwdlib, psycopg2, alembic, uvicorn, mcp 1.28) сразу; FastAPI+Starlette+Pydantic — отдельным заходом под полным гейтом и ручной проверкой импорта файлов. | M |
| M8 | средне | `frontend/package.json` | npm audit: 15 (8 high, 5 moderate, 2 low). Прямые: js-yaml 5.2.1 high (→5.4.3), vite 8.0.14 high (dev; →8.3.4), vitest/@vitest/coverage-v8 4.1.10 moderate (dev), mermaid→katex low (fix только даунгрейдом mermaid — не делать). Транзитивные (brace-expansion, browserslist, nanoid, postcss, source-map-js, undici) — `npm audit fix`. Отставание: @xyflow/react 12.10→12.12, react 19.2→19.3, elkjs 0.11→0.12 (override на mermaid), typescript 6→7 (мажор, отдельно). → `npm audit fix` + точечные бампы под гейтом; mermaid/katex — ждать. | S |
| M10 | средне | `models/*.py`, миграции | Нет индексов на FK: `nodes.parent_id`, `edges.source_id`/`target_id`, `process_participants.process_id`/`node_id`, `process_fragments.process_id`, `process_messages.process_id`/`edge_id`/`from_participant_id`/`to_participant_id`/`doc_id`, `business_processes.scope_node_id`, `db_columns.ref_column_id`, `projects.created_by_id`/`updated_by_id`. На Postgres FK индекс не создаёт: каскадные удаления узла сканируют edges/nodes/participants целиком, выборки связей узла и детей — seq scan с фильтром по project_id. → одна миграция с индексами (`index=True` в моделях + autogenerate). | S |
| M11 | низко | `database.py` | SessionLocal без `expire_on_commit=False`: коммит активности гостя в зависимости истекает объект пользователя → лишний SELECT. → `expire_on_commit=False` только при осознанной проверке мест, где полагаются на refresh. | S |

### Б.5. Мёртвый код по knip и vulture (M16; подтверждение по пунктам — в разведке «структура фронтенда» и «качество бэкенда»)

knip (`frontend`): файлы — `src/components/processes/LegLegend.tsx` (единственная ссылка — собственное объявление; удалить), `scripts/replay-prof.ts` и `scripts/route-quality.ts` (инструменты без npm-скрипта — P-21); лишние экспорты (24): `tourSteps.WATCH_MS`, `tourDemo.SNAP_PX`, `tourGeometry.{HOLE_PAD,DOT_PAD,CARD_GAP,CARD_MARGIN,intersect}`, `useLevelLocate.LEVEL_FIT_OPTIONS`, `tourTargets.visibleRect`, `tourMachine.sequenceOf`, `useFileDrop.MAX_FILE_BYTES`, `ImportPane.MAX_IMPORT_FILES`, `RehangAnchor.REHANG_HIT_R`, `graph/constants.{HANDLE_SLOT,CTX_LABEL_W,MIN_SHELF,SHELF_PAD}`, `edges.sideFromStub`, `frameChains.breadcrumbRefs`, `graph/icons.MoreIcon`, `snap.snapCenter`, `routeAll.buildPlacedIndex`, `routeQualityMetrics.METRIC_LABELS`, `reconcileRf.contentEqual`, `SchemaViewChrome.StatusLegend`, `processes/icons.{IcoChevron,IcoDots,IcoExport,TechChip}`, `remainder/index.ts` ×6, `questionText.familyDefaultIndex`, `types/index.withoutPersons`, `ui/icons.{ExportIcon,RepoSyncIcon}`, `routerFuzz.{fnv1a,djb2}`; лишние экспортированные типы (24) — в `scratchpad`-отчёте knip; devDependency `@types/js-yaml` не используется. Правило: экспорт, используемый только в своём файле, теряет `export`; неиспользуемый нигде — удаляется.

vulture (`backend/app`, порог 60 %): шум на роутерах и pydantic-полях; содержательные кандидаты — `copy_plan.NOT_COPIED`, `restore.SNAPSHOT_PLAN`/`NOT_IN_SNAPSHOT`, `docs_import.MAX_LOGIC_PER_NODE`/`MAX_MERMAID_LEN`/`MAX_SPEC_LEN`, `demo_limits._text_bytes_default`/`_text_bytes_sqlite` (вероятно диалектные ветки), `mmd_header.is_empty`, `rate_limit.reset`, `deps.require_project_owner`, `models.node.outgoing_edges`/`incoming_edges`, `models.project.business_processes` — вердикт по каждому в Б.6.

### Б.6. Качество кода бэкенда (Q — разведка «качество бэкенда»; Q-1 ≡ M10)

| ID | Кат. | Важн. | Где | Суть → правка | Объём |
|---|---|---|---|---|---|
| Q-1 (M10) | неоптимально | высоко | `models/{node,edge,process_message,process_participant,process_fragment,business_process,db_column,project}.py` | 14 FK без индекса (см. М10); горячие запросы фильтруют именно по ним (`routers/nodes.py:67,632,725`, `tree.py:82`, `processes.py:154`, `node_docs.py:152`), каскады при удалении — seq scan. → `index=True` + одна миграция. | S |
| Q-2 | дублирование | высоко | `data_import.py` / `channels_import.py` / `config_import.py` / `recon_import.py` | Семейство дозаливки фактов — копии: `_resolve_node` 88,6 % (data↔channels), 83,5 % (data↔config); `_as_bool`/`_as_str` 100 % (и уже разошлись: config обрабатывает bool); `_Merged` 86 %; `_warn_duplicates` ×3, `_*_nodes_hint` ×3; каркас `build_*_plan` 54–56 %. → `app/facts_import.py`: `resolve_owner`, `as_str/as_bool`, `nodes_hint`, `warn_duplicates`, `warn_meta_conflicts`, `MergedEntry[T]`, `merge_by_key`, `live_by_key`; −400…450 строк из 1808. | L (шагами S) |
| Q-3 | дублирование | высоко | `routers/{data_import:45,config_import:52,channels_import:80,recon:72}.py` | Ручки preview/apply/prompt семейства — шаблон (62–69 %): `_plan → errors → apply → bump_meta_rev → touch → commit`. → `routers/_facts.py` `make_facts_router(...)` или общие `run_preview/run_apply`; −110 строк. | S/M |
| Q-4 | анти-паттерн | высоко | `docs_import._node_paths` (`:204-239`, импортируется 11 модулями как приватное имя), `node_ref.node_addresses`, `routers/nodes._node_paths` (`:300-313`) | Три способа посчитать путь узла, расходятся у тёзок (превью перехода vs адрес в архиве); 4-кортеж распаковывается в 10 местах; цикл `docs_import ↔ data_refs` через TYPE_CHECKING и два локальных импорта. → публичный `NodeIndex` в `node_ref.py` (`flat, paths, by_name, by_path, path_of, hint(shape)`), один источник; цикл исчезает. | M |
| Q-5 | типы | высоко | модели `node.py:47,50`, `node_doc.py:46`, `process_fragment.py:28`, `process_message.py:37`, `project_member.py:39`, `user.py:16`; dataclass'ы `sync_plan.py:66-90`, `import_merge.py:214,224,302`; дубли Literal в `schemas/*` | 22 `# type: ignore` + 11 `cast` + `_report` в `routers/docs_import.py:238-276` ради cast'ов: enum-колонки типизированы `Mapped[str]`, Literal'ы определены по 2–3 раза (`Shape`≡`NodeShape`, `Mode`≡`DataRefMode`, `Family` ×2, `LimitKind` ×2…), рантайм-наборы переписаны руками (`_SHAPES`, `KINDS`, `CONTAINER_SHAPES`, `_RANK`). → `app/domain_types.py` — единственный источник Literal'ов + `get_args`; `Mapped[NodeShape]` с `Base.type_annotation_map` (String сохраняется, миграция не нужна); dataclass'ы теми же алиасами → ignores 0. | M |
| Q-6 | неоптимально | высоко | `data_refs.catalog_for_project` (`:416-485`) + скан всех доков с `parse_data_refs` в `alerts.py:431`, `routers/db_docs.py:128`, `broker_channels.py:146`, `config_params.py:106`, `data_refs.py:57`, `docs_import.py:69`; `search.collect_units` (`search.py:169-342`, 9 запросов, постинги на каждый запрос) | Полный разбор всех схем логики проекта на каждое чтение алертов/usage/поиска при наличии точных ключей инвалидации `graph_rev/meta_rev/process_rev`. → `app/project_index.py`: per-process LRU-кэш (32–64 проекта) с ключом `(project_id, graph_rev, meta_rev, process_rev)` → замороженный индекс. | M |
| Q-7 | анти-паттерн | высоко | `alerts.compute_alerts` (`alerts.py:82-569`) | 488 строк в одной функции, 14 секций AL24…AL35, ~10 запросов; `_channel_known` — линейный проход в цикле по связям O(E×C). → `AlertContext` + функция на класс алерта, `compute_alerts` — сборщик 30 строк; `known: set[(node_id, name)]`. | M |
| Q-8 | дублирование | высоко | `routers/db_docs.py:115-187` ↔ `broker_channels.py:129-205` (70 %) ↔ `config_params.py:91-152` | Три `list_usage` с одним скелетом. → `data_refs.usage_index(db, project_id, pick=...)`; роутеры по 10 строк; −120 строк. | S/M |
| Q-9 | домен в роутере | высоко | `routers/processes.py` (974; после фазы 4 было 480): `create_message` 97 строк / 10 обращений к БД (`:440-536`), `_check_fragment` (`:749-790`), `list_channels` (`:929-974`), `bind_participant` (`:320-368`), `reorder_messages` (`:541-585`, дубль `edge_of` из `processes.py:537-544`) | → `processes.validate_message(...) -> MessageDraft` с `ProcessRuleError(status, detail)`, `check_fragment`, `channels_between`, `edge_loader(db)`. | M |
| Q-10 | домен в роутере | средне-высоко | `routers/nodes.py` 568 → 812: `transition_*`, `_node_paths`, `get_move_snapshot`, `validate_shape_change` (`:412-450`), `anchor_preview` + `_source_ref_of` (`:335-371`), `get_node_edges` (`:615-658`), `_clear_level_layout` (`:738-769`, commit внутри хелпера) | → `identity.parse_source_patch`, `validate_shape_change` → `reparent.py`, `graph_queries.external_edges`, `view_state.reset_view_layout` без commit. | M |
| Q-11 | домен в роутере | средне | `routers/projects.py` (918): `_previews` 96 строк чистого алгоритма (`:122-217`), `_counts`, `_users_map`, `_responses`; `sync_preview`/`sync_apply` дублируют блок `build_sync_plan(...)` (`:553`, `:640`) | → `app/projects.project_cards(...)`, `sync_plan.plan_for(...)`. | M |
| Q-12 | N+1 | средне | `data_import.apply_data_plan` (`:483-560`), `config_import.apply_config_plan` (`:410-439`), `channels_import.apply_channels_plan` (`:744-805`) | Запрос + flush на каждую таблицу/параметр/канал, второй проход тем же запросом, `owner_tables` внутри цикла → O(T²) строк; `live_by_key` из build-фазы выбрасывается. → нести `live` в плане или один `in_` + `selectinload`, один flush. | S ×3 |
| Q-13 | неоптимально | средне | `channels_import._warn_wrong_broker` (`:556-634`), `_warn_uncovered_edge_channels` (`:636-718`) | Каждая заново грузит все каналы и связи проекта; `edge_channel_minimum` считается в трёх местах. → один `ProjectChannels`-контекст. | S |
| Q-14 | неоптимально | средне | `unified_into.build_into_plan` (`:200-201`), `routers/projects.py:443,500` | Весь живой проект сериализуется в zip и парсится заново на каждое превью и применение (план строится повторно); `_replace_params` по одному. → кэш self-архива по ключу Q-6; батч `in_`. | M |
| Q-15 | дублирование | средне | `routers/db_docs.py` 338 + `broker_channels.py` 349 + `config_params.py` 217 | `_get_node` 100 % ×4, `_scoped_*` ×5, `*_taken` ×6; `update_table`↔`update_param` 72 %, `delete_*` 77 %. → `deps.node_or_404`, `owned_or_404`, `name_taken`, `check_cas`, `apply_patch`; −150…200 строк. | M |
| Q-16 | анти-паттерн | средне | `sync_apply.apply_sync_plan` (`:49-166`) | Вложенность 9 (максимум по бэку), ручной диспетчер `if fld == …` по именам полей. → `setattr` для плоских полей + особый `source_ref`; три хелпера create/update/missing. | S |
| Q-17 | длина | средне | `docs_import.build_docs_plan` 245, `unified_into.apply_into_plan` 208, `unified_apply.apply_unified_plan` 194, `import_yaml.parse_import` 306, `search.collect_units` 174, `unified_import.remainder_with_index` 148, `process_import.apply_import` 138 / `parse_sequence` 131, `archive_export.build_archive_ordered` 129 | → резать по уже стоящим секционным комментариям. | L (S на функцию) |
| Q-18, Q-19 | ответственности | средне | `import_merge.py` 1583 (`_Merger` 506 + 6 анализаторов ≈380), `unified_import.py` 1558 (план + ~450 строк текстов + превью), `docs_import.py` 903 (парсер, fuzzy, `_DataRefCheck` 204, план, применение) | Четыре «поколения» импорта все живые (мёртвого слоя нет). → чистые переносы: `merge_warnings.py`, `unified_remarks.py`, `unified_preview.py`, `docs_pkg.py`, `name_match.py`. | M |
| Q-20 | неоптимально | средне | `GET /projects` → `_previews` + `_counts` (`routers/projects.py:134-188`) | Все узлы, связи и корневые строки раскладки всех видимых проектов на каждый список; на демо-стенде админ видит все песочницы. → кэш превью по `graph_rev` (Q-6) либо SQL-ограничение. | M |
| Q-21, Q-22 | дублирование хелперов | средне | `_basis_of_key` (`import_merge.py:87` ≡ `sync_plan.py:155`), `_norm` (`import_merge:435` ≡ `sync_plan:135`), `_norm_name` (`import_yaml:139` ≡ `docs_import:340`), `_LANG_LINE` (`import_prompt:196` ≡ `docs_prompt:25`), `_clean` (`process_import:252` ≡ `process_export:35`; ещё два `_clean` с другой семантикой), `edge_of` ×2; три реализации «вы имели в виду» (`import_yaml._closest_node`, `docs_import._closest_name`, `import_merge` fuzzy-сиблинги; `channels_import.py:696` — «своя копия порога») | → `app/text.py`, `node_ref.basis_of_key`, `prompts_common.LANG_LINE`, `name_match.closest(...)` с общими порогами (проверять test_import/test_docs_import — пороги различаются). | S / M |
| Q-23 | анти-паттерн | средне | ~30 ручек: `bump_*_rev` (50) + `touch_project` (30) + `db.commit()`; `routers/projects.py:505,649` ставят `updated_at/updated_by_id` руками; `routers/processes.py:90` свой `_touch` | → `deps.commit_change(db, project, user, *, graph=, meta=, process=, view=)`. | S |
| Q-24, Q-25 | анти-паттерн | средне | `ViewLayoutItem.payload` читается тремя способами (`graph_queries.py:68`, `routers/projects.py:153`, `routers/nodes.py:760`); 4-кортежи `catalog_for_project` (6 мест), `_node_paths`, `apply_docs_plan -> tuple[int,int,int,int]` (`routers/docs_import.py:307` — те самые «unused attribute» vulture) | → `ViewLayoutItem.parsed`; frozen dataclass'ы `ProjectCatalog`, `NodeIndex`, `DocsApplyResult`. | S |
| Q-26 | неоптимально | средне | `routers/nodes.get_node_edges:633` (все узлы ради имён концов), `routers/processes.list_channels:942` (все связи), `routers/export.export_subtree:82-86` (все связи + фильтр в Python), `unified_apply._apply_merges:696-705` (запросы на каждую склейку) | → `in_`-фильтры в SQL, один запрос по всем поглощаемым. | S |
| Q-27 | мёртвый код | средне | `docs_import.py:38-40` | `MAX_LOGIC_PER_NODE`, `MAX_MERMAID_LEN`, `MAX_SPEC_LEN` — ни одной ссылки (проверено); лимиты живут в схемах, «≤100 схем на объект» не проверяется нигде. → удалить две; по `MAX_LOGIC_PER_NODE` — решить (подключить или снять). | S |
| Q-28 | мёртвый код | средне | `deps.require_project_owner` (`:110-113`) | В проде не вызывается (только тесты; owner-ручки идут через `project_for(need="owner")`), докстринг модуля её рекламирует. → удалить и поправить докстринг, либо перевести 7 owner-ручек на зависимость. | S |
| Q-29, Q-30, Q-31 | мёртвый код (слабый) | низко | `rate_limit.reset`, `mmd_header.is_empty`, `routers/processes._MESSAGE_REFS` — только тесты; relationship'ы `Node.outgoing_edges/incoming_edges/children`, `Project.nodes/edges/business_processes` — ни одного обхода (каскад идёт БД); параметры, которые никто не передаёт: `unified_into._cut(limit)`, `import_merge.merged_with_basis(limit)`, `demo.sandbox_stats(top)`, `demo.cleanup_loop(every_seconds)`, `admin.create_admin(prompt)` | → test seam или снять; relationship'ы задокументировать как страховку ORM либо убрать; параметры инлайнить (`prompt` — использовать в тестах). | S |
| Q-32, Q-34 | устаревшее | низко | `demo_package.py:16` (план в archive), `tree.py:3-4` (ссылка на снятый `get_node_context`), `docs_import.py:31-34,445-447` (объяснение цикла Q-4); локальные импорты без причины `deps.py:140`, `demo.py:257` | → поправить тексты, вынести импорты наверх. | S |
| Q-33 | побочный эффект импорта | низко | `demo_limits.py:418` `install()` на уровне модуля | Четыре слушателя Session вешаются при любом импорте и срабатывают (с ранним выходом) на каждом flush во всех поставках. → звать из `main.lifespan` при `demo_mode`. | S |
| Q-35 | строковый протокол | низко | `schemas/project.py:32` `start: str = "blank"` → `"copy:<uuid>"` разбирается в `routers/projects.py:689-707` | → `start: Literal["blank","copy"]` + `source_project_id` (меняет контракт — с согласия владельца, `gen:api`), минимум — `projects.parse_start`. | S |
| Q-36, Q-37 | несогласованность | низко | 404/409 — разные формы и тексты («Узел не найден» ×21, `f"Узел {id} не найден"` ×2, 8 формулировок CAS); роли литералами в 43 местах вне схем | → `app/errors.py` (`not_found`, `cas_conflict`); `StrEnum` ролей в `domain_types` (Q-5). | S |
| Q-38 | домен в роутере | низко | `routers/docs_import.py` `_name_catalogs`, `_entry_point_catalogs`, `_plan_from_files`, `_report` | → в `docs_prompt.py` / `docs_import.py`; `_report` исчезает с Q-5. | S/M |
| Q-39 | широкий except | низко | `demo_limits.dry_run_excess` (`:440-443`) `except Exception: after = None` | Баг в `apply_*` всплывает только при настоящем применении, превью молча теряет `demo_excess`. → ловить `(UnifiedImportError, DemoLimitExceeded, IntegrityError)`, остальное — log + raise. | S |
| Q-40, Q-41, Q-43, Q-44 | мелкие N+1 / идиомы | низко | `node_docs.get_doc:146` (`db.get` на уровень предков), `restore._restore_db_columns:242`, `docs_import.apply_docs_plan:880,897`, `tree.collect_subtree_ids_db` из мест, где `all_nodes` уже есть; `db.query(Node).filter(project_id==…).all()` — 34 вхождения в 19 файлах, `{n.id: n …}` ×8 при `processes.load_nodes`; `get_root_graph`↔`get_node_graph` одинаковый хвост; три блока `dry_run_excess` в `routers/projects.py:367,450,595` | → `tree.ancestors` поверх `load_nodes`; `graph_queries.project_nodes/node_map`; `_graph_for(...)`; `demo_limits.preview_excess(...)`. | S |
| Q-42 | god-модуль схем | низко | `schemas/node.py` 587 строк / 40 классов (CRUD, вид, граф, 15 классов алертов, distribute, transition) | → `schemas/alerts.py`, `schemas/view.py`, `schemas/transition.py` — перенос, `gen:api` не меняется. | S |
| Q-45, Q-46 | неоптимально / мёртвые данные | низко | `transition.cleanup_layout:112` — OR из N wildcard-LIKE по `item_id`; `graph_queries.py:69-71` фильтрует легаси-строки пучков `view_layout` на каждом чтении графа | → выборка по `view_id in subtree` + проверка в Python; одноразовая data-миграция `DELETE … WHERE item_id LIKE 'b:%'` (формат уточнить) и снять фильтр. | S |
| Q-47, Q-48, Q-49 | тесты | средне | `_node` объявлен в 21 тестовом файле (5 сигнатур), `_edge` в 9, `_doc` в 6; без прямых юнит-тестов: `node_ref.py` (358 строк алгебры адресов, 11 потребителей), `connectivity.py`, `context_graph.py`, `process_copy.py`, `archive_import.py`, `sync_apply.py` (политики только через HTTP); тесты зеркалят размеры модулей (test_import_merge 2755 строк) | → `tests/factories.py` (`make_node/make_edge/make_doc/make_table/make_channel`); `tests/test_node_ref.py` табличный; прямые тесты `apply_sync_plan`; при распиле Q-18 делить и тесты. | M |

Проверено — чисто: vulture-шум (`_text_bytes_*` — `@compiles`-хуки, `NOT_COPIED`/`SNAPSHOT_PLAN`/`NOT_IN_SNAPSHOT` — реестры сторожевых тестов, не трогать); мутабельных дефолтов 0 на 792 функции; голых `except:` 0; исключения как поток управления — только обоснованные (гонка upsert `view_state.py:51`, разбор UUID → 4xx); Alembic — один head, цепочка линейная; циклов импортов кроме Q-4 нет; `db.commit()` в циклах — только уборка демо; CAS-паттерн единообразен; промпт-модули — текст; неиспользуемых Pydantic-схем нет; 126 из 127 ссылок на планы в комментариях резолвятся.

Рекомендуемый порядок разведки (по отдаче на единицу риска): Q-1 → Q-4 → Q-2/Q-3 → Q-5 → Q-6/Q-20 → Q-7, Q-9/Q-10/Q-11, Q-15 → мелочь Q-27…Q-46 по одной правке в коммит.

### Б.7. Структура фронтенда: god-компоненты, дубли, React, типы (F — разведка «структура фронтенда»; пути от `frontend/src/`)

Сводка по god-компонентам (строки файла / тела; useState / useEffect / useRef):

| Компонент | Строк | Хуки | Ответственности (кратко) | Что вынести |
|---|---|---|---|---|
| LevelGraph (LevelGraphInner) | 1634 / 1442 | 8 / 14 / 25 (+7 useMemo, 22 useCallback) | RF-обёртка; тихое окно + конвейер (атомарно, не трогать); гистерезис + кэш маршрутов + уборка; три тоста «раз на вид»; занятость; тумблер подписей; история/клавиши; 6 драг-обработчиков; перевес конца; быстрая связь; дроп; даблклики; авто-фит; дальний зум; два тулбара | `useLevelAutoFit`, `useOncePerViewToast` + `CanvasNotice`, `useLevelRehang`, `useLevelDragLifecycle`, `useLevelHistory`, `useFarZoom`, `CanvasToolbars`; осторожно `useRouteMemory` (строго до computeNow) |
| NodePage (NodePageInner + SchemaSection) | 1562 / 933 + 242 | 24 / 5 / 6 | загрузка + предки по getAll; шапка; свойства с тремя дропдаунами; схема (свой хост персиста/поллинга); связи; процессы; три секции фактов; логика; OpenAPI; 6 модалок | `NodePropertiesCard` + `Dropdown`, `DescendantGroups<T>`, `LogicSection`, `OpenApiSection`, `DocRow`; SchemaSection → `useLevelSchema({load})` + `usePersistenceHost` |
| ProcessCanvas | 1436 / 1281 | 24 / 6 / 0 | загрузка+синк; производные; 16 мутаций с историей; 12 оверлеев с ручным Escape-стеком; тулбар; холст + 17 inline-колбэков | `useProcessDetail`, `useParticipant/Step/FragmentMutations`, `useOverlayStack`, `ProcessToolbar`, `Overlay` + `PromptCard`, `runMutation` |
| SequenceDiagram | 1400 / 1247 | 9 / 2 / 4 (22 пропса) | геометрия в теле рендера на каждый pointermove; 4 жеста + range-select; замер подписей; липкая шапка; 6 JSX-слоёв | `sequence/geometry.ts` (чистая, под useMemo, юнит-тесты без DOM), `useSeqGestures`, `useLabelHeights`, `useStickyHeader`, слои-компоненты; 22 пропса → ~7 бандлов |
| MapEditorPage | 969 / 877 | 27 / 9 / 7 (0 useCallback) | загрузка уровня + предки ×3; поллинг; ресинк/409; навигация; алерты/locate; 9 модалок; 9 команд истории; ручной GhostNode; бандлы LevelGraph | `useLevelLoader`, `usePersistenceHost`, `useEffectEvent`-колбэки (снимают 11 `eslint-disable`), `modal`-объединение, `pushCommand`, `ancestorPath` |
| NodeTreePanel | 806 / 505 | 15 / 5 / 5 | ленивое дерево; поиск; раскрытие до текущего; DnD-перенос; палитра + корзина; режим по форме пропсов | `useLazyNodeTree`, `useNodeSearch`, `useRevealCurrentNode`, `useTreeReparent`, `nodeTree.Palette`; явный `mode` |
| DemoTour (TourRuntime) | 487 / 380 | 4 + reducer / 15 / 11 | стейт тура + persist; маршрут; шина; restart/resume; пауза → пилюля; rAF-цикл на 147 строк (цель, команды, сигналы, анимация) | внешний `tourStore` + `useSyncExternalStore`, `useYarEnv`, `tourFrame.ts` (чистая `computeFrame`) + `useTourFrameLoop` |

| ID | Кат. | Важн. | Где | Суть → правка | Объём |
|---|---|---|---|---|---|
| F-1 | структура | высоко | `components/LevelGraph.tsx:181-1623` | Вырос с 1055 (конец фазы 3 прошлого плана, 0700eaf9) до 1634: бейдж занятости, невидимая уборка, кэш маршрутов, тихое окно/авто-фит, тумблер подписей, перевес конца, тосты, undo, дальний зум. Девять новых ответственностей, шесть выносятся без касания атомарного конвейера (сборщик 796–850 → computeNow 859–1041 → эффект раскладки 1051). → хуки по одному в коммит (см. сводку); характеризационные тесты levelGraph.* уже есть; пол ≈1150–1200. | L |
| F-2, F-3, F-18, F-36, F-39, F-63, F-65 | структура | высоко | `components/processes/ProcessCanvas.tsx` | 1281 строка тела, 24 useState; 12 оверлеев с ручным Escape-стеком из 11 строк приоритетов (комментарий уже неточен); каркас «мутация с историей» ×14 (`try { api; hist.push; reload() } catch { reload?; setError }` — где-то с reload в catch, где-то нет); 17 тернарников `editing ? cb : undefined`; `setError(null)` ни разу (ошибка висит до размонтирования); три «карточки с одним полем» и два ручных подтверждения при готовом `ConfirmDialog variant="card"`; сортировки/поиски ×5–6. → `useOverlayStack` (дискриминированное объединение), `runMutation`, бандлы пропсов, `Overlay`/`PromptCard`, `sortedMessages/fragById`; 6 characterization-тестов уже есть. | L |
| F-4 | структура | высоко | `components/processes/SequenceDiagram.tsx:97-1343` | Шапка обещает «чистый презентационный компонент», но геометрия (202–360) считается в теле на каждый рендер, т.е. на каждый pointermove; геометрия тестируется только DOM-селекторами. → `computeSeqGeometry` под useMemo + юнит-тесты. | L |
| F-5 | структура | высоко | `pages/NodePage.tsx:140-1073` | Карточка «Свойства» с тремя дропдаунами; группы потомков для доков и спек — одна структура дважды; разметка «строка-документ» повторена 7 раз при готовых константах `NodeDocsList.tsx:222`; `refreshNode` объявлен, но три `onApplied` переписывают его инлайном; `confirming` поднят во внешний компонент без причины. → см. сводку; пол ≈450 + 4 модуля. | L |
| F-6 | структура/react | высоко | `pages/MapEditorPage.tsx:67-944` | `load` — обычная функция, всё от неё зависящее тоже plain → `useMemo`-бандлы drill/edgeCallbacks/undo/persistence пересчитываются каждый рендер, а 11 `eslint-disable exhaustive-deps` это документируют; 9 состояний модалок; стартовый async-IIFE без alive; таймер тоста без очистки. → `useEffectEvent` (React 19.2 в проекте) или latest-ref для load/navigate/dispatch; `useLevelLoader`; `modal`-объединение; то же лечение NodePage:1422/1435, ProjectHomePage:60/73. | L |
| F-7 | структура | высоко | `components/NodeTreePanel.tsx:159-664` | Шесть ответственностей; режим по форме пропсов (`pagesMode = !!onNodePage`). → пять хуков + явный `mode`; остаток ≈200. | L |
| F-8, F-55 | структура/react | высоко | `components/tour/DemoTour.tsx:108-487` | rAF-цикл 147 строк с побочными командами и `send` в редьюсер; `useLayoutEffect(() => setTourPaused(paused))` — зеркало стейта во внешний стор ради одного читателя; `onTourRestart(fetchMe().then(...))` без alive при ремаунте по key; три эмиттера. → настоящий `tourStore` + `useSyncExternalStore`, чистая `computeFrame`; DemoTour ≈150 строк. | L |
| F-9 | дублирование | высоко | `docsImport/ChannelsAgentModal.tsx` ↔ `DataAgentModal.tsx` ↔ `ConfigAgentModal.tsx` (+ Recon, Spec, Docs, SyncRepo) | Семь окон агента созданы копированием (Channels↔Data — 83 различающихся строки из ~270); общий `AgentPackageInput` вынесен, но подключён к 2 окнам из 6; у ConfigAgentModal нет теста. → шаг 1: подключить `AgentPackageInput` в 4 окна (−190); шаг 2: `useAgentPackageFlow<TReport>` + `AgentModalShell` + `FactAgentModal` с тремя конфигами (сначала тест ConfigAgentModal). Нетто −650…750 строк. | L |
| F-10, F-11, F-12, F-26 | дублирование | высоко | `pages/MapEditorPage.tsx`, `pages/NodePage.tsx` (SchemaSection), `pages/ProjectHomePage.tsx`, `pages/useLevelSchema.ts`, `embed/LandingSchema.tsx`, `EmbeddedSchemaBlock.tsx` | Хост персиста схемы (resyncingRef, 409-переигровка, retryPatch, бандл persistence) написан трижды с тремя `eslint-disable`, хотя `useLevelSchema` с этим содержимым существует и используется одной страницей из трёх; merge зеркала раскладки — четырежды в двух идиомах; обход предков по `nodesApi.getAll()` — четырежды (тянет весь список узлов ради хлебных крошек; ручная сборка `GhostNode` рядом с projection.ts); `resolveEdge`/`labelOf`/`linkedHighlight` ×3–5. → `useLevelSchema({ load })` + `usePersistenceHost`; `mergeViewLayout` (+ тест); `ancestorPath` (лучше — `GET /nodes/{id}/ancestors` на бэке); `useEdgeChoice` сам строит resolve/label. | M |
| F-13 | дублирование | высоко | `DbStructureSection.tsx` ↔ `BrokerChannelsSection.tsx` ↔ `ConfigParamsSection.tsx` (+ `dbStructure.css` ↔ `brokerChannels.css`) | 151–203 одинаковые строки из ~480 (`freeName`, `GroupBody`, эффект list+usage с alive, apply с limitMessage); CSS — 147 общих строк из ~220; ChannelCard 203 строки. → `useFactRows<T>`, `FactSection`, `GroupedList`, `UsageList`, один `factRows.css`; тесты всех трёх секций есть. | L |
| F-14, F-15 | дублирование | высоко | `inspector/NodeInspector.tsx:77-173` ↔ `pages/useNodePatch.ts:95-186`; `inspector/EdgeInspector.tsx` ↔ `EdgeEditModal.tsx`; `EdgeQuickCreate.tsx` ↔ `CrossLevelEdgePicker.tsx` | `useNodePatch` объявлен «вынесен из NodeInspector», но сам инспектор на него не переведён (сборка `NodeUpdate` с base_version, ветка 409 — дважды); разметка полей связи и форма создания связи написаны дважды. → `useNodePatch(initial, onSaved)`; `inspector/EdgeFields.tsx`, `useEdgeCreate`, `metaIcons.tsx`. | M |
| F-16 | дублирование | высоко | `project/CreateProjectDialog.tsx` ↔ `ImportIntoModal.tsx`; `ImportPane.tsx` | Машинерия ответов разбора (conflicts, pruneAnswers, buildQuestions) — дважды дословно; `ImportReport` ↔ `ApplyReport` 20 строк из 45; документы ввоза — два параллельных массива `docs`/`docNames`, синхронизируемых вручную (чипы ключуются индексом). → `useRemainderAnswers`, `ImportResultReport`, `ImportDoc = { id, text, name }[]`. | M |
| F-17 | дублирование | высоко | `pages/useToast.ts`, `ProjectsPage.tsx:51,73`, `UsersPage.tsx:40,59`, `SchemaActions.tsx:62`, `demo/useDemoLimitToast.ts`, `MapEditorPage.tsx:102,909`; стили ×5; `setCopied` ×7 | Пять механик тостов (`flash` с setTimeout без очистки ×2, таймер без cleanup), пять копий стиля, семь копий «скопировано» при правильной реализации в PromptCopyButton. Пункт плана 2026-08 «remoteToast ×4» не закрыт. → `ui/useToast<T>(holdMs)`, `useCopiedFlag`, один `<Toast tone>`. | S/M |
| F-19, F-20, F-21 | дублирование | средне | «клик вне + Escape» ×12 четырьмя механизмами (SchemaAlerts, SchemaLegend, SchemaActions, ProjectSwitcher, ProfileMenu, ProjectCard, ProcessRail, ObjectCombobox, EmbeddedSchemaBlock, InfoPopover, backdrop-div в AddDocsMenu/NodeInspector/NodePage); заголовок модалки ×13, футер ×7, `errText` ×9 вне `ui/*` (`ui/styles.ts` объявляет правило «≥2 окон → сюда»); порядок кнопок разъехался (главная слева в 6 окнах, «Отмена» слева в 5); автомат busy/error/run ×8 | → `ui/useDismiss`, `Modal title/subtitle`, `ui/DialogFooter`, `ConfirmDialog tone`, `ui/useBusyAction`. Кластер ConfirmDialog из плана 2026-08 закрыт, хвост — `ProjectDialogs`. | S/M |
| F-22, F-29 | дублирование | средне | `SHAPE_LABEL` ×3 (NodePage:1191, NodeInspector:421, questionText.ts:31 — уже разошлись: «Брокер» vs «Брокер сообщений»), `STATUS_ORDER` ×3, `KIND_LABEL` ×2; локальные копии иконок ×7 (`Dots`↔`IcoDots`, `RailChevron`↔`CollapseIcon`, `IcoCheck`↔`CheckIcon` с неверным комментарием «в icons.tsx чека нет», три `Chevron`), текстовые глифы вопреки правилу `ui/icons.tsx:3` | → словари в `types/index.ts` рядом с `canHaveChildren`; импорт из `ui/icons`. | S |
| F-23, F-24, F-25, F-27, F-28, F-33, F-34 | дублирование | средне | ручной pub/sub ×9 (tourBus, tourStore, client, auth); поллинг `ProcessWorkspace` ↔ `useRemoteSync` почти посимвольно; `fnv1a` ×3, `djb2` ×2, геометрия прямоугольников ×8 (`clip` ≡ `intersect` байт-в-байт), `prefersReducedMotion`/`lerp`/`easeInOut` ×3; стили страниц page/topBar/bodyRow ×2–4 (пункт 2026-08 не закрыт); персист предпочтений двумя идиомами; три сырых `fetch` в `api/auth.ts` мимо общего клиента с тремя разборами ошибки; `dbTablesApi/brokerChannelsApi/configParamsApi` и три `*ImportApi` — одинаковые методы | → `lib/emitter.ts`, третий курсор в `createRemoteSyncTick`, `graph/layout/rect.ts` + `lib/hash.ts` + `lib/motion.ts`, `ui/pageChrome.ts`, `useLocalPref`, `request(path, { auth, form })`, `factApi(segment)`/`importFamilyApi`. | S/M |
| F-30, F-31, F-32 | дублирование | средне | сегмент «синхронный/асинхронный» в MessageCard ↔ `SyncSegmented`, причём переключение из композитора не попадает в Undo (поведенческое расхождение — уточнить у владельца); стили ввоза ×2, панель «Язык/Подсказки/Промпт» тремя виджетами, предел размера файла тремя способами (3 МБ отвергается при перетаскивании, но принимается через «Загрузить файлы…» и падает на сервере); сцена пан/зума ErDiagramModal ↔ FlowchartDoc дословно | → `onSetChannelSync` с историей; `fileLimits.ts: rejectFile/rejectText`; `DiagramStage`, `ShowCodeButton`, `AgentStage`. | S/M |
| F-35 | структура | средне | `components/SchemaAlerts.tsx:100-424` | 15 классов рекомендаций описаны тремя несвязанными списками (деструктуризация, сумма из 15 слагаемых, 15 `<Section>`); забытое слагаемое не проявится. → data-driven `ALERT_SECTIONS[]`; ≈150 строк вместо 468. | M |
| F-37, F-38, F-40 | структура | средне | `useContainerChildren` в NodeInspector ради одной строки тянет getDescendants и считает группы впустую; `tourMachine.ts` разбирает localStorage (чужая ответственность), `TourLayer.tsx` 391; `DocsAgentPanel.removeFile` при снятии последнего файла не чистит `edits` — новый пакет с файлом того же имени унаследует чужой override (вероятно) | → `useDescendants` + селекторы; `tourPersist.ts`, `TourCard.tsx`; `removeFile` → `clearPackage()`. | S |
| F-41, F-43, F-44, F-45, F-46, F-47, F-48 | мёртвый код | средне | knip-вердикты: мёртво целиком — `MoreIcon`, `ExportIcon`, `RepoSyncIcon`, `CTX_LABEL_W/MIN_SHELF/SHELF_PAD` (остатки контекст-движка), `withoutPersons`, `LegLegend.tsx`, `StatusLegend`, `IcoChevron/IcoExport` (а `IcoDots`/`TechChip` — мертвы при живых inline-копиях: удалять копии); лишний `export` — ~20 символов (список в Б.5); особые: `LinkedHighlight`, `intersect`, `PlacedIndex`, `METRIC_LABELS` (ложное: используется `scripts/route-quality.ts`), фасад `remainder/index.ts` (6 функций + 7 типов никто не берёт). Не пойманное knip: `pageSchema.componentsSectionHeight` (жива только своим тестом; секции нет), 15 алиасов `types/index.ts` без потребителей, ≈200 строк CSS-сирот с датами осиротения (`.lg-edge-leader`, `.insp-docrow*`, `.np-status-badge`, `.bp-*` ×9, dark-mode шаблона Vite…), `public/icons.svg` (спрайт шаблона), `@types/js-yaml` (js-yaml 5 несёт типы), непрочитанные `frameCounter`, проп `mode` в RemainderBlock, `label`/`clear` в useProcessHistory, `META_ICON.flow/.api`, `Section.grow`; комментарии «TreePage» ×10, битая ссылка `docs/plan-arrows-ports.md` ×4, ссылки на удалённые компоненты процессов, дважды вставленный комментарий MapEditorPage:575–580; ветки, невозможные по типам (`NodePage.tsx:1210` обе ветви одинаковы, `useEdgeConnect.ts:195`, `EdgeChoiceModal`). → гигиена одним-двумя коммитами; `scripts` в entry knip. | S |
| F-42 | инструменты | средне | `frontend/scripts/replay-prof.ts`, `route-quality.ts` | `vite-node` отсутствует в зависимостях (vitest 4 не тянет) → документированный запуск не работает (≡ P-21). | S |
| F-49, F-50, F-51, F-52, F-53, F-54, F-56, F-57, F-58 | react-антипаттерн | средне | async без alive/seq ×8 (`ProjectSwitcher`, `ProjectAccessDialog` ×2, `DemoTour:207`, `MapEditorPage:173`, два одинаковых GET-эффекта `ProcessCanvas:134-151` срабатывают оба на ремаунт, оптимистичный setDetail без упорядочивания); `setState` внутри апдейтера другого стейта (`useDocsFiles.ts:52-60`, нарушает чистоту апдейтера в StrictMode); `useProcessHistory` возвращает новый объект каждый рендер → document-keydown перевешивается на каждый рендер; `NodeSearchPicker` cleanup снимает только таймер (поздний ответ перетирает результаты; вторая реализация в NodeTreePanel с другим интервалом); ref-колбэк без cleanup и rAF без отмены (`SequenceDiagram:177`, `useCollapse`, `useFlipRows`); hover через стейт ради inline-стилей (ререндер карточки с SchemaPreview на наведение); неуправляемые инпуты колонок/полей без ключа сброса (после 409 строка показывает отвергнутый текст); объекты-литералы в пропсах `<ReactFlow>` каждый рендер (`fitViewOptions` отслеживается стором RF, `multiSelectionKeyCode` переподписывает keydown); `key={bi}` у ветвей фрагмента с CSS-transition. → `useAsyncResource` (закрывает и кластер `set-state-in-effect`), `useReducer` для файлов, useMemo-объект истории, `useNodeSearch` с guard, cleanup из ref-колбэка (React 19), CSS `:hover`, `key` с version, модульные константы RF-пропсов, `${f.id}:${b.row}`. | S каждая |
| F-59, F-60, F-61, F-62 | типы | средне | 10 диагностических глобалов через 11 `as unknown as` с двумя конвенциями имён и копией типизации в `scripts/replay-prof.ts`; пять ручных копий входных схем генерата (`DocsFile` ≡ `DocsFileIn`, `SyncPolicies` ≡ `Pick<SyncApplyIn>`, …) — правило «типы контракта генерируются» нарушено; `LinkedHighlight`/`NavigateMap`/`LayoutPatch`/`ViewMetaRef`/`StepDoc`/`DelLink` переписаны инлайном 4–13 раз; выключенный `noUncheckedIndexedAccess` — 78 «невозможных» гвардов в движке и 21 `!`-disable как две стороны одного флага | → `graph/layout/diag.ts` с `declare global`; алиасы `*In` в `types/index.ts`, API принимает snake_case напрямую; общие типы в `graph/types.ts`; минимум `mustGet(map, key)` (21 disable уходят), желательно `noUncheckedIndexedAccess: true`. | S / M |
| F-64, F-66, F-67, F-68, F-69, F-70, F-71, F-72 | низко | низко | каркас истории `useProcessHistory` ↔ `useHistory` (~25 строк, без тестов у process-варианта); предел демо в модалках тремя способами; сброс сессии в `App.tsx` трижды; `fkOptions`/`grouped` без useMemo; фасад remainder; лишние `eslint-disable` (`ProcessWorkspace:86`) и `excludeIds={new Set(...)}` каждый рендер родителя; утечка класса `esb-edit` в NodePage/ProjectHomePage; гварды над индексным доступом вне движка (закроются флагом) | → `createAsyncHistory`, `useLimitRefusal`, `resetSession(notice)`, `useMemo`, сузить фасад, снять disable, общий класс. | S |

Оценка `eslint-disable` (из разведки): «оркестрационный колбэк plain-function» ×15 (MapEditorPage, NodePage, ProjectHomePage) — не оправданы как постоянное решение, лечатся `useEffectEvent`/latest-ref + `usePersistenceHost`; `set-state-in-effect` на загрузке ×6 — симптом отсутствия `useAsyncResource`; reset-on-prop-change (useLevelDrill 129/182, useTemplateDrop 65) — законно, но заменяется `key`-ремаунтом или adjust-during-render; по значению (LevelGraph 698/1041, useLevelDrill 166) — оправданы; `no-non-null-assertion` ×21 — механически снимаются `mustGet`.

Проверено — чисто: компонентов внутри компонентов 0; `nodeTypes/edgeTypes` только модульные; все 7 `JSON.parse` в try; контексты не перерисовывают дерево зря; `tsc -b` 0 ошибок; `depcheck` чист; чистые и покрытые тестами: useRemoteSync, useToast, useSchemaAlerts, useContainerChildren, pageSchema, useHistory, useLevelPersistence, useEdgeChoice, EmbeddedSchemaBlock, ui/Modal, ConfirmDialog, InfoPopover, PromptCopyButton, useFileDrop/useDocsFiles, remainder/*, sequence/layout, fromDetail, stepDoc, api/client; alive-флаги в 15 местах; зеркалирования пропсов в стейт эффектом (кроме F-55) нет; все объявленные пропсы читаются (кроме F-46); ссылки на `docs/*.md` в ≈60 файлах существуют (кроме F-47); движок `graph/layout/*` по размеру не судился.
