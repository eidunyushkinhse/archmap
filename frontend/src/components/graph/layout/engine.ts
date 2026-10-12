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
import { edgeText } from "../text";
import { flowSpacing, type FlowDirection } from "./flowGaps";
import type { GuestLayer } from "./guestLayers";

/**
 * НАПРАВЛЕНИЕ автораскладки уровня (R10 плана эпика «стрелки без жёстких хэндлов»,
 * решение пользователя 2026-10-11, Ф4): слои сверху вниз, как у Mermaid/ELK по
 * умолчанию. До Ф4 — RIGHT (≈ dagre LR). Направление нигде не хранится: роутер
 * выводит ось потока из геометрии узлов сам (ports.ts, E8).
 */
export const LEVEL_DIRECTION: FlowDirection = "DOWN";
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
  // Ф3 эпика «стрелки без жёстких хэндлов»: реальные габариты узлов и плашки подписей
  // (inline) — ELK резервирует под них место в слоях и зазорах, как Mermaid; без них —
  // NODE_W×NODE_H и рёбра без подписей (превью, тесты)
  opts?: {
    sizes?: ReadonlyMap<string, { w: number; h: number }>;
    labelBoxes?: ReadonlyMap<string, { w: number; h: number }>;
    // Ф4б (шаг 1): крайние слои ELK для гостей — источники в отдельный слой ПЕРЕД
    // первым рядом локалов, приёмники — ПОСЛЕ последнего (guestLayers.ts); узлы без
    // записи — обычные. Без гостей (карта пуста) ограничений нет вовсе.
    guestLayers?: ReadonlyMap<string, GuestLayer>;
  },
): Promise<LevelLayout> {
  const idSet = new Set(allNodes.map((n) => n.id));
  const inner = edges.filter((e) => idSet.has(e.source_id) && idSet.has(e.target_id));
  const sizeOf = (id: string): { w: number; h: number } => opts?.sizes?.get(id) ?? { w: NODE_W, h: NODE_H };
  const labelOf = (id: string): { w: number; h: number } | undefined => opts?.labelBoxes?.get(id);
  const layerOf = (id: string): GuestLayer | undefined => opts?.guestLayers?.get(id);
  const constrained = allNodes.some((n) => layerOf(n.id) !== undefined);
  // Ф4б: связи гость→гость ELK не отдаём, кроме «источник → приёмник» через всю схему:
  // внутри одного крайнего слоя ELK их не принимает (in-layer ребро — исключение
  // UnsupportedConfigurationException), а обратную (приёмник → источник) разворачивал
  // бы cycle breaker. Такие связи ведёт роутер по финальным позициям, как и все прочие.
  const elkEdges = constrained
    ? inner.filter((e) => {
      const s = layerOf(e.source_id), t = layerOf(e.target_id);
      return s === undefined || t === undefined || (s === "first" && t === "last");
    })
    : inner;

  // A/B-ПЕРЕОПРЕДЕЛЕНИЕ ОПЦИЙ ELK (перф-эпик 2026-08-20): глобал __archmapElkOverride
  // подменяет/дополняет layoutOptions (алгоритм/зазоры). Выставляют только мокап-раннер
  // (__tests__/layoutMockup.perf.test.ts) и полигоны — в проде глобала нет. Входит в
  // сигнатуру кэша, чтобы варианты не отравляли друг друга.
  const ovG = globalThis as unknown as { __archmapElkOverride?: Record<string, string> };
  const override = ovG.__archmapElkOverride;

  // Проверяем кэш ELK (оптимизация 2026-07-21)
  // габариты и плашки — в сигнатуре кэша: тот же граф с другими размерами — другая раскладка
  const dims = allNodes.map((n) => { const z = sizeOf(n.id); return `${n.id}:${Math.round(z.w)}x${Math.round(z.h)}`; }).join(",")
    + "|" + elkEdges.map((e) => { const l = labelOf(e.id); return l ? `${e.id}:${Math.round(l.w)}x${Math.round(l.h)}` : ""; }).join(",")
    // крайние слои гостей — в сигнатуре: тот же граф с другой стороной гостя — другая раскладка
    + "|guest:" + allNodes.flatMap((n) => { const l = layerOf(n.id); return l ? [`${n.id}:${l}`] : []; }).join(",");
  const sig = (override ? JSON.stringify(override) + "|" : "") + elkSignature(allNodes, elkEdges) + "|" + dims;
  let elkPositions = elkCache.get(sig);

  if (!elkPositions) {
    // Кэш-мисс: гоняем ELK
    // вертикаль слоя — коридоры горизонтальных плеч: зазоры под фактический спрос
    // линий и плашек (flowGaps; были статические 60/10/10 — пачке из 4 плеч с
    // подписью физически не хватало высоты, а узлы с пробегающими сквозь слой
    // рёбрами ELK смыкал до 32px независимо от nodeNode)
    const sp = flowSpacing(elkEdges, LEVEL_DIRECTION);
    // ФОРМА — ВСЕГДА layered (R10 плана эпика «стрелки без жёстких хэндлов», Ф4,
    // 2026-10-12): прежнее правило N30 «звёзды — force» снято. С портом на связь и
    // подписями inline layered DOWN рисует звезду как поток Mermaid (полигон: корень
    // «Ярмарки» 1 крест, 7.2k px линий), а force с подписями-объектами раскладки
    // разъезжался на 3000 px (23k px линий). Детерминизм layered — тест-замок в
    // engine.test.ts.
    const elk = await getElk();
    const res = await elk.layout({
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": LEVEL_DIRECTION,
        "elk.layered.spacing.nodeNodeBetweenLayers": "120", // ≈ dagre ranksep
        "elk.spacing.nodeNode": String(sp.nodeGap),
        "elk.spacing.edgeNode": String(sp.edgeNodeGap),
        "elk.spacing.edgeEdge": String(sp.edgeEdgeGap),
        // Ф3: слой подписей ELK (inline-плашки) отстоит от соседних слоёв на зазор
        // «ребро–узел», а не на межслойный шаг узлов — иначе каждая подпись раздвигала
        // слои на два шага (как у эталона полигона)
        "elk.layered.spacing.edgeNodeBetweenLayers": String(sp.edgeNodeLayerGap),
        "elk.layered.spacing.edgeEdgeBetweenLayers": String(sp.edgeEdgeGap),
        "elk.padding": "[top=30,left=30,bottom=30,right=30]", // ≈ dagre marginx/y
        "elk.spacing.edgeLabel": "6",
        ...override,
      },
      // Ф4б: гости — в отдельные крайние слои (источники перед первым рядом локалов,
      // приёмники за последним), как вложенная коробка ELK: гость снаружи рамки уровня
      children: allNodes.map((n) => {
        const z = sizeOf(n.id);
        const l = layerOf(n.id);
        return {
          id: n.id, width: z.w, height: z.h,
          ...(l ? { layoutOptions: { "elk.layered.layering.layerConstraint": l === "first" ? "FIRST_SEPARATE" : "LAST_SEPARATE" } } : {}),
        };
      }),
      edges: elkEdges.map((e) => {
        const l = labelOf(e.id);
        return {
          id: e.id, sources: [e.source_id], targets: [e.target_id],
          ...(l ? { labels: [{ text: edgeText(e), width: l.w, height: l.h, layoutOptions: { "elk.edgeLabels.inline": "true" } }] } : {}),
        };
      }),
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
