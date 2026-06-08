# Фаза 4 — Замена кастомного движка раскладки на ELK (elkjs)

> **СТАТУС (2026-06-08): 4.0–4.2 СДЕЛАНЫ (level на ELK). 4.3 ОТМЕНЁН — context
> остаётся на bespoke `computeContextLayout` (ELK там неуместен, см. шаг 4.3).
> Осталось 4.4: снять `@dagrejs/dagre` + `computeLayout` (dagre), почистить осиротевшее.**
> Перед продолжением прочитать: этот файл + `REFACTOR_PLAN.md` (общий контекст и Фазы 0–5)
> + память `levelgraph-refactor-plan`. Проверить зелёное дерево:
> `cd frontend && npx tsc -b && npm test` (20 тестов) и
> `cd backend && venv/bin/python -m pytest` (7 тестов).
> **ВАЖНО: после `git commit` bash-cwd сбрасывается в корень репо — перед след.
> `tsc`/`npm` делать `cd frontend`.**

## Цель и зачем

Удалить ~400 строк хрупкой ручной геометрии, отдав раскладку профильной библиотеке
(ELK, `elkjs`). Главный кандидат на удаление — `graph/layout/context.ts` (299 строк
звёздной frame-aware геометрии: колонки, полки, обходы, кольца) и `roundedPolyline`
в `edges.tsx`. `computeLayout` (level) проще — там dagre, замена даёт меньше выигрыша,
но убирает вторую layout-зависимость.

## Карта текущего движка (что меняем)

| Файл | Строк | Что делает | Судьба в Фазе 4 |
|------|-------|------------|-----------------|
| `graph/layout/level.ts` | 105 | `computeLayout` (dagre LR + override saved-pos) + `autoHandles` (хэндлы по взаимному положению) | dagre → ELK `layered`; `autoHandles` ПОКА оставить (чистая ф-я от позиций) |
| `graph/layout/context.ts` | 299 | `computeContextLayout` — РУЧНАЯ звезда: классификация in/out/bidi, колонки с frame-clearance, полки (`edgeShelves`), обходы bidi (`edgeLoops`) с кольцами | ELK + `edgeRouting:ORTHOGONAL`; **самый крупный снос** |
| `graph/edges.tsx` | 139 | `WrappedLabelEdge`: `roundedPolyline` (обход), `getSmoothStepPath` (полка/дефолт), рендер подписи | `roundedPolyline`+shelf/loop-геометрия → bend-точки ELK |
| `graph/boundaries.tsx` | 161 | `LevelBoundary` — bbox рамок ПОСЛЕ раскладки (чистая презентация по позициям) | можно ОСТАВИТЬ как есть; ELK compound-узлы — опционально (4.3) |
| `graph/constants.ts` | — | `SIDE_HANDLES`, `hid`, паддинги рамок, `MIN_SHELF`/`SHELF_PAD` | shelf/loop-константы удалить в конце, если осиротеют |

**dagre (`@dagrejs/dagre`) реально используется ТОЛЬКО в `level.ts`** (в `context.ts`,
`text.ts`, `LevelGraph.tsx` слово «dagre» — только в комментариях). Удаляется в 4.4.

## Что НЕ трогаем (остаётся доменным, под тестами)

- `projectGhosts` — проекция/сворачивание гостей (вход раскладки).
- Слияние параллельных связей в мастер-стрелку (в `LevelGraph` useMemo).
- **Персист**: override saved-pos / saved-handles поверх дефолта ELK; ручной drag
  архитектора по-прежнему перетирает и сохраняется (`useSnapAlignment`).
- expand/collapse контейнеров.

## ⚠️ Главный архитектурный риск: ELK асинхронный

