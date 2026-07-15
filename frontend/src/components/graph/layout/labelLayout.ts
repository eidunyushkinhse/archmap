// Размещение плашек подписей на раскладке уровня (эпик стрелок, фаза A7.2 — R2+R4).
//
// Зачем модуль: чистые модули плашек (coincidentLegs/A4, labelCandidates/A5, placeLabels/A6)
// принимают геометрию и габариты, но не знают про доменную модель (группы рёбер, тексты).
// Здесь мост: по авто-маршрутам (A7.1) и текстам подписей строим допустимые интервалы и
// размещаем плашки без взаимных наложений и не под узлами (R2), запрещая их на совпавших
// плечах родственных стрелок (R4). Выход — позиция центра + якорь на линии (для поводка-
// выноски, A7.3) + режим. Чистая функция. См. ARROWS_ROUTING_ANALYSIS.md §8 (D5, D6).
import type { EdgePoint } from "../../../types";
import { segments, type NodeRect, type Segment } from "../edgePath";
import type { EdgeGroup } from "../types";
import { coincidentLegs } from "./coincidentLegs";
import { labelBoxSize } from "./labelBox";
import { labelCandidates } from "./labelIntervals";
import { placeLabels, type LabelInput } from "./placeLabels";

export interface LabelPlacement {
  mode: "online" | "leader";
  center: EdgePoint;    // центр плашки
  anchor: EdgePoint;    // точка на линии (для поводка-выноски; для online == center)
  leaderEnd: EdgePoint; // конец поводка у края плашки (anchor→leaderEnd; для online == center)
}

// Описание подписи группы для оценки габаритов: текст (для ширины) и число строк (высота).
export interface LabelMeta {
  text: string;
  lines: number;
}

export function buildLabelPlacements(params: {
  routes: Map<string, EdgePoint[]>;                 // авто-маршруты (groupId → ломаная)
  groups: EdgeGroup[];
  labelMeta: (g: EdgeGroup) => LabelMeta | null;    // null = у группы нет подписи (плашки нет)
  preferredT: (g: EdgeGroup) => number | undefined; // желаемая доля (ручной label_t)
  nodeRects: NodeRect[];                            // тела узлов — препятствия (R2)
  // Доп. ЖЁСТКИЕ препятствия ТОЛЬКО для скоринга размещения (не для интервалов
  // кандидатов): живой драг подкладывает сюда плашки незатронутых рёбер — ровно так их
  // видит финальный гриди (placedRects), а интервалы/сэмплы кандидатов не искажаются.
  obstacleRects?: NodeRect[];
}): Map<string, LabelPlacement> {
  const { routes, groups, labelMeta, preferredT, nodeRects, obstacleRects } = params;
  // Совпавшие плечи (R4) считаем по ВСЕМ маршрутам набора — даже у безымянных рёбер плечо
  // может быть общим, и подпись соседа туда ставить нельзя.
  const shared = coincidentLegs(routes);
  const inputs: LabelInput[] = [];
  for (const g of groups) {
    const path = routes.get(g.id);
    if (!path) continue;
    const meta = labelMeta(g);
    if (!meta) continue;
    const box = labelBoxSize(meta.text, { lines: meta.lines });
    const sharedIv = shared.get(g.id) ?? [];
    const cands = labelCandidates(path, sharedIv, nodeRects, box);
    // shared отдаём в placeLabels отдельно: candidates исключают и слитые плечи, И зоны под
    // узлами, а для ЯКОРЯ выноски (точка на линии) узлы не помеха — важно лишь не слитое плечо.
    inputs.push({ id: g.id, path, candidates: cands, box, preferredT: preferredT(g), shared: sharedIv });
  }
  // Плечи ВСЕХ маршрутов (даже безымянных) — препятствия для плашки-выноски и помеха поводку
  // (A15): плашка не должна ложиться на чужое плечо, а поводок — лишний раз пересекать стрелки.
  const edgeSegs = new Map<string, Segment[]>();
  for (const [id, path] of routes) edgeSegs.set(id, segments(path));
  // obstacleRects — отдельным параметром, НЕ подмешивать в nodeRects: узлы участвуют и в
  // штрафе поводка (nodeCross), а внешние препятствия (чужие плашки живого драга) — только
  // в наложениях плашки, как placedRects финального гриди.
  const placements = placeLabels(inputs, nodeRects, edgeSegs, obstacleRects ?? []);
  const out = new Map<string, LabelPlacement>();
  for (const p of placements) {
    out.set(p.id, { mode: p.mode, center: p.center, anchor: p.anchor, leaderEnd: p.leaderEnd });
  }
  return out;
}
