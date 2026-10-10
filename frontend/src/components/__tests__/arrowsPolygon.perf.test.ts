/// <reference types="node" />
// Node-типы точечно: полигон (и только он) читает сцены с диска и пишет отчёт —
// app-tsconfig остаётся браузерным, Node-глобалы в код приложения не протекают.
//
// ПОЛИГОН ЭПИКА «СТРЕЛКИ БЕЗ ЖЁСТКИХ ХЭНДЛОВ» (docs/plan-arrows-ports.md, Ф0).
//
// Вход — захваченные входы конвейера (как у pipelineReplay: __archmapCaptureInput →
// JSON с {__set}/{__map}), по файлу на сцену. Для каждой сцены считаются варианты:
//   now        — как сейчас: конвейер на захваченных позициях;
//   elk-down   — узлы расставляет ELK layered сверху вниз с РЕАЛЬНЫМИ габаритами и
//                подписями как объектами раскладки; стрелки кладёт наш конвейер на
//                этих позициях (prev-контекста нет — холодный прогон);
//   elk-right  — то же слева направо;
//   moved      — позиции elk-down, два узла сдвинуты «рукой» (сосед хаба — вбок на
//                высоту хаба, второй сосед — вниз): стрелки нашего конвейера после
//                ручного сдвига.
// Для elk-* рядом считаются маршруты САМОГО ELK (sections) — бесплатный эталон
// «как было бы у Mermaid» на тех же позициях: по ним те же метрики и сравнение
// портов/маршрутов с нашими.
//
// Метрики: routeQualityMetrics (кресты, езда, изломы, длина, сквозь тела/плашки,
// конфликты портов) + метрики портов и подписей этого эпика (общие точки стыковки,
// минимальный шаг портов на стороне, доля концов на сторонах оси потока, выноски,
// коэффициент обхода). Отчёт — <dir>/report.md и report.json, картинки — <dir>/svg/.
//
// Запуск (из frontend/):
//   ARCHMAP_ARROWS_POLYGON=<каталог со сценами *.json> npx vitest run arrowsPolygon
// Без переменной тест скипается — обычный прогон сьюта не задет.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import {
  computeViewLayout, edgeLabelMeta, type PipelineInput, type PipelineOutput,
} from "../graph/layout/pipeline";
import { getElk } from "../graph/layout/engine";
import { flowSpacing } from "../graph/layout/flowGaps";
import { metaLabelBox } from "../graph/layout/labelBox";
import {
  measureQuality, METRIC_ORDER, type QualityMetrics, type RouteDump,
} from "../graph/layout/routeQualityMetrics";
import { cleanup } from "../graph/edgePath";
import { NODE_W, NODE_H } from "../graph/constants";
import type { EdgePoint } from "../../types";

const dir = process.env.ARCHMAP_ARROWS_POLYGON;

// обратное преобразование сериализации зонда: {__set:[…]} → Set, {__map:[…]} → Map
function revive(_k: string, v: unknown): unknown {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.__set)) return new Set(o.__set);
    if (Array.isArray(o.__map)) return new Map(o.__map as [unknown, unknown][]);
  }
  return v;
}

interface Rect { x: number; y: number; w: number; h: number }
type Side = "top" | "right" | "bottom" | "left";
type Dir = "DOWN" | "RIGHT";

/** Сцена после прогона: всё, что нужно метрикам и картинке. */
interface Scene {
  rects: Map<string, Rect>;                 // тела узлов (без рамок)
  locals: Set<string>;                      // локальные узлы уровня (остальные — гости)
  insideLevel: boolean;                     // уровень контейнера: локалы внутри родной рамки
  frames: Array<{ id: string; name: string; rect: Rect; members: Set<string> }>;
  names: Map<string, string>;
  groups: Array<{ id: string; source: string; target: string; members: PipelineOutput["layout"]["groupArr"][number]["members"]; label: { text: string; w: number; h: number } | null }>;
  routes: Map<string, EdgePoint[]>;
  labels: Map<string, { rect: Rect; leader: boolean }>;
}

