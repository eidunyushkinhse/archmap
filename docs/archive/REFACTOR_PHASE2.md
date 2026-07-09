# Фаза 2 — Декомпозиция `LevelGraph.tsx` (детальный план)

> **ПРОГРЕСС (обновлено 2026-06-08): Фаза 2 ЗАВЕРШЕНА — все 18 шагов сделаны, дерево зелёное.**
> `LevelGraph.tsx` ужат 1948 → 498 строк (тонкий оркестратор: сборка данных +
> вызовы хуков + JSX). Все модули `graph/*` созданы и подключены; тест
> `levelGraph.test.ts` импортит из новых путей. Коммиты по шагам:
> 1 constants `af8f2d1` · 2 types `1d9dbbd` · 3 text `6a81bd2` · 4 colors `538a224` ·
> 5 projectGhosts `1ec2ef2` · 6 level `b1fb55a` · 7 context `fe34e8e` · 8 shapes `af49c26` ·
> 9 nodes `ba5d4ec` · 10 edges `4b210aa` · 11 boundaries `553f44f` · 12 snap `e36de72` ·
> 13 useAlignmentGuides `cc3b1e5` · 14 useSnapAlignment `4cec822` · 15 useTemplateDrop `9eb4738` ·
> 16 useReconnectHandles `54dbb30` · 17 useCanvasDelete `14bdf00`.
>
> **Финальная проверка (шаг 18):** `tsc -b` = 0 ошибок, фронт `npm test` = 18 тестов
> зелёные, бэк не трогали (7 тестов). Сервис поднят через `./dev.sh`: бэк `/docs` = 200,
> фронт = 200, `/api/v1/nodes` = 307 (штатный trailing-slash редирект).
>
> **Большой derivation-`useEffect`** (выводит `rfNodes`/`rfEdges`) и его
> `eslint-disable exhaustive-deps` ОСТАВЛЕНЫ в оркестраторе намеренно — их переписывание
> в `useMemo` это **Фаза 3**, не трогалось здесь. `expanded`/`expandContainer`/
> `collapseContainer`/`expandOrigins` и локальный `handleEdgeClick` тоже остались в
> оркестраторе (питают раскладку и `LevelBoundary`).
>
> **ВАЖНО для будущих шагов: после `git commit` bash-cwd сбрасывается в корень
> репозитория — перед след. `tsc`/`npm` сделать `cd frontend`.**



> **Как возобновить с нуля (в свежем окне):** прочитать этот файл + `REFACTOR_PLAN.md`.
> Перед стартом проверить, что дерево зелёное и Фазы 0–1 на месте:
> `cd frontend && npx tsc -b && npm test` (18 тестов) и
> `cd backend && venv/bin/python -m pytest` (7 тестов).
> Аудит файла проведён 2026-06-08 на `LevelGraph.tsx` = **1948 строк**. Номера строк
> ниже — на эту ревизию; по мере выноса файл сокращается, поэтому **перед каждым шагом
> перепроверять расположение символов** (см. «Навигация» ниже).

## Навигация по коду (LSP, а не grep)

CLAUDE.md требует навигацию через MCP-LSP, не через grep/Read. Применять так:
- **Найти все ссылки на переносимый символ** (главное для корректности — после выноса
  поправить ВСЕ импорты): `mcp__typescript-lsp__ts_references` на идентификаторе.
  Семантически точно, без ложных совпадений в комментариях/подстроках/одноимённых
  локальных. Им же убедиться, что в `LevelGraph.tsx` после переноса ссылок не осталось.
- **Прыгнуть к определению символа** от его использования: `ts_definition`.
  Курсор ставить ТОЧНО на идентификатор (иначе tsserver падает, см. CLAUDE.md).
- **Тип символа**: `ts_hover` (для TS работает).
- **`Read`** — только чтобы захватить точный диапазон тела функции для вырезания
  (LSP отдаёт строку начала, не весь блок). Это разрешено CLAUDE.md.