`elk.layout()` возвращает **Promise**. Сейчас `computeLayout`/`computeContextLayout`
**синхронные**, зовутся внутри `layout = useMemo(...)` в `LevelGraph.tsx` (результат
Фазы 3). Переход на ELK ломает синхронность → нужно:
- Заменить `useMemo`-раскладку на **async-эффект со стейтом и отменой**:
  ```
  const [layout, setLayout] = useState<LayoutResult | null>(null);
  useEffect(() => {
    let cancelled = false;
    layoutEngine(inputs).then((r) => { if (!cancelled) setLayout(r); });
    return () => { cancelled = true; };  // отбрасываем устаревший результат
  }, [/* те же data-deps, что у нынешнего useMemo */]);
  ```
- **Re-verify Фазы 3:** драг не должен отскакивать. ELK перезапускается только при
  смене data-deps (не при драге), поэтому интерактив сохраняется — но проверить
  headless обязательно (см. Verification). Появляется «мигание» между сменой входа
  и резолвом ELK (layout пуст/старый) → решить: держать предыдущий layout до резолва
  (не сбрасывать в null) или показать пустоту. Рекомендация — держать предыдущий.

## Декомпозиция на подзадачи (снизу вверх, каждая = зелёное дерево + коммит)

### Шаг 4.0 — Подготовка (без смены поведения) — ✅ СДЕЛАНО (2026-06-08)
- Установить `elkjs` (`npm i elkjs`). Замерить прирост бандла, отметить в плане.
- Спайк в изоляции: поднять ELK `layered` на тривиальном графе (3 узла, 2 ребра),
  убедиться, что работает в node И в vitest/jsdom (ELK через Web Worker ИЛИ main-thread
  `new ELK()` без воркера — для тестов нужен main-thread). Решить и зафиксировать.
- Объявить **адаптер** `graph/layout/engine.ts` с async-функциями, возвращающими ТОТ ЖЕ
  контракт, что сейчас (`{positions, edgeHandles}` и `{...edgeShelves, edgeLoops}`),
  чтобы потребители (`LevelGraph` useMemo) пока не менялись по форме данных.
- Коммит: добавлена зависимость + пустой адаптер + спайк-тест.

> **Итог 4.0:** `elkjs@0.11.1` поставлен. **РЕШЕНО:** импорт `elkjs/lib/elk.bundled.js`
> (main-thread, без Web Worker) — работает и в браузере (Vite), и в тестах (jsdom);
> дефолтный entry тащит Worker и в jsdom не заводится. Адаптер `graph/layout/engine.ts`:
> `getElk()` (ленивый синглтон) + `layoutLevel`/`layoutContext` (async, пока делегируют
> синхронным `computeLayout`/`computeContextLayout` через `Promise.resolve`). Спайк-тест
> `__tests__/engine.test.ts` (2 теста: ELK раскладывает layered-граф в jsdom; адаптер
> сохраняет контракт). Дерево зелёное: tsc=0, 20 тестов (18+2). **Бандл:** main-chunk
> `index` пока не вырос (1040.98 kB / 284 kB gzip) — elkjs импортится только тестом, app
> ещё не зовёт адаптер, tree-shaking исключает. Сырой `elk.bundled.js` = 1.57 MB / 458 kB
> gzip (до минификации Vite); реальную цену в бандле замерить на 4.1/4.2 при подключении.

### Шаг 4.1 — Async-интеграция в LevelGraph (ещё на старом движке!) — ✅ СДЕЛАНО (2026-06-08)
- Перевести `layout = useMemo` → async-эффект со стейтом и отменой (см. раздел выше),
  но ВНУТРИ пока звать существующие синхронные `computeLayout`/`computeContextLayout`
  (обёрнутые в `Promise.resolve`). Поведение не меняется — это чисто инфраструктурный
  шаг, чтобы async-канал был готов и проверен ДО подмены движка.
- Verify headless: рендер, **драг-без-отскока**, выделение, 0 ошибок. Это контрольная
  точка изоляции async-риска от ELK-риска.
- Коммит.