// ── сцена из результата конвейера ─────────────────────────────────────────────

function nameMap(input: PipelineInput): Map<string, string> {
  const m = new Map<string, string>();
  for (const n of input.nodes) m.set(n.id, n.name);
  for (const kids of Object.values(input.localChildren)) for (const k of kids) m.set(k.id, k.name);
  for (const g of input.endpoints) {
    m.set(g.id, g.name);
    for (const a of g.ancestors ?? []) m.set(a.id, a.name);
  }
  return m;
}

function sceneOf(input: PipelineInput, out: PipelineOutput): Scene {
  const L = out.layout;
  const names = nameMap(input);
  const rects = new Map<string, Rect>();
  const sizeOf = (id: string): { w: number; h: number } => input.sizes?.[id] ?? { w: NODE_W, h: NODE_H };
  const ids = [...L.nodes.map((n) => n.id), ...L.entities.map((e) => e.id)];
  for (const id of ids) {
    const p = L.positions.get(id);
    if (!p) continue;
    rects.set(id, { x: p.x, y: p.y, ...sizeOf(id) });
  }
  const frames = L.guestFrames.map((f) => ({ id: f.id, name: f.name, rect: { ...f.rect }, members: new Set(f.memberIds) }));
  const groups = L.groupArr.map((g) => {
    const meta = edgeLabelMeta(g);
    const box = meta ? metaLabelBox(meta) : null;
    return { id: g.id, source: g.source, target: g.target, members: g.members, label: meta && box ? { text: meta.text, w: box.w, h: box.h } : null };
  });
  const locals = new Set(L.nodes.map((n) => n.id));
  const insideLevel = input.containerId != null;
  const routes = new Map<string, EdgePoint[]>();
  for (const [id, pts] of L.autoRoutes ?? []) routes.set(id, cleanup(pts.map((p) => ({ x: p.x, y: p.y }))));
  const labels = new Map<string, { rect: Rect; leader: boolean }>();
  for (const g of groups) {
    const pl = L.labelPlacements?.get(g.id);
    if (!pl || !g.label) continue;
    labels.set(g.id, {
      rect: { x: pl.center.x - g.label.w / 2, y: pl.center.y - g.label.h / 2, w: g.label.w, h: g.label.h },
      leader: pl.mode === "leader",
    });
  }
  return { rects, locals, insideLevel, frames, names, groups, routes, labels };
}

// ── ELK с реальными габаритами и подписями ─────────────────────────────────────

interface ElkLabel { text: string; width: number; height: number; layoutOptions?: Record<string, string> }
interface ElkNodeIn { id: string; width?: number; height?: number; children?: ElkNodeIn[]; layoutOptions?: Record<string, string> }
interface ElkEdgeIn { id: string; sources: string[]; targets: string[]; labels?: ElkLabel[] }
interface ElkSection { startPoint: EdgePoint; endPoint: EdgePoint; bendPoints?: EdgePoint[] }
interface ElkNodeOut { id: string; x?: number; y?: number; width?: number; height?: number; children?: ElkNodeOut[] }
interface ElkEdgeOut { id: string; sections?: ElkSection[]; container?: string; labels?: Array<{ x?: number; y?: number; width?: number; height?: number }> }
interface ElkGraphOut extends ElkNodeOut { edges?: ElkEdgeOut[] }

