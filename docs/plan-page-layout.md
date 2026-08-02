# План: расстановка узлов на страничных схемах (продвижение на «виртуальных корнях»)

Статус: **к реализации** (груминг 2026-08-02, решения пользователя получены). Ветка feat/pages-pivot.
Задача в tasks.md: «ПРОДВИЖЕНИЕ УЗЛОВ НА ВИРТУАЛЬНЫХ КОРНЯХ».

## Суть фичи
Дать архитектору расставлять узлы на СТРАНИЦАХ объектов (схема в разделе «Схема» на
странице узла = контекст объекта как виртуальный корневой уровень), с персистом
раскладки, как на обычном холсте редактора. Сейчас страничные схемы ВСЕГДА свежий
ELK (read-only, без персиста — инвариант X11-A v2 / X13).

## Продуктовые решения (пользователь, 2026-08-02)
1. **Каждая страница независима**: вид = `view_id = id фокуса`. Перемещение узла на
   странице «Маркетплейс» НЕ влияет на его позицию на странице «Каталог» и в редакторе-карте.
2. **Двигать можно ВСЕХ видимых** узлов: соседи-представители + сам фокус + дети
   раскрытых на странице контейнеров.
3. **Инлайн-раскрытия сохраняются** как часть раскладки страницы (переживают перезаход).
4. **«Переразложить» на странице** сбрасывает позиции И раскрытия (вид к начальному).
5. Наблюдатель — read-only (видит раскладку архитектора, не двигает).

## Вердикт анализа: гипотеза рабочая, модель данных готова
`view_layout` уже поддерживает: `view_id` (UUID, NULL=корень), `item_id`, `payload {x,y,expanded}`,
спарсный персист (строки только для подвинутых). **Отдельная БД НЕ нужна.**

## КЛЮЧЕВОЙ нюанс модели (важно!)
На странице узла X в EmbeddedSchemaBlock сейчас передаётся `containerId = node.parent_id`
(уровень-родитель; у ДВУХ сиблингов parent_id ОДИНАКОВЫЙ → нельзя использовать как ключ
вида, иначе сиблинговые страницы разделят раскладку). Поэтому:
- `containerId` (структура уровня, предки/глубина) = `node.parent_id` — остаётся.
- **`view_id` раскладки страницы = `node.id` (фокус)** — нужен ОТДЕЛЬНЫЙ параметр
  `layoutViewId`, который EmbeddedSchemaBlock передаёт в LevelGraph для персиста.

## Механика
- Страница узла X → вид `view_id = X.id`.
- Драг видимого узла → `PUT /views/{X.id}/layout` (item_id = id узла, {x,y}); раскрытие
  контейнера → {expanded:true} + позиции детей тем же видом.
- Загрузка страницы: context-graph отдаёт СОХРАНЁННУЮ раскладку вида фокуса (нет → свежий ELK).
- «Переразложить» на странице → очистка view_layout вида фокуса (позиции+раскрытия) → свежий ELK.

## Что делать

### Бэкенд
1. **app/context_graph.py · build_context_graph**: отдавать сохранённую раскладку вида фокуса.
   - `from app.graph_queries import ghost_registry, read_view_layout` (read_view_layout уже есть:
     читает ВСЕ строки view_layout вида, фильтрует мёртвые).
   - `layout = read_view_layout(db, project.id, focus.id)`.
   - В GraphResponse: `layout=layout`, `version=current_version(db, project.id, focus.id)`
     (сейчас `version=current_version(db, project.id, None)` — заменить None на focus.id;
     это fence вида фокуса для CAS записей раскладки).
   - Обновить docstring (сейчас говорит «layout НЕ отдаётся, всегда свежий ELK» — устарело).
2. **Эндпоинт «переразложить вид фокуса»**: новый `POST /nodes/{node_id}/context-relayout`
   (require_architect) → чистит view_layout по view_id=node_id. Переиспользовать логику
   `_clear_level_layout(db, container_id, project)` из routers/nodes.py (она чистит view_layout
   по view_id=container_id; передать container_id=node_id) + bump_view_version + bump_graph_rev.
   Референс: существующие `POST /relayout` и `POST /{container_id}/relayout` (routers/nodes.py:551+).
