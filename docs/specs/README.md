# docs/specs — нормативный реестр поведения сущностей движка

Что это: справочник «как ОБЯЗАНА вести себя сущность на холсте» — по одной спеке
на сущность, внутри — пронумерованные инварианты с константами и привязкой к
тестам. Реестр создан 2026-07-15 для регрессионных проходов при доработках движка.

Чем НЕ является:
- не история решений (это docs/tasks-archive.md и docs/archive/*);
- не продуктовая спека (это spec.md: зачем фича и как выглядит для пользователя);
- не документация кода (это комментарии в модулях).

## Старшинство источников
Истина о текущем поведении — КОД + ТЕСТЫ. Спека — их человекочитаемая проекция:
при расхождении спеки с кодом сначала выясняется, что из двух — баг. Если код
прав (поведение менялось осознанно) — правится спека; если прав реестр — чинится
код. spec.md описывает то же поведение продуктово и исторически; при противоречии
spec.md ↔ specs/* нормативен specs/*, spec.md подтягивается следом.

## Формат инварианта
Каждый пункт: `<ПРЕФИКС><номер>` + формулировка + константы (ИМЯ = значение) +
маркер закрепления:
- `[тест: <файл>]` — закреплено юнит-тестом: vitest
  (frontend/src/components/__tests__/) или pytest (пишется с префиксом
  backend/tests/);
- `[код]` — гарантировано конструкцией (по построению), отдельного теста нет;
- `[глаза]` — проверяется только визуально (браузер-репро/скриншот);
- `[полигон]` — закреплено headless-полигоном scripts/dump-levels.mjs
  («финал == перезагрузка»), запускается вручную на живом dev-стеке.

Правила ведения:
- ID стабильны и НЕ переиспользуются. Снятый инвариант не удаляется молча:
  помечается `СНЯТ (дата, причина)` и остаётся до следующей чистки файла.
- Инвариант, переехавший в другую спеку, оставляет на старом месте указатель
  `ПЕРЕНЕСЁН (дата) в <спека> <ID>` — старый ID навсегда остаётся ссылкой.
- Новые инварианты дописываются в конец своей секции со следующим свободным
  номером файла (номера сквозные по файлу, поэтому внутри секции могут быть
  непоследовательными — это нормально).
- Числовые константы в спеке — снимок на дату правки. Изменил константу в коде →
  обнови её во всех спеках (`grep -rn "<ИМЯ>" docs/specs/`).
- Изменил ПОВЕДЕНИЕ движка → правка спеки идёт В ТОМ ЖЕ коммите, что и код.

## Процедура регрессионного прохода (для Claude)
При любой правке модулей из карты ниже (движок `frontend/src/components/graph/**`,
LevelGraph/MapEditorPage-машинерия, бэк-эндпоинты графа/вида/алертов/контекста):
1. По карте ниже определи затронутые спеки (модуль → спека).
2. Пройди инварианты затронутых секций: каждый пункт — вопрос «моя правка могла
   это сломать?». Сомневаешься — проверь.
3. `[тест: …]`-пункты — прогони перечисленные тестовые файлы (или весь vitest,
   он быстрый). `[глаза]`/`[код]`-пункты под подозрением — браузер-репро
   (харнесс в памяти `ui_verification_headless`) или точечный юнит-тест, который
   при этом стоит написать и добавить в маркер.
4. Обнаружил несоответствие спеки и нового поведения → см. «Старшинство»: либо
   это регрессия (чини код), либо осознанная смена (правь спеку тем же коммитом).

## Спеки и карта «модуль → спека»

Пути в карте: без префикса — `frontend/src/components/` (модули движка — в
`graph/`); `бэк:` — `backend/app/`.

| Спека | Сущность | Модули |
|---|---|---|
| [edge.md](edge.md) | Связь (ребро) | graph/layout/{orthoRoute,routeAll,autoRoutes,channelNudge,coincidentLegs,railPairs,trunks,weldTrunks,incrementalScope,labelBox,labelIntervals,labelLayout,placeLabels,widenForLabels,separateForLabels}.ts, graph/{edgePath,edgeJumps,trunkHit,text}.ts, graph/{EdgeJumpContext,edges,ConnectionLine,QuickConnectPreview}.tsx, graph/interaction/{useEdgeConnect,quickConnect,useLiveDragHandles}.ts |
| [node.md](node.md) | Атомарный узел | graph/{nodes,shapes}.tsx, graph/colors.ts, graph/layout/{separateNodes,separateRects,overlapConstraints,level}.ts, graph/interaction/{snap,useSnapAlignment,distribute}.ts, graph/{absPos,assembleRf,reconcileRf}.ts |
| [container.md](container.md) | Контейнер и рамка | graph/layout/{pipeline,projectGhosts,frames,ringPlacement,keepGhostsOut,separateGuests,separateContainment}.ts, graph/{projection,frameChains}.ts, graph/boundaries.tsx, graph/nodes.tsx (Container/Frame), graph/interaction/{layoutAnimation,useLayoutAnimation}.ts, graph/interaction/useFrameFollowOverlay.tsx |
| [guest.md](guest.md) | Гость | graph/layout/{projectGhosts,ringPlacement,keepGhostsOut,separateGuests}.ts, graph/projection.ts, graph/nodes.tsx (Ghost/Container), graph/assembleRf.ts, inspector/GhostInspector.tsx; бэк: routers/nodes.py (_build_graph), tree.py |
| [canvas.md](canvas.md) | Холст и выделение | LevelGraph.tsx + LevelGraph.css, ../pages/MapEditorPage.tsx (рейл тостов, панель-выделение), graph/{assembleRf.ts,shapes.tsx,boundaries.tsx}, graph/interaction/{useAlignmentGuides,useSnapAlignment,useCanvasDelete,useEdgeConnect,useTemplateDrop}.ts |
| [history.md](history.md) | История Undo/Redo | graph/interaction/{useHistory,persistGuard}.ts, graph/interaction/useSnapAlignment.ts (persistGroup), LevelGraph.tsx (клавиши/кнопки/адаптер), ../pages/MapEditorPage.tsx (структурные команды, диспетчеры) |
| [view.md](view.md) | Уровень и вид | ../pages/{MapEditorPage,NodePage,ProjectHomePage}.tsx, LevelGraph.tsx (commitLayout/expanded), graph/layout/{pipeline,engine}.ts, ../api/{client,projectScope,nodes}.ts; бэк: models/view_layout.py, routers/{views,nodes}.py, projects.py, restore.py, tree.py |
| [alerts.md](alerts.md) | Алерты схемы | SchemaAlerts.tsx + schemaAlerts.css, ../pages/{MapEditorPage,ProjectShell}.tsx + useSchemaAlerts.ts (кнопка «Рекомендации» в шапке + рейл в холсте, locate), LevelGraph.tsx (locate); бэк: routers/nodes.py (get_alerts) |
| [context.md](context.md) | Контекст-схема (страница объекта) | ../pages/NodePage.tsx (SchemaSection), EmbeddedSchemaBlock.tsx, дальше штатные LevelGraph.tsx и graph/layout/pipeline.ts; бэк: routers/nodes.py (get_node_context_graph, _ghost_registry) |
| [perf.md](perf.md) | Производительность и отзывчивость | graph/layout/{pipeline,pipelineClient,engine}.ts, graph/interaction/useIdleCleanup.ts, LevelGraph.tsx (индикация занятости), scripts/perf-probe.mjs, __tests__/{pipelineReplay,layoutMockup}.perf.test.ts |
| [transitions.md](transitions.md) | Анимации переходов | graph/interaction/{layoutAnimation,useLayoutAnimation}.ts, graph/layout/{pipeline.worker,pipelineClient,layoutSig}.ts, graph/EdgeJumpContext.tsx, graph/edges.tsx (drawIn), LevelGraph.tsx (gate/тихое окно), graph/reconcileRf.ts, scripts/dump-levels.mjs |

Модули, живущие сразу в нескольких спеках (pipeline.ts, assembleRf.ts,
LevelGraph.tsx, MapEditorPage.tsx, constants.ts, interaction/layoutAnimation.ts,
бэк routers/nodes.py), при правке требуют прохода по всем задетым спекам.
Продуктовые сущности (дерево узлов, инспекторы/детализация, оверлей доков,
бизнес-процессы, экспорт/импорт, проекты, роли/аутентификация) реестром
осознанно НЕ покрыты — отложены решением 2026-07-16, кандидаты в tasks.md.