/** Раскладка ELK той же сцены: позиции (абсолютные) и маршруты ELK (эталон). */
async function elkLayout(base: Scene, dirn: Dir): Promise<{
  positions: Map<string, EdgePoint>; routes: Map<string, EdgePoint[]>; labels: Map<string, Rect>;
}> {
  const inFrame = new Map<string, string>();
  for (const f of base.frames) for (const m of f.members) inFrame.set(m, f.id);
  const nodeOf = (id: string): ElkNodeIn => {
    const r = base.rects.get(id)!;
    return { id, width: r.w, height: r.h };
  };
  const frameNodes: ElkNodeIn[] = base.frames.map((f) => ({
    id: f.id,
    children: [...f.members].map(nodeOf),
    layoutOptions: { "elk.padding": "[top=46,left=30,bottom=30,right=30]" },
  }));
  const isLocalFrame = (f: Scene["frames"][number]): boolean => [...f.members].some((m) => base.locals.has(m));
  const free = [...base.rects.keys()].filter((id) => !inFrame.has(id));
  // уровень контейнера: локалы (и их рамки) — внутри родной рамки, гости — снаружи,
  // как на холсте (иначе конвейер выталкивает гостей из рамки и эталон теряет смысл)
  const top: ElkNodeIn[] = base.insideLevel
    ? [
      ...free.filter((id) => !base.locals.has(id)).map(nodeOf),
      ...frameNodes.filter((_, i) => !isLocalFrame(base.frames[i])),
      {
        id: "__level",
        children: [...free.filter((id) => base.locals.has(id)).map(nodeOf), ...frameNodes.filter((_, i) => isLocalFrame(base.frames[i]))],
        layoutOptions: { "elk.padding": "[top=30,left=30,bottom=50,right=30]" },
      },
    ]
    : [...free.map(nodeOf), ...frameNodes];
  const sp = flowSpacing(base.groups.flatMap((g) => g.members));
  const edges: ElkEdgeIn[] = base.groups.map((g) => ({
    id: g.id, sources: [g.source], targets: [g.target],
    labels: g.label ? [{ text: g.label.text, width: g.label.w, height: g.label.h, layoutOptions: { "elk.edgeLabels.inline": "true" } }] : [],
  }));
  const elk = await getElk();
  const res = (await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": dirn,
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.layered.spacing.nodeNodeBetweenLayers": "120",
      "elk.spacing.nodeNode": String(sp.nodeGap),
      "elk.spacing.edgeNode": String(sp.edgeNodeGap),
      "elk.spacing.edgeEdge": String(sp.edgeEdgeGap),
      "elk.layered.spacing.edgeNodeBetweenLayers": String(sp.edgeNodeGap),
      "elk.layered.spacing.edgeEdgeBetweenLayers": String(sp.edgeEdgeGap),
      "elk.spacing.edgeLabel": "6",
      "elk.padding": "[top=30,left=30,bottom=30,right=30]",
    },
    children: top,
    edges,
  } as never)) as unknown as ElkGraphOut;
  // абсолютные позиции: дети рамок относительны рамки
  const positions = new Map<string, EdgePoint>();
  const abs = new Map<string, EdgePoint>([["root", { x: 0, y: 0 }]]);
  const walk = (n: ElkNodeOut, ox: number, oy: number) => {
    for (const c of n.children ?? []) {
      const x = ox + (c.x ?? 0), y = oy + (c.y ?? 0);
      abs.set(c.id, { x, y });
      if (base.rects.has(c.id)) positions.set(c.id, { x, y });
      walk(c, x, y);
    }
  };
  walk(res, 0, 0);
  const routes = new Map<string, EdgePoint[]>();
  const labels = new Map<string, Rect>();
  for (const e of res.edges ?? []) {
    const o = abs.get(e.container ?? "root") ?? { x: 0, y: 0 };
    const s = e.sections?.[0];
    if (!s) continue;
    const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p) => ({ x: p.x + o.x, y: p.y + o.y }));
    routes.set(e.id, cleanup(pts));
    const l = e.labels?.[0];
    if (l && l.x != null && l.y != null) labels.set(e.id, { x: l.x + o.x, y: l.y + o.y, w: l.width ?? 0, h: l.height ?? 0 });
  }
  return { positions, routes, labels };
}

// ── метрики портов и подписей ─────────────────────────────────────────────────

interface PortMetrics {
  endpoints: number;      // концов маршрутов, севших на тело узла
  sharedPorts: number;    // точек стыковки, общих для ≥2 маршрутов
  minPortGap: number;     // минимальный шаг между разными портами одной стороны, px
  flowSideShare: number;  // доля концов на сторонах оси потока (DOWN: top/bottom)
  leaders: number;        // подписей на выноске
  labelsOffRoute: number; // подписей, центр которых дальше 2px от своей линии
  detourMean: number;     // средняя длина маршрута / манхэттен между центрами
  detourMax: number;
}