- **Оглавление файла** (освежить «съехавшие» номера строк = список всех top-level
  объявлений сразу): среди доступных MCP-LSP нет outline-эндпоинта (есть только
  definition/references/diagnostics/hover — все позиционные/per-symbol), поэтому
  именно для этой задачи допустим grep/Read как fallback:
  `grep -nE '^(export )?(function|const|interface|type) ' src/components/LevelGraph.tsx`.
- Гейт типов — `npx tsc -b`, НЕ `ts_diagnostics` (F7: может отдавать устаревший снэпшот).

## Цель и инварианты

Разнести God Component (`LevelGraph.tsx`, ~12 ответственностей) на модули в
`frontend/src/components/graph/`, оставив **тонкий оркестратор** в
`components/LevelGraph.tsx` (путь НЕ меняем — его импортируют TreePage/NodeContextModal,
не хотим трогать потребителей).

**Поведение НЕ меняем.** Это чистая раскладка по файлам:
- Страховка — тесты Фазы 1 (`npm test`) + `npx tsc -b` после КАЖДОГО шага.
- Большой `useEffect`, выводящий `rfNodes`/`rfEdges` (строки ~1544–1762), и его
  `// eslint-disable react-hooks/exhaustive-deps` **ОСТАЮТСЯ в оркестраторе** — их
  переписывание в `useMemo` это Фаза 3, не трогать здесь.
- `expanded`/`expandContainer`/`collapseContainer`/`expandOrigins` остаются в
  оркестраторе (питают и раскладку, и `LevelBoundary`).
- `nodeTypes`/`edgeTypes` должны остаться **module-level константами** (стабильная
  ссылочная идентичность) — иначе React Flow ругается на пересоздание типов. При
  переносе в `nodes.tsx`/`edges.tsx` экспортировать их как module-level const.

## Уточнение к исходному плану

Исходный список модулей (`REFACTOR_PLAN.md`, Фаза 2) дополняем двумя фундаментами,
чтобы разорвать общие зависимости без циклов: **`graph/constants.ts`** и
**`graph/types.ts`**. Мелкие хелперы группируем (`text.ts`, `colors.ts`,
`interaction/snap.ts`). Это осознанное уточнение, граф зависимостей ниже — ацикличный.

---

## Карта символов → модуль (строки на ревизии аудита)

### `graph/constants.ts` — числа/идентичность, без внутренних зависимостей
- `NODE_W` (223), `NODE_H` (224), `PERSON_H` (227), `shapeHeight()` (230)
- `SNAP_THRESHOLD` (236), `MAX_TAG_FONT` (239), `MIN_TAG_FONT` (240)
- `SIDE_HANDLES` (277), `hid()` (284)
- `BOUNDARY_PAD` (815), `BOUNDARY_STEP` (816), `BOUNDARY_LABEL_PAD` (824), `BOUNDARY_LABEL_STEP` (825)
- `CTX_LABEL_W` (826), `MIN_SHELF` (827), `SHELF_PAD` (831)
- импорт: `Position` (@xyflow/react, для `SIDE_HANDLES`), `NodeShape` (../../types)

### `graph/types.ts` — общие типы (импортирует только типы)
- `NodeColors` (290)
- `EdgeShelf` (74), `EdgeLoop` (79), `WrappedEdgeData` (81)
- `BlockData` (315), `GhostData` (325), `ContainerData` (331)
- `BlockRFNode` (340), `GhostRFNode` (341), `ContainerRFNode` (342)
- `DisplayContainer` (755), `DisplayLeaf` (756), `DisplayExternal` (757)
- импорт: `Node as RFNode` тип (@xyflow/react), `AppNode/GhostNode/AncestorRef/NodeShape` (../../types)
- **NB:** `FrameDef` (1123) используется ТОЛЬКО в `boundaries.tsx` → оставить локально там,
  не тащить в `types.ts`. `WrappedEdgeData` тащим (нужен и edges.tsx, и оркестратору).

### `graph/text.ts` — текстовые хелперы
- `wrapLabel()` (41), `maxLineLength()` (60), `edgeText()` (65)

### `graph/colors.ts`
- `getNodeColors()` (292) — импортирует `NodeColors` из `./types`

