// Адаптер раскладки (Фаза 4). Единая ASYNC-точка входа для расчёта позиций/хэндлов:
// потребитель (LevelGraph) зовёт только эти функции и получает ТОТ ЖЕ контракт, что
// раньше отдавали синхронные computeLayout/computeContextLayout. Это развязывает
// потребителя от движка: реализацию можно мигрировать на ELK по частям (level, потом
// context), не меняя форму данных у вызывающего.
//
// Шаг 4.0: функции пока делегируют существующим синхронным движкам (обёрнуты в
// Promise.resolve) — async-канал готов и проверяется ДО подмены движка на ELK.
import type ELK from "elkjs/lib/elk.bundled.js";
import { NODE_W, NODE_H } from "../constants";
import { assignEdgeHandles } from "./level";
import { computeContextLayout } from "./context";
import type { DisplayExternal, EdgeShelf, EdgeLoop } from "../types";
import type { Edge as AppEdge, LayoutEdge } from "../../../types";

// Общий ELK-инстанс. Берём bundled-сборку (elk.bundled.js) — она работает в main-thread
// БЕЗ Web Worker, поэтому одинаково поднимается и в браузере (Vite), и в тестах (jsdom).
// Дефолтный entry elkjs тащит Worker и в jsdom не заводится.
//
// Импорт ДИНАМИЧЕСКИЙ: ELK ~435 kB gzip, статический импорт раздул бы главный чанк.
// import() выносит движок в отдельный ленивый чанк — он грузится только когда реально
// открыли граф (getElk зовётся из async-эффекта раскладки), не блокируя начальную
// загрузку (логин и т.п.). Промис кэшируем — движок парсится один раз.
type ElkInstance = InstanceType<typeof ELK>;
let elkPromise: Promise<ElkInstance> | null = null;
export function getElk(): Promise<ElkInstance> {
  if (!elkPromise) {
    elkPromise = import("elkjs/lib/elk.bundled.js").then((m) => new m.default());
  }
  return elkPromise;
}

export type LevelLayout = {
  positions: Map<string, { x: number; y: number }>;
  edgeHandles: Map<string, { sourceHandle: string; targetHandle: string }>;
};

export type ContextLayout = LevelLayout & {
  edgeShelves: Map<string, EdgeShelf>;
  edgeLoops: Map<string, EdgeLoop>;
};

/**
 * Раскладка обычного уровня через ELK `layered` (шаг 4.2). Заменяет dagre: тот же
 * слева-направо поток рангов, размеры узлов NODE_W×NODE_H, межранговый/межузловой
 * зазоры ≈ как у dagre (ranksep 120 / nodesep 60). ELK отдаёт позиции в координатах
 * верхнего-левого угла узла — это ровно то, что ждёт React Flow. Поверх ELK
 * накладываем сохранённые координаты (ручной drag архитектора перетирает дефолт),
 * затем общей с computeLayout логикой назначаем хэндлы (autoHandles от позиций).
 */
export async function layoutLevel(
  allNodes: Array<{ id: string; savedPos?: { x: number; y: number } | null }>,
  edges: LayoutEdge[],
): Promise<LevelLayout> {
  const idSet = new Set(allNodes.map((n) => n.id));
  const elk = await getElk();
  const res = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "120", // ≈ dagre ranksep
      "elk.spacing.nodeNode": "60",                        // ≈ dagre nodesep
      "elk.padding": "[top=30,left=30,bottom=30,right=30]", // ≈ dagre marginx/y
    },
    children: allNodes.map((n) => ({ id: n.id, width: NODE_W, height: NODE_H })),
    edges: edges
      .filter((e) => idSet.has(e.source_id) && idSet.has(e.target_id))
      .map((e) => ({ id: e.id, sources: [e.source_id], targets: [e.target_id] })),
  });

  const positions = new Map<string, { x: number; y: number }>();
  for (const n of res.children ?? []) {
    positions.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
  }

  // Переопределяем позиции сохранёнными значениями из БД (ручной drag перетирает ELK)
  for (const node of allNodes) {
    if (node.savedPos != null) positions.set(node.id, node.savedPos);
  }

  return { positions, edgeHandles: assignEdgeHandles(allNodes, edges, positions) };
}

/** Раскладка контекстной схемы (async-канал; реализация — см. шаг 4.3). */
export function layoutContext(
  focusId: string,
  focusHeight: number,
  entities: DisplayExternal[],
  edges: AppEdge[],
  ancestorIds: string[],
  expanded: Set<string>,
): Promise<ContextLayout> {
  return Promise.resolve(
    computeContextLayout(focusId, focusHeight, entities, edges, ancestorIds, expanded),
  );
}