const EPS = 1.5;
function sideOf(p: EdgePoint, r: Rect): Side | null {
  const inX = p.x >= r.x - EPS && p.x <= r.x + r.w + EPS;
  const inY = p.y >= r.y - EPS && p.y <= r.y + r.h + EPS;
  if (inX && Math.abs(p.y - r.y) <= EPS) return "top";
  if (inX && Math.abs(p.y - (r.y + r.h)) <= EPS) return "bottom";
  if (inY && Math.abs(p.x - r.x) <= EPS) return "left";
  if (inY && Math.abs(p.x - (r.x + r.w)) <= EPS) return "right";
  return null;
}

function distToPolyline(p: EdgePoint, pts: EdgePoint[]): number {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const q = { x: a.x + t * dx, y: a.y + t * dy };
    best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
  }
  return best;
}

function portMetrics(sc: Scene, routes: Map<string, EdgePoint[]>, labels: Map<string, { rect: Rect; leader: boolean }>, dirn: Dir): PortMetrics {
  const byKey = new Map<string, number>();          // квант точки → число маршрутов
  const bySide = new Map<string, number[]>();       // узел|сторона → координаты портов
  let endpoints = 0, flow = 0;
  const flowSides: Side[] = dirn === "DOWN" ? ["top", "bottom"] : ["left", "right"];
  for (const [gid, pts] of routes) {
    const g = sc.groups.find((x) => x.id === gid);
    if (!g || pts.length < 2) continue;
    for (const [p, nid] of [[pts[0], g.source], [pts[pts.length - 1], g.target]] as const) {
      const r = sc.rects.get(nid);
      if (!r) continue;
      const side = sideOf(p, r);
      if (!side) continue;
      endpoints++;
      if (flowSides.includes(side)) flow++;
      const k = `${Math.round(p.x * 2)},${Math.round(p.y * 2)}`;
      byKey.set(k, (byKey.get(k) ?? 0) + 1);
      const sk = `${nid}|${side}`;
      const arr = bySide.get(sk) ?? [];
      arr.push(side === "top" || side === "bottom" ? p.x : p.y);
      bySide.set(sk, arr);
    }
  }
  let sharedPorts = 0;
  for (const n of byKey.values()) if (n >= 2) sharedPorts++;
  let minPortGap = Infinity;
  for (const arr of bySide.values()) {
    const s = [...arr].sort((a, b) => a - b);
    for (let i = 1; i < s.length; i++) {
      const gap = s[i] - s[i - 1];
      if (gap > 1) minPortGap = Math.min(minPortGap, gap);
    }
  }
  let leaders = 0, labelsOffRoute = 0;
  for (const [gid, l] of labels) {
    if (l.leader) leaders++;
    const pts = routes.get(gid);
    const c = { x: l.rect.x + l.rect.w / 2, y: l.rect.y + l.rect.h / 2 };
    if (pts && distToPolyline(c, pts) > 2) labelsOffRoute++;
  }
  // обход: длина ломаной к манхэттену между её же концами (1.0 — прямее не бывает)
  let detSum = 0, detMax = 0, detN = 0;
  for (const [gid, pts] of routes) {
    const g = sc.groups.find((x) => x.id === gid);
    if (!g || g.source === g.target || pts.length < 2) continue;
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
    const a = pts[0], b = pts[pts.length - 1];
    const d = len / Math.max(1, Math.abs(a.x - b.x) + Math.abs(a.y - b.y));
    detSum += d; detMax = Math.max(detMax, d); detN++;
  }
  return {
    endpoints, sharedPorts, minPortGap: Number.isFinite(minPortGap) ? Math.round(minPortGap * 10) / 10 : 0,
    flowSideShare: endpoints ? Math.round((flow / endpoints) * 100) / 100 : 0,
    leaders, labelsOffRoute,
    detourMean: detN ? Math.round((detSum / detN) * 100) / 100 : 0, detourMax: Math.round(detMax * 100) / 100,
  };
}

