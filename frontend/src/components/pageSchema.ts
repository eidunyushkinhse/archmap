// Чистые хелперы страничных схем (pages_pivot / single-schema): маппинг графа
// уровня и метрики блоков. Вынесены из NodePage / ProjectHomePage /
// MapEditorPage / useLevelSchema, чтобы жили в одном месте и были
// покрыты тестами (pageSchema.test.ts).

import type { GhostNode, GraphResponse, LevelEdge, Node } from "../types";

// Данные схемы страницы = ответ context-graph + СВОИ правки меты, влитые точечно.
// Схема держит свой снимок графа (фетч при монтировании), а свойства страницы правятся
// отдельно — без этого слияния смена типа/имени/статуса была бы видна на схеме только
// после перезагрузки (context.md X20). Рефетч контекста ради данных, которые уже на
// руках, — лишний круг; ремаунт холста сбросил бы вписывание и анимации.
//
// Механизм ПОФИГУРНЫЙ: подставляется узел ЦЕЛИКОМ, поэтому форма, имя, статус,
// размещение, роль и технология догоняют схему одинаково, и новое поле меты не
// потребует правки здесь.
//
// СВЕЖЕСТЬ РЕШАЕТ version (CAS-счётчик строки, растёт на каждой записи): своя правка
// поднимает его на единицу и выигрывает, а чужая, приехавшая рефетчем по graph_rev,
// приходит с бОльшим номером — и НЕ затирается устаревшим локальным узлом. Равенство
// отдаём странице: содержимое то же, а стабильная ветка бережёт идентичность объекта.
//
// Исключение — счётчики детей: на read-only странице они считаются по РЕЛЕВАНТНЫМ
// детям (context.md X16 v2), а у узла страницы полные (node.md N17), поэтому остаются
// схемными.
export function withOwnEdits(graph: GraphResponse, focus: Node): GraphResponse {
  const nodes = graph.nodes.map((n) => (
    n.id === focus.id && focus.version >= n.version
      ? { ...focus, child_count: n.child_count, has_children: n.has_children }
      : n
  ));
  return { ...graph, nodes };
}

// Рёбра уровня из GraphResponse: сырые концы (source_id/target_id — реальные
// узлы) + синтез original_* (имя конца из локалов и реестра) для панелей
// деталей. Маппинг идентичен во всех потребителях графа уровня.
export function toLevelEdges(graph: GraphResponse): LevelEdge[] {
  const nameById = new Map<string, string>([
    ...graph.nodes.map((n) => [n.id, n.name] as const),
    ...graph.endpoints.map((ep) => [ep.id, ep.name] as const),
  ]);
  return graph.edges.map((ge) => ({
    id: ge.id,
    label: ge.label,
    technology: ge.technology,
    source_id: ge.source_id,
    target_id: ge.target_id,
    original_source_id: ge.source_id,
    original_target_id: ge.target_id,
    original_source_name: nameById.get(ge.source_id) ?? "",
    original_target_name: nameById.get(ge.target_id) ?? "",
    version: ge.version,
    created_at: "",
  }));
}

// Гости ВНЕ поддерева фокуса: у конца из реестра фокус не встречается в предках
// (глубокие концы внутренних рёбер несут фокус в предках и гостями не считаются).
export function outerGuests(graph: GraphResponse, focusId: string): GhostNode[] {
  return graph.endpoints.filter((ep) => !(ep.ancestors ?? []).some((a) => a.id === focusId));
}

// «Внешних связей нет»: кроме фокуса нет ни локалов-представителей, ни внешних
// гостей (context.md X17 — пустое состояние секции «Схема»).
export function hasNoNeighbors(graph: GraphResponse, focusId: string): boolean {
  return graph.nodes.length <= 1 && outerGuests(graph, focusId).length === 0;
}

// Оценка числа ВИДИМЫХ сущностей для высоты блока до замера ширины: локалы +
// полностью внешние гости (не внутри отображаемой рамки одного из локалов).
export function visibleEntityGuess(graph: GraphResponse): number {
  const localIds = new Set(graph.nodes.map((n) => n.id));
  const outer = graph.endpoints.filter(
    (ep) => !(ep.ancestors ?? []).some((a) => localIds.has(a.id)),
  ).length;
  return graph.nodes.length + outer;
}

// Высота секции «Схема» страницы объекта: 90px на сущность, коридор 300–560.
export function schemaSectionHeight(entityCount: number): number {
  return Math.max(300, Math.min(560, entityCount * 90));
}

// Высота легаси-секции «Схема компонентов» (NodePage): 62px на узел, 280–430.
export function componentsSectionHeight(nodeCount: number): number {
  return Math.min(430, Math.max(280, nodeCount * 62));
}

// Высота схемы страницы проекта (корневой холст): 62px на узел, 300–440.
export function projectSchemaHeight(nodeCount: number): number {
  return Math.min(440, Math.max(300, nodeCount * 62));
}

// Отзывчивая высота холста EmbeddedSchemaBlock (после замера ширины):
// ширина × 0.52, коридор 320–680.
export function responsiveCanvasHeight(width: number): number {
  return Math.max(320, Math.min(680, Math.round(width * 0.52)));
}
