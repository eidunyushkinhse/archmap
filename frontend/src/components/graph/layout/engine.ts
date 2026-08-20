// Адаптер раскладки (Фаза 4). Единая ASYNC-точка входа для расчёта позиций/хэндлов:
// потребитель (LevelGraph) зовёт только эти функции и получает ТОТ ЖЕ контракт, что
// раньше отдавали синхронные computeLayout/computeContextLayout. Это развязывает
// потребителя от движка: реализацию можно мигрировать на ELK по частям (level, потом
// context), не меняя форму данных у вызывающего.
//
// Шаг 4.0: функции пока делегируют существующим синхронным движкам (обёрнуты в
// Promise.resolve) — async-канал готов и проверяется ДО подмены движка на ELK.
//
// Оптимизация (2026-07-21): кэш ELK-результатов по сигнатуре входов (nodes + edges
// структура). Если структура графа не менялась (только позиции из viewLayout) —
// ELK не пересчитывается, берётся из кэша. Сохранённые позиции всё равно
// перезаписывают ELK-результат, но сам прогон ELK пропускается.
import type ELK from "elkjs/lib/elk.bundled.js";
import { NODE_W, NODE_H } from "../constants";
import { flowSpacing } from "./flowGaps";
import { pickLevelForm } from "./levelForm";
import { assignEdgeHandles } from "./level";
import type { LayoutEdge } from "../../../types";

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

// Кэш ELK-результатов (оптимизация 2026-07-21). Ключ: сигнатура структуры графа
// (node IDs + edge source/target pairs). Значение: позиции от ELK (до перезаписи
// сохранёнными координатами). Размер кэша ограничен 50 записями (LRU-подобный:
// при переполнении удаляем самую старую).
const elkCache = new Map<string, Map<string, { x: number; y: number }>>();
const ELK_CACHE_MAX = 50;

// Сигнатура структуры графа для кэша ELK: node IDs (sorted) + edge pairs (sorted).
// Не включает savedPos — он только перезаписывает финал, не влияет на ELK-прогон.
function elkSignature(
  allNodes: Array<{ id: string }>,
  edges: LayoutEdge[],
): string {
  const nodeIds = allNodes.map((n) => n.id).sort();
  const edgePairs = edges
    .map((e) => `${e.source_id}->${e.target_id}`)
    .sort();
  return `nodes:${nodeIds.join(",")}|edges:${edgePairs.join(",")}`;
}

// Сброс кэша ELK — ТОЛЬКО для тестов (замок детерминизма гоняет два живых
// прогона на одном входе; без сброса второй тривиально совпал бы из кэша).
export function __clearElkCacheForTests(): void {
  elkCache.clear();
}

export type LevelLayout = {
  positions: Map<string, { x: number; y: number }>;
  edgeHandles: Map<string, { sourceHandle: string; targetHandle: string }>;
};

/**
 * Раскладка обычного уровня через ELK `layered` (шаг 4.2). Заменяет dagre: тот же
 * слева-направо поток рангов, размеры узлов NODE_W×NODE_H, межранговый/межузловой
 * зазоры ≈ как у dagre (ranksep 120 / nodesep 60). ELK отдаёт позиции в координатах
 * верхнего-левого угла узла — это ровно то, что ждёт React Flow. Поверх ELK
 * накладываем сохранённые координаты (ручной drag архитектора перетирает дефолт),
 * затем общей с computeLayout логикой назначаем хэндлы (autoHandles от позиций).
 *
 * Оптимизация (2026-07-21): кэш ELK-результатов по сигнатуре структуры графа.
 * Если структура не менялась (только savedPos из viewLayout) — ELK не пересчитывается.
 */
