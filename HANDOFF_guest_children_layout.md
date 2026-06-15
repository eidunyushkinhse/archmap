# Handoff: раскладка детей раскрытых гостевых рамок + живой якорь

Реализация ТЗ «раскладка детей раскрытого гостя + живая привязка рамки к родителю»
(D1–D8). Шаги 1–3 СДЕЛАНЫ и закоммичены в `main`, всё зелёное. Остались шаги 4–6.
Этот документ — точка бесшовного старта для новой сессии.

Кейс-драйвер: гость-контейнер «Объекты мониторинга» на схеме `ObsCore`, 5 детей,
связанных с локальными узлами уровня.

---

## Что уже сделано (шаги 1–3) — НЕ переделывать

| Коммит | Шаг | Суть |
|---|---|---|
| `af075f8` | 1 (D5) | Убит дрейф: удалён `centerEmergedChildren` + модуль `expandCenter.ts` + тест + `expandDelta`-ref. |
| `7a37bff` | 2 (D1) | Внутренняя полка детей авто-гостевой рамки в `ringPlacement.settle` (порядок по якорю, не зависит от ELK). |
| `87371f7` | 3a | Бэкенд: колонка `ghost_positions.anchor_rel` (bool, default false) + миграция `17906408fa51` + проброс в Pydantic (`GhostPositionUpdate`, `PosXY`, `GhostPositionSnapshot`) + `gen:api`. |
| `8561676` | 3b | Тип `LevelPos = PosXY` (фасад `src/types/index.ts`) с `anchor_rel`, протянут в `levelPositions` (TreePage, LevelGraph, ringPlacement, NodeContextModal). Зеркало `handleNodeMoved` пишет `anchor_rel ?? false`. |
| `1792441` | 3c | `ringPlacement`: `groupAnchor()` (экспорт), восстановление владеемой группы `anchorG + офсет`, ленивая миграция абсолют→офсет (`result.migrations`), `expanded` в параметрах. LevelGraph персистит миграции через `cbRef.migrateGhostPositions`. |

### Две архитектурные развилки, решённые с пользователем-архитектором (не пересматривать без него)
1. **Шаг 1.** В коде раскрытие бывает ТОЛЬКО на гостях-контейнерах (🔍 есть лишь у
   `DisplayContainer`; локальные узлы — `type "block"` без `onExpand`). Значит
   `centerEmergedChildren` работал исключительно над детьми гостевых рамок →
   «сузить до нативных» = удалить полностью. Удалён.
2. **Шаг 3 хранение.** Выбран ОФСЕТ от живого якоря с флагом в схеме + миграцией
   (вариант «офсет», НЕ «абсолютный пин»). Поэтому есть `anchor_rel`.

---

## Ключевые инварианты и факты (читать перед шагами 4–6)

- **`groupAnchor` — единая точка правды якоря.** Экспортирована из
  `frontend/src/components/graph/layout/ringPlacement.ts`. Сигнатура:
  `groupAnchor(memberIds, localIds, edges, pos) => {x,y} | null`. Это центроид
  ЦЕНТРОВ связанных локалов группы (фолбэк — все локалы). **Пин (шаг 4) и
  восстановление (3c) ОБЯЗАНЫ считать якорь этой же функцией**, иначе восстановление
  сместит раскладку. Офсет ребёнка = `childTopLeft − anchorG`; восстановление =
  `anchorG + офсет`.
- **Дискриминатор «ребёнок раскрытой гостевой рамки»** = `expanded.has(g.key)`, где
  `g.key` — id ВНЕШНЕЙ (min depth) гостевой рамки, содержащей сущность (см.
  `groupKey` в ringPlacement). Для одиночного свёрнутого гостя верхнего уровня
  `groupKey = собственный id`, он НЕ в `expanded` → прежнее поведение (абсолют).
- **`anchor_rel=true`** → `pos_x/pos_y` это офсет от `anchorG`; `false` → абсолют
  уровня (легаси + все прочие гостевые позиции). Бэкенд только хранит флаг.
- **Авто-группа** (ни у кого нет `levelPositions`) → внутренняя полка/кольцо
  (каскад в ringPlacement). **Владеемая** (хоть у кого-то есть `levelPositions`)
  → восстановление офсетами, каскад её НЕ трогает.
- **keep-out по построению:** рамку на кольцо сажают её recomputed-rect (дети +
  паддинг). Инвариант «после ringPlacement `enforceFramesKeepOut` — no-op на
  авто-гостях» держится; не сломать его в шаге 6.

### Мёртвый код после шага 1 — вычистить в шаге 4
В `LevelGraph.tsx` после удаления центрирования стали write-only (нигде не читаются):
- `expandOrigins` ref (origin больше не нужен: авто-полка ставит детей на кольцо по
  якорям живьём, origin-сид из D3/D5 не используется — кольцо его всё равно
  перекрывало);