3. PUT раскладки уже работает: `PUT /views/{view_id}/layout` (routers/views.py:68) поддерживает
   view_id=UUID (parse_view_id: "root"→None, иначе UUID). view_id=focus.id пройдёт.

### Фронтенд
1. **frontend/src/api/nodes.ts**: метод `getContextGraph` уже есть; добавить `relayoutContext(nodeId)`
   → POST /nodes/{id}/context-relayout (если нужен клиент для кнопки «Переразложить» на странице).
2. **frontend/src/pages/NodePage.tsx · SchemaSection** (~строка 792+):
   - Передавать в EmbeddedSchemaBlock `viewLayout={graph.layout}` (вместо `viewLayout={{}}`) —
     сохранённая раскладка из context-graph.
   - Передать `layoutViewId={node.id}` (новый проп — ключ вида для персиста).
   - `containerId={node.parent_id ?? null}` — остаётся (структура/предки).
3. **frontend/src/components/EmbeddedSchemaBlock.tsx**:
   - Новый проп `layoutViewId?: string` (пробросить в LevelGraph).
   - Для АРХИТЕКТОРА включить редактирование раскладки: `readOnly: !isArchitect`,
     `arrangeOnly: isArchitect` (сейчас захардкожено `readOnly: true, arrangeOnly: false`,
     строки 140-141). Наблюдатель — по-прежнему read-only.
   - Завести персист: пропсы persistence-бандла (onLayoutChanged/onPersistError/onPersistConflict/
     retryPatch/viewMeta/gestureActiveRef) — по образу MapEditorPage (useLevelPersistence в
     LevelGraph сам пишет, нужен viewMeta-курсор + обработчики). См. как собрано в MapEditorPage.tsx
     (persistence-бандл, handleLayoutChanged, resyncOnPersistError, handlePersistConflict, layoutRetry).
   - Кнопка «Переразложить» на странице (архитектор) → relayoutContext(node.id) + рефетч.
     (Обсудить с пользователем место кнопки — возможно, в тулбаре схемы/рейле.)
4. **frontend/src/components/LevelGraph.tsx**:
   - Новый проп `layoutViewId?: string` — ключ вида для персиста раскладки. Сейчас персист
     использует `containerId` как view_id (useLevelPersistence). Для страницы view_id должен быть
     layoutViewId (= id фокуса), а containerId (= parent_id) — только структура/предки.
   - В useLevelPersistence (components/graph/interaction/useLevelPersistence.ts) view_id записи =
     layoutViewId ?? containerId. Проверить, как хук получает view_id (скорее всего из containerId
     в замыкании commitLayout/persistFenced) — подменить на layoutViewId.
   - remote-sync: PUT раскладки бампает graph_rev → useRemoteSync страницы увидит (желательно для
     других сессий на той же странице). echo-suppression через viewMeta уже есть.

### Спеки (обновить в том же коммите)
- **docs/specs/context.md**: инвариант X13 переписать («на страницах пишет только архитектор,
  только позиции+раскрытия, вид = фокус»); X11-A v2 уточнить (раскладка страницы теперь СВОЯ
  сохранённая, не всегда свежий ELK; тождество состава/связей/рамок/маршрутов при своей раскладке
  остаётся).
- Возможно docs/specs/canvas.md / view.md — персист раскладки вида фокуса.

## Нагрузка на Postgres — НЕ проблема
Персист спарсный (строки только для подвинутых узлов). ~80 сервисов × несколько кастомизированных
страниц × подвинутые узлы = сотни строк, не тысячи. view_layout уже хранит раскладки уровней
редактора; страничные виды — инкрементально. Отдельная БД не нужна.

## Инвалидация при изменении структуры — graceful
Состав страницы зависит от рёбер (проекция). При изменении рёбер видимый набор меняется: узлы,
ставшие невидимыми, — их строки view_layout игнорируются (безвредны, F6а «чтение не пишет»);
новые видимые получают свежий ELK. Миграция позиций не нужна.