### `graph/layout/projectGhosts.ts`
- `projectGhosts()` (766, уже `export`)
- импорт: `DisplayContainer/DisplayLeaf/DisplayExternal` (../types), `GhostNode/AncestorRef` (../../../types)

### `graph/layout/level.ts`
- `autoHandles()` (347, уже `export`), `computeLayout()` (376, уже `export`)
- импорт: `NODE_W/NODE_H/hid` (../constants), `maxLineLength` (../text), `Edge as AppEdge` (../../../types), `Dagre`
- **НЕ зависит** от context.ts/nodes/edges

### `graph/layout/context.ts`
- `computeContextLayout()` (851, уже `export`), `ctxLabelWidth()` (836, перенести сюда — он
  локален для контекст-раскладки, оркестратор его не использует)
- импорт: `NODE_W/NODE_H/hid/BOUNDARY_PAD/BOUNDARY_STEP/MIN_SHELF/SHELF_PAD/CTX_LABEL_W`
  (../constants), `DisplayExternal/EdgeShelf/EdgeLoop` (../types), `Edge as AppEdge` (../../../types)
- **Проверено:** зовёт `hid` напрямую, `autoHandles` НЕ зовёт → нет зависимости от level.ts

### `graph/shapes.tsx` — презентация формы узла + node-стили
- `NodeShapeProps` (466), `NodeShapeSvg()` (476), `contentPadding()` (532)
- `nodeContainer` (542), `SELECTED_GLOW` (551), `fixedHandleStyle()` (446)
- стили из хвоста файла: `tagChip` (1918), `nodeActions` (1925), `personActions` (1935), `nodeBtn` (1939)
- импорт: `NODE_W/shapeHeight` (./constants), `Position/CSSProperties`, `NodeShape` (../../types)

### `graph/nodes.tsx` — компоненты-узлы + реестр
- `NodeHandles()` (556), `RoleTechChip()` (580), `BlockNode()` (629), `GhostBlockNode()` (692),
  `ContainerNode()` (710), `SpacerNode()` (742), `nodeTypes` (746)
