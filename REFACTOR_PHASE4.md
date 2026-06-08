# Фаза 4 — Замена кастомного движка раскладки на ELK (elkjs)

> **СТАТУС (2026-06-08): НЕ НАЧАТА. Это план для старта с чистого контекста.**
> Перед началом прочитать: этот файл + `REFACTOR_PLAN.md` (общий контекст и Фазы 0–5)
> + память `levelgraph-refactor-plan`. Проверить зелёное дерево:
> `cd frontend && npx tsc -b && npm test` (18 тестов) и
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

### Шаг 4.0 — Подготовка (без смены поведения)
- Установить `elkjs` (`npm i elkjs`). Замерить прирост бандла, отметить в плане.
- Спайк в изоляции: поднять ELK `layered` на тривиальном графе (3 узла, 2 ребра),
  убедиться, что работает в node И в vitest/jsdom (ELK через Web Worker ИЛИ main-thread
  `new ELK()` без воркера — для тестов нужен main-thread). Решить и зафиксировать.
- Объявить **адаптер** `graph/layout/engine.ts` с async-функциями, возвращающими ТОТ ЖЕ
  контракт, что сейчас (`{positions, edgeHandles}` и `{...edgeShelves, edgeLoops}`),
  чтобы потребители (`LevelGraph` useMemo) пока не менялись по форме данных.
- Коммит: добавлена зависимость + пустой адаптер + спайк-тест.

### Шаг 4.1 — Async-интеграция в LevelGraph (ещё на старом движке!)
- Перевести `layout = useMemo` → async-эффект со стейтом и отменой (см. раздел выше),
  но ВНУТРИ пока звать существующие синхронные `computeLayout`/`computeContextLayout`
  (обёрнутые в `Promise.resolve`). Поведение не меняется — это чисто инфраструктурный
  шаг, чтобы async-канал был готов и проверен ДО подмены движка.
- Verify headless: рендер, **драг-без-отскока**, выделение, 0 ошибок. Это контрольная
  точка изоляции async-риска от ELK-риска.
- Коммит.

### Шаг 4.2 — Level-режим на ELK
- В адаптере реализовать `layoutLevel` через ELK `layered`, `elk.direction:"RIGHT"`,
  размеры узлов `NODE_W×NODE_H`, `ranksep≈120/nodesep≈60` (как у dagre сейчас).
- Хэндлы: ПОКА оставить `autoHandles` (считается от позиций ELK — функция уже чистая).
  ELK-порты с `portConstraints` — отдельная поздняя оптимизация, не в этом шаге.
- Override saved-pos применять ПОСЛЕ ELK (как сейчас).
- **Тесты:** `computeLayout`-тесты (`level.ts`) — ассерты saved-pos и edgeHandles
  переживут (override + autoHandles сохранены); точные dagre-координаты не
  ассертятся. Проверить, что менять почти нечего.
- Verify headless (level-режим: TreePage). Коммит.

### Шаг 4.3 — Context-режим на ELK (самый рискованный)
- Реализовать `layoutContext` через ELK с `edgeRouting:"ORTHOGONAL"`. Звезда фокус↔соседи
  раскладывается ELK; bend-точки рёбер берёт RF из ELK (через кастомный edge, читающий
  ELK-секции, ИЛИ через RF smoothstep по ELK-позициям).
- **Снос геометрии:** `edgeShelves`/`edgeLoops`/`roundedPolyline` + ветки `if(loop)`/
  `if(shelf)` в `edges.tsx` уходят, если ELK-роутинг даёт приемлемый визуал. Подписи
  (перенос/cap по ширине) — оставить.
- frame-clearance (приватные рамки фокуса не пересекаются соседями): см. 4.4 —
  либо ELK compound-узлы, либо ELK `partitioning`/`layering` + padding.
- **Тесты:** `computeContextLayout`-тест — точный `positions.get("f")===(0,-50)` и
  завязки на shelves/loops ПЕРЕПИСАТЬ на инварианты (out.x>0, in.x<0, нет NaN, нет
  наложений bbox, фокус между колонками). Инвариантные ассерты (235–249) переживут.
- **Визуал контекст-схемы изменится** — это НЕ косметика, нужен глаз пользователя
  (показать до/после, согласовать). Verify headless + ручной показ. Коммит.

### Шаг 4.4 — Вложенные рамки + чистка (опционально по рамкам)
- Если frame-clearance в 4.3 не вышел опциями — перевести `LevelBoundary` на ELK
  **compound-узлы** (родитель обнимает детей паддингом). Иначе `LevelBoundary`
  оставить как есть (он просто читает позиции — дёшево и работает).
- Удалить `@dagrejs/dagre` из зависимостей. Удалить осиротевшее: `roundedPolyline`,
  типы `EdgeShelf`/`EdgeLoop` (если не используются), shelf/loop-константы.
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
