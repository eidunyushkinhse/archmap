// СПЕЙСИНГИ потоковой раскладки (ELK layered) — единый расчёт для уровня
// (layoutLevel) и мини-раскладки спавна детей (spawnChildren).
//
// Межузловое пространство ВНУТРИ слоя (поперёк потока) — коридоры, в которых роутер
// ведёт плечи вдоль потока (колонны ZZ, стабы) и их подписи, а канальный нуджинг
// разводит пачки A*-плеч равными зазорами. Прежний статический nodesep 60 вмещал
// пачку из четырёх плеч только впритык (2·клиренс 8 + 3·14 = 58), а инлайн-плашке
// места не оставалось вовсе — gap каналов деградировал до слипания. Спрос коридора:
// 2·NUDGE_CLEAR + ПОПЕРЕЧНЫЙ потоку размер максимальной wrapped-плашки (при потоке
// RIGHT коридор вертикален — высота; при DOWN горизонтален — ширина, Ф4 эпика
// «стрелки без жёстких хэндлов») + резерв интервалов канала под пачку до LANES_CAP
// параллельных плеч.
//
// ВАЖНО (найдено полигоном): nodeNode действует ТОЛЬКО на пары узлов слоя без
// рёбер между ними. Узлы, разделённые пробегающими сквозь слой рёбрами, ELK
// ставит по СВОЕМУ резерву на эти рёбра — edgeNode/edgeEdge (дефолт 10/10 →
// коридор 32px при любом nodeNode). Поэтому ручки три, и все — из нашей же
// модели спроса: edgeNode = клиренс нуджинга + половина поперечного размера плашки,
// edgeEdge = шаг пачки канала. МЕЖДУ слоями (вдоль потока) — четвёртая ручка:
// edgeNodeBetweenLayers — зазор слоя inline-подписей ELK от слоёв узлов; он по
// высоте плашки (плашка на стабе у цели лежит ВДОЛЬ потока, E96) в обоих направлениях.
import { edgeText, wrapLabel } from "../text";
import { NUDGE_CLEAR, NUDGE_GAP } from "./channelNudge";
import { wrappedLabelBoxSize } from "./labelBox";

/** Направление потоковой раскладки ELK layered. */
export type FlowDirection = "RIGHT" | "DOWN";

const VERT_GAP_MIN = 60;  // прежний nodesep: граф без подписей и пачек не раздуваем
const VERT_GAP_MAX = 132; // анти-ватман: чуть выше межслойных 120, коридор не шире слоя
// больше четырёх параллельных плеч в одном коридоре — уже не «резерв раскладки»,
// а сигнал перекроить схему; дальше пусть работает деградация gap канала
const LANES_CAP = 4;
const EDGE_NODE_MAX = 48; // анти-ватман резерва пробегающих рёбер (полкоридора)

export interface FlowSpacing {
  /** elk.spacing.nodeNode — коридор между узлами слоя (поперёк потока) */
  nodeGap: number;
  /** elk.spacing.edgeNode — резерв между узлом и пробегающим сквозь слой ребром */
  edgeNodeGap: number;
  /** elk.spacing.edgeEdge — шаг между пробегающими рёбрами (= шаг пачки канала) */
  edgeEdgeGap: number;
  /** elk.layered.spacing.edgeNodeBetweenLayers — зазор слоя подписей от слоёв узлов */
  edgeNodeLayerGap: number;
}

/**
 * Спейсинги слоя под фактический спрос линий и подписей переданных рёбер
 * (рёбра, участвующие в раскладке). dir — направление потока: поперечный размер
 * плашки — высота при RIGHT, ширина при DOWN.
 */
export function flowSpacing(
  edges: ReadonlyArray<{ label: string | null; technology: string | null }>,
  dir: FlowDirection = "RIGHT",
): FlowSpacing {
  let maxH = 0, maxW = 0;
  for (const e of edges) {
    const box = wrappedLabelBoxSize(wrapLabel(edgeText(e)));
    maxH = Math.max(maxH, box.h);
    maxW = Math.max(maxW, box.w);
  }
  const across = dir === "DOWN" ? maxW : maxH;
  const lanes = Math.min(LANES_CAP, Math.max(1, edges.length));
  const demand = 2 * NUDGE_CLEAR + across + (lanes - 1) * NUDGE_GAP;
  return {
    nodeGap: Math.min(VERT_GAP_MAX, Math.max(VERT_GAP_MIN, demand)),
    edgeNodeGap: Math.min(EDGE_NODE_MAX, NUDGE_CLEAR + Math.ceil(across / 2)),
    edgeEdgeGap: NUDGE_GAP,
    edgeNodeLayerGap: Math.min(EDGE_NODE_MAX, NUDGE_CLEAR + Math.ceil(maxH / 2)),
  };
}
