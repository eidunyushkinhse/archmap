// СПЕЙСИНГИ потоковой раскладки (ELK layered RIGHT) — единый расчёт для уровня
// (layoutLevel) и мини-раскладки спавна детей (spawnChildren).
//
// При потоке слева-направо межузловое пространство слоя по вертикали — это
// коридоры, в которых наш роутер ведёт ГОРИЗОНТАЛЬНЫЕ плечи, а канальный
// нуджинг разводит их пачки равными зазорами. Прежний статический nodesep 60
// вмещал пачку из четырёх плеч только впритык (2·клиренс 8 + 3·14 = 58), а
// инлайн-плашке места не оставалось вовсе — gap каналов деградировал до
// слипания. Спрос коридора: 2·NUDGE_CLEAR + высота максимальной wrapped-плашки
// + резерв интервалов канала под пачку до LANES_CAP параллельных плеч.
//
// ВАЖНО (найдено полигоном): nodeNode действует ТОЛЬКО на пары узлов слоя без
// рёбер между ними. Узлы, разделённые пробегающими сквозь слой рёбрами, ELK
// ставит по СВОЕМУ резерву на эти рёбра — edgeNode/edgeEdge (дефолт 10/10 →
// коридор 32px при любом nodeNode). Поэтому ручки три, и все — из нашей же
// модели спроса: edgeNode = клиренс нуджинга + полвысоты плашки (плечо у узла
// несёт подпись), edgeEdge = шаг пачки канала.
import { edgeText, wrapLabel } from "../text";
import { NUDGE_CLEAR, NUDGE_GAP } from "./channelNudge";
import { wrappedLabelBoxSize } from "./labelBox";

const VERT_GAP_MIN = 60;  // прежний nodesep: граф без подписей и пачек не раздуваем
const VERT_GAP_MAX = 132; // анти-ватман: чуть выше межслойных 120, коридор не шире слоя
// больше четырёх параллельных плеч в одном коридоре — уже не «резерв раскладки»,
// а сигнал перекроить схему; дальше пусть работает деградация gap канала
const LANES_CAP = 4;
const EDGE_NODE_MAX = 48; // анти-ватман резерва пробегающих рёбер (полкоридора)

export interface FlowSpacing {
  /** elk.spacing.nodeNode — вертикальный коридор между узлами слоя */
  nodeGap: number;
  /** elk.spacing.edgeNode — резерв между узлом и пробегающим сквозь слой ребром */
  edgeNodeGap: number;
  /** elk.spacing.edgeEdge — шаг между пробегающими рёбрами (= шаг пачки канала) */
  edgeEdgeGap: number;
}

/**
 * Спейсинги слоя под фактический спрос линий и подписей переданных рёбер
 * (рёбра, участвующие в раскладке).
 */
export function flowSpacing(
  edges: ReadonlyArray<{ label: string | null; technology: string | null }>,
): FlowSpacing {
  let maxH = 0;
  for (const e of edges) {
    maxH = Math.max(maxH, wrappedLabelBoxSize(wrapLabel(edgeText(e))).h);
  }
  const lanes = Math.min(LANES_CAP, Math.max(1, edges.length));
  const demand = 2 * NUDGE_CLEAR + maxH + (lanes - 1) * NUDGE_GAP;
  return {
    nodeGap: Math.min(VERT_GAP_MAX, Math.max(VERT_GAP_MIN, demand)),
    edgeNodeGap: Math.min(EDGE_NODE_MAX, NUDGE_CLEAR + Math.ceil(maxH / 2)),
    edgeEdgeGap: NUDGE_GAP,
  };
}