- импорт: из `./shapes` (NodeShapeSvg, contentPadding, nodeContainer, SELECTED_GLOW,
  fixedHandleStyle, tagChip/nodeActions/personActions/nodeBtn); из `./constants`
  (SIDE_HANDLES, hid, shapeHeight, MAX_TAG_FONT/MIN_TAG_FONT); из `./types`
  (BlockData/GhostData/ContainerData/*RFNode); из @xyflow/react (Handle, NodeProps, NodeTypes)

### `graph/edges.tsx` — ребро + реестр
- `roundedPolyline()` (97), `WrappedLabelEdge()` (114), `edgeTypes` (219)
- импорт: `wrapLabel` (./text), `WrappedEdgeData` (./types), из @xyflow/react
  (BaseEdge, EdgeLabelRenderer, getSmoothStepPath, EdgeProps, EdgeTypes)

### `graph/boundaries.tsx` — рамки уровней + направляющие
- `FrameDef` (1123, локальный), `LevelBoundary()` (1141), `AlignmentGuides()` (1251)
- импорт: `NODE_W/NODE_H/BOUNDARY_*` (./constants), `GhostData/ContainerData` (./types),
  `AncestorRef` (../../types), `Node as RFNode` (@xyflow/react)

### `graph/interaction/snap.ts` — чистые хелперы примагничивания
- `nodeSize()` (244), `snapCenter()` (256)
- импорт: `SNAP_THRESHOLD/NODE_W/NODE_H` (../constants), `Node as RFNode` (@xyflow/react)

### `graph/interaction/useAlignmentGuides.ts`
- НОВЫЙ хук: владеет состоянием `guides` + `clearGuides` (из оркестратора, строки 1382/1391).
  Возвращает `{ guides, setGuides, clearGuides }`. Тонкий, но разделяется snap- и drop-хуками.

### `graph/interaction/useSnapAlignment.ts`
- Из оркестратора: `handleNodesChange` (1429), `handleNodeDragStop` (1404).
- Сигнатура: `useSnapAlignment({ rfNodes, onNodesChange, setGuides, isArchitect, isContext, containerId })`
  → `{ handleNodesChange, handleNodeDragStop }`.
- Зовёт `snapCenter/nodeSize` (./snap), `nodesApi` (../../../api/nodes) для персиста позиций.

### `graph/interaction/useTemplateDrop.ts`
- Из оркестратора: `dropPreview` state (1388), эффект сброса при `!dragShape` (1397),
  `handleDragOver` (1767), `handleDragLeave` (1786), `handleDrop` (1792).
- Сигнатура: `useTemplateDrop({ rfNodes, screenToFlowPosition, setGuides, clearGuides,
  isArchitect, isContext, onDropNode, dragShape })`
  → `{ dropPreview, handleDragOver, handleDragLeave, handleDrop }`.
- Зовёт `snapCenter` (./snap), `shapeHeight/NODE_W` (../constants), `NODE_DRAG_MIME` (../../NodeTreePanel).

### `graph/interaction/useReconnectHandles.ts`
- Из оркестратора: refs `reconnectingEdge`/`reconnectSucceeded` (1377/1378),
  `handleReconnectStart` (1481), `handleReconnect` (1486), `handleReconnectEnd` (1531),
  `isValidConnection` (1538).
- Сигнатура: `useReconnectHandles({ setRfEdges, nodes, isArchitect, containerId, onEdgeHandlesChanged })`
  → `{ handleReconnectStart, handleReconnect, handleReconnectEnd, isValidConnection }`.
- Зовёт `reconnectEdge` (@xyflow/react), `edgesApi/nodesApi` (../../../api/nodes).

### `graph/interaction/useCanvasDelete.ts`
- Из оркестратора: `handleKeyDown` (1462).
- Сигнатура: `useCanvasDelete({ rfNodes, isArchitect, isContext, onRequestDeleteNode })`
  → `{ handleKeyDown }`. Читает `(node.data as BlockData).appNode` (../types).

### `components/LevelGraph.tsx` — оркестратор (остаётся на месте)
- `LevelGraphProps` (1277), `LevelGraphInner` (1330) ужатый, `LevelGraph` default (1908).
- Держит: `useNodesState/useEdgesState`, `expanded`+origins, большой derivation-`useEffect`
  (Фаза 3), `handleEdgeClick` (1806), сборку `<ReactFlow>` и порталов.
- Импортирует всё из `./graph/*` и вызывает 5 interaction-хуков.

---

## Граф зависимостей (ацикличный; стрелка = «импортирует из»)

```
constants.ts ─┐
types.ts ─────┤
text.ts ──────┤
              ├─ colors.ts → types
              ├─ layout/projectGhosts.ts → types
              ├─ layout/level.ts → constants, text
              ├─ layout/context.ts → constants, types
              ├─ shapes.tsx → constants
              │     └─ nodes.tsx → shapes, constants, types
              ├─ edges.tsx → text, types
              ├─ boundaries.tsx → constants, types
              ├─ interaction/snap.ts → constants
              │     ├─ useSnapAlignment → snap, api
              │     └─ useTemplateDrop → snap, constants, NodeTreePanel
              ├─ interaction/useAlignmentGuides (leaf, react)
              ├─ interaction/useReconnectHandles → api, types
              └─ interaction/useCanvasDelete → types
LevelGraph.tsx (оркестратор) → ВСЁ выше
```
Никакой модуль не импортирует из `LevelGraph.tsx` → циклов нет.

---

## Порядок шагов (каждый = зелёный `tsc -b` + `npm test` + маленький коммит)

Снизу вверх: сначала листья, оркестратор продолжает их импортировать. Механика выноса:
(1) создать модуль и перенести в него код; (2) удалить из `LevelGraph.tsx`; (3) добавить
import в `LevelGraph.tsx` (и в другие уже вынесенные модули, если нужно).

1. **`graph/constants.ts`** — перенести все константы + `shapeHeight`/`hid`. Импортнуть обратно.
2. **`graph/types.ts`** — перенести общие типы.
3. **`graph/text.ts`** — `wrapLabel`/`maxLineLength`/`edgeText`.
4. **`graph/colors.ts`** — `getNodeColors`.
5. **`graph/layout/projectGhosts.ts`** — `projectGhosts`. **Обновить импорт в тесте**
   `src/components/__tests__/levelGraph.test.ts`: `projectGhosts` теперь из `../graph/layout/projectGhosts`.
6. **`graph/layout/level.ts`** — `autoHandles`/`computeLayout`. Обновить импорт в тесте
   (`autoHandles`,`computeLayout` из `../graph/layout/level`).
7. **`graph/layout/context.ts`** — `computeContextLayout` (+`ctxLabelWidth`). Обновить импорт
   в тесте (`computeContextLayout` из `../graph/layout/context`).
8. **`graph/shapes.tsx`** — формы узла + node-стили + `fixedHandleStyle`.
9. **`graph/nodes.tsx`** — компоненты узлов + `nodeTypes` (module-level!).
10. **`graph/edges.tsx`** — `roundedPolyline`/`WrappedLabelEdge` + `edgeTypes` (module-level!).
11. **`graph/boundaries.tsx`** — `LevelBoundary`/`AlignmentGuides` (+локальный `FrameDef`).
12. **`graph/interaction/snap.ts`** — `nodeSize`/`snapCenter` (чистые).
13. **`graph/interaction/useAlignmentGuides.ts`** — состояние guides.
14. **`graph/interaction/useSnapAlignment.ts`** — `handleNodesChange`/`handleNodeDragStop`.
15. **`graph/interaction/useTemplateDrop.ts`** — preview/drag-drop хэндлеры + эффект сброса.
16. **`graph/interaction/useReconnectHandles.ts`** — reconnect-хэндлеры + refs.
17. **`graph/interaction/useCanvasDelete.ts`** — `handleKeyDown`.
18. **Финал:** оркестратор ужат до сборки данных + 5 вызовов хуков + JSX. Прогнать
    `tsc -b` + `npm test`; вручную через `./dev.sh` сверить поведение (см. Verification ниже).

Шаги 1–11 — механический перенос (низкий риск). Шаги 12–17 — главный риск Фазы 2:
inline-колбэки превращаются в хуки, замыкания на `rfNodes`/`setGuides`/`setRfEdges`/props
теперь приходят параметрами. Делать по одному хуку, после каждого — полная проверка.

## Verification (после каждого шага и в конце)
- `cd frontend && npx tsc -b` (основной гейт; НЕ только MCP `ts_diagnostics`).
- `npm test` — 18 тестов Фазы 1 должны оставаться зелёными без изменения ожиданий.
- Бэкенд не трогаем: `cd backend && venv/bin/python -m pytest` для контроля.
- В конце вручную (`./dev.sh`): уровень с гостями (свернуть/развернуть контейнер, drag
  узла/гостя с примагничиванием и направляющими, reconnect конца стрелки → переживает
  reload), контекст-схема узла со связями (фокус по центру, полки/обходы, нет краша),
  создание узла drag'ом из палитры (превью + дроп), удаление узла по Backspace.

## Подводные камни
- **Идентичность `nodeTypes`/`edgeTypes`** — только module-level const, иначе RF warning.
- **Импорты в тесте** — обновлять на шагах 5/6/7 (иначе красный `tsc -b` на тесте).
  Альтернатива: barrel-реэкспорт из `LevelGraph.tsx`, но чище — прямые пути.
- **`eslint-disable` и `ancestorIds.join("|")`** в derivation-эффекте — НЕ трогать (Фаза 3).
- **`ReactFlowProvider`** — `useReactFlow()` (screenToFlowPosition) нужен контекст: остаётся
  обёртка `LevelGraph` → `LevelGraphInner`. Хук `useTemplateDrop` зовётся ВНУТРИ `Inner`.
- **`CSSProperties`** импортируется во многих модулях из `react` (type-only).
- **F7-урок:** доверять `tsc -b`, не MCP `ts_diagnostics` (может отдавать устаревший снэпшот).