> **Итог 4.1:** `layout` стал стейтом (`useState<LayoutResult|null>`), считается в
> async-`useEffect` с `cancelled`-отменой (отбрасывает устаревший результат). Внутри —
> те же `await layoutLevel`/`layoutContext` из адаптера (пока старые синхронные движки).
> Предыдущий layout держим до резолва (null только на первом рендере) — нет мигания.
> Потребляющий эффект сборки RF-узлов получил guard `if (!layout) return;`. Тип
> `LayoutResult` объявлен на уровне модуля. **Verify headless (level/TreePage):**
> NODES=3, EDGES=2, **DRAG dx=117 dy=81, DRAG_STAYED=true (драг НЕ отскакивает)**,
> SELECTED=1, CONSOLE_ERRORS=0. tsc=0, 20 тестов. Async-риск изолирован и снят ДО ELK.
> NB: тело async-IIFE оставлено на прежнем отступе (валидно, tsc зелёный) — переиндентацию
> 140 строк не делал, чтобы не вносить риск опечатки в инфраструктурный шаг.

### Шаг 4.2 — Level-режим на ELK — ✅ СДЕЛАНО (2026-06-08)
- В адаптере реализовать `layoutLevel` через ELK `layered`, `elk.direction:"RIGHT"`,
  размеры узлов `NODE_W×NODE_H`, `ranksep≈120/nodesep≈60` (как у dagre сейчас).
- Хэндлы: ПОКА оставить `autoHandles` (считается от позиций ELK — функция уже чистая).
  ELK-порты с `portConstraints` — отдельная поздняя оптимизация, не в этом шаге.
- Override saved-pos применять ПОСЛЕ ELK (как сейчас).
- **Тесты:** `computeLayout`-тесты (`level.ts`) — ассерты saved-pos и edgeHandles
  переживут (override + autoHandles сохранены); точные dagre-координаты не
  ассертятся. Проверить, что менять почти нечего.
- Verify headless (level-режим: TreePage). Коммит.

> **Итог 4.2:** `layoutLevel` реализован через ELK `layered`/`direction:RIGHT`,
> `nodeNodeBetweenLayers:120`/`spacing.nodeNode:60`/`padding:30` (≈ dagre). ELK отдаёт
> позиции верхним-левым углом — ровно как ждёт RF (dagre отдавал центр, конвертировали).
> Логику хэндлов вынес из `computeLayout` в общую **`assignEdgeHandles`** (level.ts) —
> переиспользуется ELK-движком и dagre-`computeLayout`, поэтому `computeLayout`-тесты
> прошли БЕЗ изменений (по-прежнему dagre под капотом; удалится в 4.4). saved-pos
> override — после ELK. **Бандл:** ELK = 435 kB gzip — статический импорт раздул бы
> главный чанк (284→719 gzip). РЕШЕНО: `getElk()` через **динамический `import()`** →
> Vite вынес ELK в отдельный ленивый чанк `elk.bundled-*.js` (441 kB gzip), главный
> `index` = 276 kB gzip (= baseline, ELK грузится по требованию при открытии графа).
> `getElk()` стал async (промис-синглтон). Verify headless (level): NODES=3, EDGES=2,
> DRAG dx=117 dy=81 DRAG_STAYED=true, SELECTED=1, CONSOLE_ERRORS=0. tsc=0, 20 тестов.

### Шаг 4.3 — Context-режим на ELK — ❌ ОТМЕНЁН (2026-06-08), context остаётся bespoke
**Решение (после спайка + показа пользователю):** контекст-схему НЕ переводим на ELK.
Сработал задокументированный «Откат» (см. ниже): спайк ELK `ORTHOGONAL` был реализован
и показан, но он:
1. **выбросил все фишки** схемы — фиксированные хэндлы, обходы bidi (`edgeLoops`),
   полки подписей (`edgeShelves`) (адаптер вернул пустые `Map` → дефолтный smoothstep);
2. **моргал в статике** — но это оказалось НЕ виной ELK-как-движка, а общим следствием
   async-эффекта раскладки (шаг 4.1) на нестабильных пропсах модалки; чинится гигиеной
   эффекта, не движком.