function qualityOf(sc: Scene, routes: Map<string, EdgePoint[]>, labels: Map<string, { rect: Rect; leader: boolean }>): QualityMetrics {
  const dump: RouteDump = {
    routes: [...routes],
    rects: [...sc.rects].map(([id, r]) => ({ id, ...r })),
    labels: [...labels].map(([id, l]) => [id, l.rect]),
  };
  return measureQuality(dump);
}

/** Отклонение наших маршрутов от эталона ELK на тех же позициях. */
function vsElk(ours: Map<string, EdgePoint[]>, elk: Map<string, EdgePoint[]>): { portDevMean: number; portDevMax: number; samePortsShare: number } {
  let sum = 0, max = 0, n = 0, same = 0;
  for (const [gid, e] of elk) {
    const o = ours.get(gid);
    if (!o || o.length < 2 || e.length < 2) continue;
    for (const [a, b] of [[o[0], e[0]], [o[o.length - 1], e[e.length - 1]]] as const) {
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      sum += d; max = Math.max(max, d); n++;
      if (d <= 4) same++;
    }
  }
  return { portDevMean: n ? Math.round(sum / n) : 0, portDevMax: Math.round(max), samePortsShare: n ? Math.round((same / n) * 100) / 100 : 0 };
}

// ── картинка ──────────────────────────────────────────────────────────────────

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

function svgOf(sc: Scene, routes: Map<string, EdgePoint[]>, labels: Map<string, Rect>, title: string): string {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (r: Rect) => { minX = Math.min(minX, r.x); minY = Math.min(minY, r.y); maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h); };
  for (const r of sc.rects.values()) grow(r);
  for (const f of sc.frames) grow(f.rect);
  for (const l of labels.values()) grow(l);
  for (const pts of routes.values()) for (const p of pts) grow({ x: p.x, y: p.y, w: 0, h: 0 });
  const pad = 24;
  const W = Math.ceil(maxX - minX + 2 * pad), H = Math.ceil(maxY - minY + 2 * pad + 20);
  const tx = (x: number) => (x - minX + pad).toFixed(1), ty = (y: number) => (y - minY + pad + 20).toFixed(1);
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Arial, sans-serif">`);
  parts.push(`<defs><marker id="ah" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,1 L9,5 L0,9 z" fill="#4b5563"/></marker></defs>`);
  parts.push(`<rect width="${W}" height="${H}" fill="#f8fafc"/>`);
  parts.push(`<text x="8" y="14" font-size="12" fill="#334155">${esc(title)}</text>`);
  for (const f of sc.frames) {
    parts.push(`<rect x="${tx(f.rect.x)}" y="${ty(f.rect.y)}" width="${f.rect.w}" height="${f.rect.h}" fill="none" stroke="#94a3b8" stroke-dasharray="6 4"/>`);
    parts.push(`<text x="${tx(f.rect.x + 6)}" y="${ty(f.rect.y + f.rect.h - 6)}" font-size="10" fill="#64748b">${esc(f.name)}</text>`);
  }
  for (const [id, r] of sc.rects) {
    parts.push(`<rect x="${tx(r.x)}" y="${ty(r.y)}" width="${r.w}" height="${r.h}" rx="6" fill="#dbeafe" stroke="#1d4ed8"/>`);
    parts.push(`<text x="${tx(r.x + 8)}" y="${ty(r.y + 18)}" font-size="11" fill="#1e3a8a">${esc((sc.names.get(id) ?? id).slice(0, 26))}</text>`);
  }
  for (const [gid, pts] of routes) {
    const d = pts.map((p, i) => `${i ? "L" : "M"}${tx(p.x)},${ty(p.y)}`).join(" ");
    parts.push(`<path d="${d}" fill="none" stroke="#4b5563" stroke-width="1.4" marker-end="url(#ah)"><title>${esc(gid)}</title></path>`);
    const a = pts[0];
    parts.push(`<circle cx="${tx(a.x)}" cy="${ty(a.y)}" r="2.2" fill="#dc2626"/>`);
  }
  for (const [gid, l] of labels) {
    const text = sc.groups.find((g) => g.id === gid)?.label?.text ?? "";
    parts.push(`<rect x="${tx(l.x)}" y="${ty(l.y)}" width="${l.w}" height="${l.h}" fill="#fff" stroke="#cbd5e1"/>`);
    parts.push(`<text x="${tx(l.x + 4)}" y="${ty(l.y + 12)}" font-size="9" fill="#334155">${esc(text.slice(0, 28))}</text>`);
  }
  parts.push("</svg>");
  return parts.join("\n");
}

