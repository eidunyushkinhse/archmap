// Адаптер раскладки (Фаза 4). Единая ASYNC-точка входа для расчёта позиций/хэндлов:
// потребитель (LevelGraph) зовёт только эти функции и получает ТОТ ЖЕ контракт, что
// раньше отдавали синхронные computeLayout/computeContextLayout. Это развязывает
// потребителя от движка: реализацию можно мигрировать на ELK по частям (level, потом
// context), не меняя форму данных у вызывающего.
//
// Шаг 4.0: функции пока делегируют существующим синхронным движкам (обёрнуты в
// Promise.resolve) — async-канал готов и проверяется ДО подмены движка на ELK.
import ELK from "elkjs/lib/elk.bundled.js";
import { computeLayout } from "./level";
import { computeContextLayout } from "./context";
import type { DisplayExternal, EdgeShelf, EdgeLoop } from "../types";
import type { Edge as AppEdge } from "../../../types";

// Общий ELK-инстанс. Берём bundled-сборку (elk.bundled.js) — она работает в main-thread
// БЕЗ Web Worker, поэтому одинаково поднимается и в браузере (Vite), и в тестах (jsdom).
// Дефолтный entry elkjs тащит Worker и в jsdom не заводится. Инстанс создаём лениво и
// переиспользуем (создание парсит wasm-подобный движок — делать это один раз).
let elkInstance: InstanceType<typeof ELK> | null = null;
export function getElk(): InstanceType<typeof ELK> {
  if (!elkInstance) elkInstance = new ELK();
  return elkInstance;
}

export type LevelLayout = {
  positions: Map<string, { x: number; y: number }>;
  edgeHandles: Map<string, { sourceHandle: string; targetHandle: string }>;
};

export type ContextLayout = LevelLayout & {
  edgeShelves: Map<string, EdgeShelf>;
  edgeLoops: Map<string, EdgeLoop>;
};

/** Раскладка обычного уровня (async-канал; реализация — см. шаг 4.2). */
export function layoutLevel(
  allNodes: Array<{ id: string; savedPos?: { x: number; y: number } | null }>,
  edges: AppEdge[],
): Promise<LevelLayout> {
  return Promise.resolve(computeLayout(allNodes, edges));
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