- `settledChildren` ref + его bookkeeping в `expandContainer`, `markMovedAndPersist`,
  reset-эффекте смены уровня.

Удалить их в шаге 4 (или отдельным `chore`-коммитом перед ним). Проверить, что
`markMovedAndPersist` после чистки всё ещё зовёт `onNodeMoved`.

---

## Где что лежит

- `frontend/src/components/graph/layout/ringPlacement.ts` — кольца, `groupAnchor`,
  внутренняя полка (`layoutGuestChildrenShelf`), owned-restore + миграции.
- `frontend/src/components/graph/layout/keepGhostsOut.ts` — `enforceFramesKeepOut`
  (шаг 5: перенос waypoints), `clampOutOfNativeFrames`, `nativeByDepth`, `memberDepth`.
- `frontend/src/components/graph/layout/frames.ts` — `computeFrames` (рамки = bbox
  членов + паддинг). Гостевые рамки: `!native`, `memberIds`.
- `frontend/src/components/graph/layout/pav.ts` — `spread1DSized` (де-наложение).
- `frontend/src/components/LevelGraph.tsx` — async-эффект раскладки (≈530+),
  `markMovedAndPersist` (≈273), `cbRef`/`migrateGhostPositions` (≈506), `expanded`
  state (≈236), `expandContainer`/`collapseContainer`.
- `frontend/src/components/graph/interaction/useSnapAlignment.ts` — `persistGroup`
  (персист позиций при драге; сюда вероятно ляжет пин шага 4), `levelFrames()`.
- `frontend/src/components/graph/interaction/useGroupEdgeDrag.ts` — готовая логика
  переноса waypoints (`base.map(p => ({x:p.x+dx, y:p.y+dy}))`) для шага 5.
- `frontend/src/pages/TreePage.tsx` — `levelPositions` state (≈35),
  `handleNodeMoved` (≈438, зеркалит `anchor_rel`), `saveGhostPosition` дёргается из
  `useSnapAlignment`.
- `frontend/src/api/nodes.ts` — `saveGhostPosition(containerId, nodeId, {pos_x,pos_y,anchor_rel?})`.
- Тесты: `frontend/src/components/__tests__/ringPlacement.test.ts`,
  `keepGhostsOut.test.ts`. (`expandCenter.test.ts` удалён.)
- Бэкенд: `app/models/ghost_position.py`, `app/schemas/node.py`,
  `app/schemas/restore.py`, `app/routers/nodes.py` (`save_ghost_position` ≈676,
  сборка `level_positions` ≈157), `app/restore.py` (≈169).

---

## Оставшиеся шаги — план реализации

### Шаг 4 — владение по первому касанию (D4)
**Цель:** первый ручной драг ЛЮБОГО ребёнка раскрытой гостевой рамки снапшотит и
персистит офсеты ВСЕХ текущих детей группы (`anchor_rel=true`). Группа становится
владеемой; повторное раскрытие/layout восстанавливает раскладку один-в-один (это
уже умеет 3c — нужно лишь СОЗДАВАТЬ офсеты).

**Рекомендованное место — `useSnapAlignment.persistGroup`** (там живёт персист
ghost-позиций + история). Нужно пробросить в хук: `expanded: Set<string>` и
рёбра уровня (с спроецированными концами — как `layoutEdges`/`remappedEdges`), плюс
импортировать `groupAnchor`.

Алгоритм для каждого перетянутого ghost/container-узла `n`:
1. `frames = levelFrames()` (уже считается для clamp). Найти внешнюю гостевую рамку,
   содержащую `n.id`, чей id ∈ `expanded` → это группа (`memberIds`). Нет такой →
   НЕ ребёнок раскрытой рамки → прежний абсолютный сейв (как сейчас).
2. `anchorG = groupAnchor(memberIds, localIds, edges, posById.get)`.
3. Для КАЖДОГО члена группы: `offset = memberPos − anchorG`;
   `saveGhostPosition(containerId, member, {pos_x, pos_y, anchor_rel:true})` +
   `onNodeMoved(member, kind, {…, anchor_rel:true})`.
4. Дедуп: если в драге несколько членов одной группы — пинить группу один раз.
5. НЕ делать обычный абсолютный сейв для членов группы (иначе двойной сейв).

**Undo/redo:** `persistGroup` пишет историю по-узлам. Для пина: снять снимок
`levelPositions` всех членов на старте драга (`noteDragStart`/`startPos`), undo
восстанавливает прежние значения (для свежей авто-группы это были `undefined` →
undo должен ВЕРНУТЬ в авто). Проверить, есть ли DELETE-эндпоинт ghost-позиции; если
нет — для v1 допустимо undo = повторный пин старых офсетов (или отложить точный undo,
явно отметив). Решить и реализовать минимально-корректно.

**Зеркало `anchor_rel`** уже готово (3b): `handleNodeMoved` пишет `pos.anchor_rel ?? false`.