// ── варианты ──────────────────────────────────────────────────────────────────

function withPositions(input: PipelineInput, pos: Map<string, EdgePoint>): PipelineInput {
  const viewLayout = { ...input.viewLayout };
  for (const [id, p] of pos) viewLayout[id] = { ...(viewLayout[id] ?? {}), x: p.x, y: p.y };
  return { ...input, viewLayout };
}

// холодный прогон: без prev-контекста и скоупа (иначе гистерезис удержит захваченное)
function stripPrev(input: PipelineInput): PipelineInput {
  const rest: PipelineInput = { ...input };
  delete rest.prevRoutes;
  delete rest.prevEdgeHandles;
  delete rest.prevRouteSig;
  delete rest.prevLabelPlacements;
  delete rest.prevScene;
  delete rest.scopeNodeIds;
  return rest;
}

/** «Ручной сдвиг» двух соседей хаба: один вбок на высоту хаба, другой вниз. */
function movedPositions(sc: Scene): Map<string, EdgePoint> {
  const deg = new Map<string, number>();
  for (const g of sc.groups) { deg.set(g.source, (deg.get(g.source) ?? 0) + 1); deg.set(g.target, (deg.get(g.target) ?? 0) + 1); }
  const hub = [...deg].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
  const pos = new Map<string, EdgePoint>();
  for (const [id, r] of sc.rects) pos.set(id, { x: r.x, y: r.y });
  if (!hub) return pos;
  const hr = sc.rects.get(hub)!;
  const nbrs = [...new Set(sc.groups.filter((g) => g.source === hub || g.target === hub).map((g) => (g.source === hub ? g.target : g.source)))]
    .filter((id) => sc.rects.has(id) && id !== hub)
    .sort((a, b) => sc.rects.get(a)!.x - sc.rects.get(b)!.x);
  const right = nbrs[nbrs.length - 1], left = nbrs[0];
  if (right) pos.set(right, { x: hr.x + hr.w + 160, y: hr.y });
  if (left && left !== right) { const r = sc.rects.get(left)!; pos.set(left, { x: r.x - 120, y: r.y + 260 }); }
  return pos;
}

type Row = { scene: string; variant: string; nodes: number; edges: number; quality: QualityMetrics; ports: PortMetrics; vsElk?: ReturnType<typeof vsElk> };

const PORT_ORDER: ReadonlyArray<keyof PortMetrics> = ["sharedPorts", "minPortGap", "flowSideShare", "leaders", "labelsOffRoute", "detourMean", "detourMax"];

