// СТРУКТУРНЫЙ ДАМП РЕЗУЛЬТАТА РАСКЛАДКИ — общий для replay-prof (--dump) и corpus-check.
// Формат согласован с routeQualityMetrics.RouteDump (его читает route-quality) и с
// базовыми дампами корпуса scripts/.polygon/render-scale/baseline: менять нельзя, иначе
// сверка «байт-в-байт» с дампами прежних версий потеряет смысл.
import { edgeLabelMeta, type PipelineInput, type PipelineOutput } from "../../src/components/graph/layout/pipeline";
import { metaLabelBox } from "../../src/components/graph/layout/labelBox";
import { NODE_W, NODE_H } from "../../src/components/graph/constants";

interface Rect { x: number; y: number; w: number; h: number }

export interface StructuralDump {
  routes: [string, { x: number; y: number }[]][];
  rects: (Rect & { id: string })[];
  labels: [string, Rect][];
}

/** Маршруты, тела отображаемых узлов и плашки подписей — всё отсортировано по id. */
export function buildRouteDump(input: PipelineInput, out: PipelineOutput): StructuralDump {
  const byId = (a: string, b: string): number => a.localeCompare(b);
  const routes = out.layout.autoRoutes ?? new Map<string, { x: number; y: number }[]>();
  const routesOut = [...routes].sort(([a], [b]) => byId(a, b));

  // Тела ОТОБРАЖАЕМЫХ узлов (рамки — не тела и сюда не идут).
  const displayIds = [
    ...out.layout.nodes.map((n) => n.id),
    ...out.layout.entities.map((e) => e.id),
  ];
  const rects: (Rect & { id: string })[] = [];
  for (const id of displayIds) {
    const p = out.layout.positions.get(id);
    if (!p) continue;
    const s = input.sizes?.[id];
    rects.push({ id, x: p.x, y: p.y, w: s?.w ?? NODE_W, h: s?.h ?? NODE_H });
  }
  rects.sort((a, b) => byId(a.id, b.id));

  // Плашки подписей: центр из размещения, габарит — единой оценкой metaLabelBox.
  const groupById = new Map(out.layout.groupArr.map((g) => [g.id, g]));
  const labels: [string, Rect][] = [];
  for (const [id, lp] of out.layout.labelPlacements ?? []) {
    const g = groupById.get(id);
    const meta = g ? edgeLabelMeta(g) : null;
    if (!meta) continue;
    const box = metaLabelBox(meta);
    labels.push([id, { x: lp.center.x - box.w / 2, y: lp.center.y - box.h / 2, w: box.w, h: box.h }]);
  }
  labels.sort(([a], [b]) => byId(a, b));

  return { routes: routesOut, rects, labels };
}

/** Оживление снимка входа: Set/Map в JSON не выживают — захват кладёт их метками. */
export function reviveInput(_k: string, v: unknown): unknown {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.__set)) return new Set(o.__set);
    if (Array.isArray(o.__map)) return new Map(o.__map as [unknown, unknown][]);
  }
  return v;
}