**Краевой случай (§9):** новый ребёнок дерева во владеемой группе — без офсета;
3c его не трогает (один авто-сеется, остальные стоят). Для шага 4 достаточно не
ломать это.

**Тест:** `persistGuard`/новый — пин одного ребёнка персистит офсеты всех членов с
`anchor_rel=true`; повторный layout (через `ringPlacement` owned-restore) даёт те же
позиции.

### Шаг 5 — перенос изломов (D8)
**Цель:** при ЛЮБОМ жёстком сдвиге группы движком переносить `waypoints` гостевых
стрелок группы тем же вектором.

Два места сдвига:
1. `enforceFramesKeepOut` (`keepGhostsOut.ts`) — выталкивание группы на `push{dx,dy}`.
2. **(не забыть)** owned-restore в `ringPlacement` (3c) — каждый layout двигает детей
   на `anchorG_new − anchorG_prev`. Их waypoints (хранятся абсолютно в
   `levelEdgeWaypoints`) тоже должны ехать. Это шире, чем просто enforce — учесть.

Реализация: пробросить `levelEdgeWaypoints` (и id гостевых рёбер группы) в нужную
функцию; вернуть сдвинутые waypoints (как `migrations` в 3c) наверх, в LevelGraph,
который их применит/персистит (`onLevelEdgeWaypointsChanged`). Логику сдвига взять из
`useGroupEdgeDrag`. **Тест** (`keepGhostsOut.test.ts`): сдвиг группы на (dx,dy) →
waypoints её стрелок сдвинуты на (dx,dy); инвариант «enforce no-op на авто после
колец» сохраняется.

### Шаг 6 — адаптивный перелив колонок (D6, D7)
**Цель:** многоколоночность, когда высота полки превысила бы пролёт кольца.

В `layoutGuestChildrenShelf` (ringPlacement.ts) сейчас ОДНА колонка (`cross = 0`).
Добавить:
- `perCol = floor(пролёт_кольца / (NODE + SHELF_GAP))`, `пролёт` = длина внутренней
  стороны рамки по оси полки; `cols = ceil(n / perCol)`.
- **Назначение колонок (D7):** сортировка детей по «тяготению к контенту» =
  `(число связей с уровнем ↓, |проекция якоря − центр масс якорей| ↑, id)`; первые
  `perCol` → ВНУТРЕННЯЯ колонка (`cross = 0`, к кольцу), следующие → наружу.
- Внутри колонки — порядок по якорю, плотная стопка (`SHELF_GAP`), центр по якорям
  колонки.
- Колонки наружу от `Sin` на `NODE_W + COL_GAP` (ввести `COL_GAP`). Направление
  «наружу» зависит от `it.side`: right→ +x, left→ −x, top→ −y, bottom→ +y. (Для одной
  колонки cross центрируется в рамке — сохранить это поведение.)
- **Тест:** `n > perCol` → `cols` колонок; внутренняя забита до ёмкости детьми с
  большей связностью; порядок по якорю внутри колонки.

V1 СОЗНАТЕЛЬНО отложено (см. ТЗ §10): blocked-interval, команда «переразложить»,
полная бесперекрёстная маршрутизация, 2D-балансировка, глобальная раскладка локалов.

---

## Команды / гейты

- Поднять сервис: `./dev.sh` (фон, `run_in_background`), стоп `./stop.sh`.
- Фронт-гейт: `cd frontend && npx tsc -b && npx eslint src && npx vitest run`.
  (Pre-commit `scripts/git-hooks/pre-commit` гоняет их сам + бэкенд.)
- **eslint без `--max-warnings`, но держим 0 предупреждений** — для стабильных
  колбэков в эффектах использовать `cbRef`-паттерн (см. `migrateGhostPositions`).
- **`tsc -b`, НЕ `tsc --noEmit`** (последний ложно-зелёный).
- Бэк-гейт: `cd backend && source venv/bin/activate && ruff check app && PYTHONPATH=. pytest`.
  (Pytest падает без `PYTHONPATH=.`.)
- Контракт: изменил Pydantic → `cd frontend && npm run gen:api`, коммить `api.gen.ts`.
- Alembic head сейчас: `17906408fa51`. Миграции: `alembic revision --autogenerate`,
  `alembic upgrade head` (DB обычно поднята).
- LSP: только MCP `mcp__typescript-lsp__*` / `mcp__python-lsp__*` (python_hover сломан).

Текущие счётчики тестов: **vitest 145**, **pytest 51**.

## Коммит-дисциплина
Маленькие коммиты прямо в `main`, по-русски (`feat:`/`fix:`/`chore:`), последней
строкой `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Каждый шаг —
зелёный гейт перед коммитом.

## Документация (доделать в финале)
ТЗ не заносилось в `spec.md`/`tasks.md`. После шага 6 — обновить их по правилу
CLAUDE.md (новая фича → spec.md; реализация → tasks.md).