export async function layoutLevel(
  allNodes: Array<{ id: string; savedPos?: { x: number; y: number } | null }>,
  edges: LayoutEdge[],
): Promise<LevelLayout> {
  const idSet = new Set(allNodes.map((n) => n.id));
  const inner = edges.filter((e) => idSet.has(e.source_id) && idSet.has(e.target_id));

  // A/B-ПЕРЕОПРЕДЕЛЕНИЕ ОПЦИЙ ELK (перф-эпик 2026-08-20): глобал __archmapElkOverride
  // подменяет/дополняет layoutOptions (алгоритм/зазоры). Выставляют только мокап-раннер
  // (__tests__/layoutMockup.perf.test.ts) и полигоны — в проде глобала нет. Входит в
  // сигнатуру кэша, чтобы варианты не отравляли друг друга.
  const ovG = globalThis as unknown as { __archmapElkOverride?: Record<string, string> };
  const override = ovG.__archmapElkOverride;

  // Проверяем кэш ELK (оптимизация 2026-07-21)
  const sig = (override ? JSON.stringify(override) + "|" : "") + elkSignature(allNodes, inner);
  let elkPositions = elkCache.get(sig);

  if (!elkPositions) {
    // Кэш-мисс: гоняем ELK
    // вертикаль слоя — коридоры горизонтальных плеч: зазоры под фактический спрос
    // линий и плашек (flowGaps; были статические 60/10/10 — пачке из 4 плеч с
    // подписью физически не хватало высоты, а узлы с пробегающими сквозь слой
    // рёбрами ELK смыкал до 32px независимо от nodeNode)
    const sp = flowSpacing(inner);
    // ФОРМА ПО ТОПОЛОГИИ СЦЕНЫ (N30, перф-эпик Ф4): звёзды — force, потоки —
    // layered. Форма — чистая функция тех же входов, что и сигнатура кэша
    // (ids + пары рёбер), поэтому кэш корректен без формы в ключе.
    // Набор опций force — БУКВАЛЬНО замеренный мокапами Ф1 микс: базовые
    // layered-ключи + два поверх (лишние layered-ключи force игнорирует, но
    // сравнимость «мокап = прод» держится байт-в-байт; менять — только с
    // новым замером). Детерминизм — дефолтный randomSeed=1 ELK (тест-замок
    // в engine.test.ts).
    const formOpts: Record<string, string> = pickLevelForm(inner) === "force"
      ? { "elk.algorithm": "org.eclipse.elk.force", "elk.spacing.nodeNode": "80" }
      : {};
    const elk = await getElk();
    const res = await elk.layout({
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.layered.spacing.nodeNodeBetweenLayers": "120", // ≈ dagre ranksep
        "elk.spacing.nodeNode": String(sp.nodeGap),
        "elk.spacing.edgeNode": String(sp.edgeNodeGap),
        "elk.spacing.edgeEdge": String(sp.edgeEdgeGap),
        "elk.padding": "[top=30,left=30,bottom=30,right=30]", // ≈ dagre marginx/y
        ...formOpts,
        ...override,
      },
      children: allNodes.map((n) => ({ id: n.id, width: NODE_W, height: NODE_H })),
      edges: inner.map((e) => ({ id: e.id, sources: [e.source_id], targets: [e.target_id] })),
    });

    elkPositions = new Map<string, { x: number; y: number }>();
    for (const n of res.children ?? []) {
      elkPositions.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
    }

    // Сохраняем в кэш (LRU-подобный: при переполнении удаляем самую старую)
    if (elkCache.size >= ELK_CACHE_MAX) {
      const firstKey = elkCache.keys().next().value;
      if (firstKey) elkCache.delete(firstKey);
    }
    elkCache.set(sig, elkPositions);
  }

  // Копируем позиции из кэша (чтобы не мутировать кэшированную Map)
  const positions = new Map(elkPositions);

  // Переопределяем позиции сохранёнными значениями из БД (ручной drag перетирает ELK)
  for (const node of allNodes) {
    if (node.savedPos != null) positions.set(node.id, node.savedPos);
  }

  return { positions, edgeHandles: assignEdgeHandles(allNodes, edges, positions) };
}