**Главный вывод:** контекст-схема — это НЕ задача авто-раскладки, а *предписанная*
геометрия (звезда фокус↔соседи, диктуемая нашими правилами). `computeContextLayout`
(`context.ts`) — корректная реализация спека, а не костыль вокруг отсутствующего
движка. Поставить ELK под неё = запустить ELK и пост-процессингом навязать наши правила
обратно = костыль ГЛУБЖЕ прежнего. Поэтому ELK сужен до level-режима (где он честно
заменяет dagre — настоящая авто-раскладка иерархии).

**Что сделано по факту:** `git checkout engine.ts` → `layoutContext` снова делегирует в
`computeContextLayout` (состояние 4.1, все фишки на месте). Плюс не относящиеся к ELK
правки: (а) `nodesDraggable={!isContext}` — контекст read-only (drag ничего не сохранял
и только отщёлкивал узел назад); (б) стабилизация входов раскладки (мемоизация
`nodes`/`edges`/`levelPositions` в `NodeContextModal`, стабильный дефолт
`levelEdgeHandles` в `LevelGraph`) — устранение миганий async-эффекта. tsc=0, 20 тестов.

**Не делаем:** снос `edgeShelves`/`edgeLoops`/`roundedPolyline`, переписывание
`computeContextLayout`-тестов на инварианты — всё это остаётся как было.

### Шаг 4.4 — Снять dagre + чистка
**ВАЖНО (после отмены 4.3):** `context.ts`, `edgeShelves`/`edgeLoops`/`roundedPolyline`,
типы `EdgeShelf`/`EdgeLoop`, shelf/loop-константы — **ОСТАЮТСЯ** (context на bespoke их
использует). Сносить НЕЧЕГО из контекст-геометрии.
- `LevelBoundary` оставить как есть (читает позиции — дёшево и работает); ELK
  compound-узлы не вводим.
- **Снять dagre:** `computeLayout` (level.ts) сейчас всё ещё на dagre, хотя level
  раскладывается ELK-`layoutLevel`. Проверить `ts_references` на `computeLayout` — если
  его зовёт только `__tests__/level.ts`-тест, переписать тест на `layoutLevel` (async,
  ELK) или на чистую `assignEdgeHandles`, затем удалить `computeLayout` и
  `import Dagre`/`@dagrejs/dagre` из зависимостей.
- Обновить `spec.md`/`tasks.md`/`REFACTOR_PLAN.md`/память. Коммит.

## Verification (после КАЖДОГО шага)

- `cd frontend && npx tsc -b` = 0 ошибок.
- `npm test` — зелёный (на 4.3 — после переписывания координатных ассертов на инварианты).
- Headless-прогон (рецепт в памяти `ui-verification-headless`; либы в `/tmp/libs`,
  Playwright в npx-кэше, токен через `create_access_token`): рендер узлов/рёбер,
  **драг-без-отскока** (главный регресс-риск async), клик-выделение, 0 консольных ошибок.
  Скрипт-образец — `/tmp/verify.mjs` (если стёрт — пересоздать по заметке).
- На 4.3 — отдельно открыть контекст-схему узла (NodeContextModal) и сверить визуал.

## Навигация по коду (LSP, не grep)

Как в Фазе 2: `mcp__typescript-lsp__ts_references` на символе для поиска всех ссылок,
`ts_definition`/`ts_hover` для определений/типов. `Read` — для захвата диапазона.
Гейт типов — `npx tsc -b`, не `ts_diagnostics`.

## Откат

Каждый шаг — отдельный коммит. Если шаг 4.3 даёт неприемлемый визуал и опции ELK не
спасают — откатить ТОЛЬКО 4.3 (`git revert`), оставив 4.0–4.2 (level на ELK + async-
канал), и зафиксировать в плане, что context-режим остаётся на ручной геометрии.
То есть level и context развязаны адаптером — можно мигрировать частично.