function reportMd(rows: Row[]): string {
  const cols = [...METRIC_ORDER.filter((k) => k !== "illegalOverlapPx" && k !== "overlapPx"), "overlapPx"] as Array<keyof QualityMetrics>;
  const head = ["сцена", "вариант", "узлы/рёбра", ...cols, ...PORT_ORDER, "порт≠ELK ср/макс", "портов как у ELK"];
  const out = [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
  for (const r of rows) {
    const q = cols.map((k) => String(r.quality[k]));
    const p = PORT_ORDER.map((k) => String(r.ports[k]));
    const v = r.vsElk ? [`${r.vsElk.portDevMean}/${r.vsElk.portDevMax}`, String(r.vsElk.samePortsShare)] : ["", ""];
    out.push(`| ${r.scene} | ${r.variant} | ${r.nodes}/${r.edges} | ${[...q, ...p, ...v].join(" | ")} |`);
  }
  return out.join("\n") + "\n";
}

describe.skipIf(!dir)("полигон стрелок (эпик «без жёстких хэндлов»)", () => {
  it("гонит сцены по вариантам и пишет отчёт с картинками", async () => {
    const files = readdirSync(dir!).filter((f) => f.endsWith(".json") && !f.startsWith("report")).sort();
    expect(files.length).toBeGreaterThan(0);
    const svgDir = join(dir!, "svg");
    mkdirSync(svgDir, { recursive: true });
    const rows: Row[] = [];
    const emit = (scene: string, variant: string, sc: Scene, routes: Map<string, EdgePoint[]>, labels: Map<string, { rect: Rect; leader: boolean }>, dirn: Dir, elk?: Map<string, EdgePoint[]>) => {
      rows.push({
        scene, variant, nodes: sc.rects.size, edges: sc.groups.length,
        quality: qualityOf(sc, routes, labels), ports: portMetrics(sc, routes, labels, dirn),
        ...(elk ? { vsElk: vsElk(routes, elk) } : {}),
      });
      const lrects = new Map<string, Rect>([...labels].map(([id, l]) => [id, l.rect]));
      writeFileSync(join(svgDir, `${scene}-${variant}.svg`), svgOf(sc, routes, lrects, `${scene} · ${variant}`));
    };
    for (const f of files) {
      const scene = basename(f, ".json");
      const raw = JSON.parse(readFileSync(join(dir!, f), "utf8"), revive) as PipelineInput;
      const input = stripPrev(raw);
      // now
      const outNow = await computeViewLayout(input);
      const scNow = sceneOf(input, outNow);
      // состав сцены (для отчёта и отладки): локалы, гости, рамки с членами
      writeFileSync(join(svgDir, `${scene}-structure.json`), JSON.stringify({
        containerId: input.containerId,
        locals: outNow.layout.nodes.map((n) => `${n.name} ${n.id.slice(0, 8)}`),
        entities: outNow.layout.entities.map((e) => `${e.kind} ${e.kind === "leaf" ? e.ghost.name : e.name} ${e.id.slice(0, 8)}`),
        frames: scNow.frames.map((fr) => ({ name: fr.name, id: fr.id.slice(0, 8), members: [...fr.members].map((m) => `${scNow.names.get(m) ?? "?"} ${m.slice(0, 8)}`) })),
        groups: scNow.groups.map((g) => `${scNow.names.get(g.source) ?? g.source.slice(0, 8)} → ${scNow.names.get(g.target) ?? g.target.slice(0, 8)}`),
      }, null, 2));
      emit(scene, "now", scNow, scNow.routes, scNow.labels, "RIGHT");
      // elk-down / elk-right: позиции ELK с габаритами и подписями, стрелки наши
      for (const dirn of ["DOWN", "RIGHT"] as const) {
        const elk = await elkLayout(scNow, dirn);
        const inp = withPositions(input, elk.positions);
        const out = await computeViewLayout(inp);
        const sc = sceneOf(inp, out);
        const tag = dirn === "DOWN" ? "elk-down" : "elk-right";
        emit(scene, tag, sc, sc.routes, sc.labels, dirn, elk.routes);
        // эталон: маршруты и подписи самого ELK на тех же позициях
        const elkLabels = new Map<string, { rect: Rect; leader: boolean }>([...elk.labels].map(([id, r]) => [id, { rect: r, leader: false }]));
        emit(scene, `${tag}+elk`, sc, elk.routes, elkLabels, dirn);
        if (dirn === "DOWN") {
          // moved: два соседа хаба сдвинуты рукой
          const mp = movedPositions(sc);
          const inpM = withPositions(inp, mp);
          const outM = await computeViewLayout(inpM);
          const scM = sceneOf(inpM, outM);
          emit(scene, "moved", scM, scM.routes, scM.labels, dirn);
        }
      }
    }
    writeFileSync(join(dir!, "report.json"), JSON.stringify(rows, null, 2));
    writeFileSync(join(dir!, "report.md"), reportMd(rows));
    expect(rows.length).toBeGreaterThan(0);
  }, 900_000);
});