## Подводные камни
1. **graph_rev**: PUT раскладки бампает graph_rev → другие страницы (другой фокус) перезагрузятся
   без видимых изменений (небольшая избыточность, не критично). На той же странице — обновление
   раскладки (желаемо).
2. **Позиция фокуса**: фокус подвижен (решение «всех видимых»), старт — свежий ELK.
3. **Эхо своих записей**: echo-suppression через viewMeta работает — свои записи не выглядят чужими.
4. **containerId vs layoutViewId**: НЕ смешивать (см. «КЛЮЧЕВОЙ нюанс» выше) — сиблинговые страницы
   имеют общий parent_id, ключ вида ДОЛЖЕН быть id фокуса.

## Тестирование
- Бэк: тест context-graph отдаёт сохранённую раскладку вида фокуса (положить view_layout для
  view_id=focus.id → GET context-graph вернёт её); тест relayout-context чистит вид фокуса
  (и НЕ трогает соседние виды/родительский уровень). Референс: backend/tests/test_relayout.py,
  test_context_graph (если есть; иначе по образцу test_relayout).
- Фронт: существующие тесты не сломать (655+). Рендер-тесты страницы/EmbeddedSchemaBlock тонкие
  (моки) — минимум не сломать; основное — ручная проверка.
- **Ручная проверка** (в QA-REFACTOR.md): перетащить узел на странице → перезагрузить → позиция
  на месте; раскрыть контейнер → перезагрузить → раскрытие+позиции на месте; «Переразложить» →
  свежий ELK; наблюдатель не двигает; две страницы одного родителя — раскладки независимы;
  правка в одной сессии → тост/обновление в другой.

## Порядок реализации (рекомендуемый)
1. Бэк: build_context_graph отдаёт layout+version вида фокуса + тест. Коммит.
2. Бэк: эндпоинт relayout-context + тест. Коммит.
3. Фронт: layoutViewId-проп (EmbeddedSchemaBlock + LevelGraph + useLevelPersistence), viewLayout
   из context-graph, readOnly/arrangeOnly по архитектору, персист-бандл. Коммит.
4. Фронт: кнопка «Переразложить» на странице (место уточнить у пользователя). Коммит.
5. Спеки (context.md X13/X11-A). Коммит (или вместе с релевантным шагом).
6. QA-REFACTOR.md: сценарии. Генерация типов (npm run gen:api), если менялись схемы ответа.

## Точки входа / файлы (шпаргалка)
- Бэк: app/context_graph.py (build_context_graph), app/graph_queries.py (read_view_layout, build_graph),
  app/routers/nodes.py (get_node_context_graph:479, _clear_level_layout:528, relayout:551+),
  app/routers/views.py (save_view_layout:68, parse_view_id:37), app/view_state.py (current_version,
  bump_view_version, bump_graph_rev), app/models/view_layout.py (ViewLayoutItem).
- Фронт: frontend/src/pages/NodePage.tsx (SchemaSection:792, EmbeddedSchemaBlock render:911,
  viewLayout={{}}, containerId=node.parent_id), frontend/src/components/EmbeddedSchemaBlock.tsx
  (readOnly:140/arrangeOnly:141, viewLayout/containerId:204-205), frontend/src/components/LevelGraph.tsx
  (containerId, useLevelPersistence), frontend/src/components/graph/interaction/useLevelPersistence.ts,
  frontend/src/pages/MapEditorPage.tsx (референс persistence-бандла), frontend/src/api/nodes.ts
  (getContextGraph).
- Спеки: docs/specs/context.md (X11-A, X13), docs/specs/README.md (карта спека→модуль).

## Открытые вопросы к пользователю (уточнить при реализации)
- Место кнопки «Переразложить» на странице объекта (тулбар схемы? рейл? ⋯-меню?).
- (опц.) Тост «Схема обновлена» при чужой правке раскладки страницы — уже есть remoteToast в
  SchemaSection; проверить, что срабатывает на graph_rev от раскладки.
