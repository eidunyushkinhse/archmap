/// <reference types="node" />
// Node-типы точечно (как в pipelineReplay): раннер читает вход и пишет SVG-мокапы.
// МОКАПЫ ФОРМ АВТОРАСКЛАДКИ (перф-эпик 2026-08-20, Ф1/Ф4): гонит захваченный вход
// конвейера (см. perf-probe --capture) через computeViewLayout с РАЗНЫМИ опциями ELK
// (__archmapElkOverride) и БЕЗ сохранённых позиций (viewLayout вычищается — дефолтная
// раскладка с нуля), результат рендерит структурным SVG (узлы/маршруты/подписи).
// Запуск (из frontend/):
//   ARCHMAP_MOCKUP=<вход.json> ARCHMAP_MOCKUP_OUT=<каталог> npx vitest run layoutMockup
// Пишет <каталог>/<база-входа>.<вариант>.svg. Без переменных тест скипается.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { computeViewLayout, edgeLabelMeta, type PipelineInput } from "../graph/layout/pipeline";
import { NODE_W, NODE_H } from "../graph/constants";

const file = process.env.ARCHMAP_MOCKUP;
const outDir = process.env.ARCHMAP_MOCKUP_OUT ?? ".";

// Варианты формы (Ф1: выбор глазами пользователя). «текущая» — базовая для сравнения.
const VARIANTS: Array<{ key: string; title: string; override: Record<string, string> | null }> = [
  { key: "current", title: "текущая (layered RIGHT)", override: null },
  // «layered + wrapping.MULTI_EDGE» ПРОВЕРЕН И ОТБРОШЕН 2026-08-20: свёртка ELK
  // режет длинные ЦЕПОЧКИ слоёв, а не широкий слой звезды — геометрия совпала
  // с current байт-в-байт на всех четырёх корнях.
  {
    key: "force",
    title: "force (Фрухтерман—Рейнгольд)",
    override: {
      "elk.algorithm": "org.eclipse.elk.force",
      "elk.spacing.nodeNode": "80",
    },
  },
  // «mrtree» ПРОВЕРЕН И ОТБРОШЕН 2026-08-20: форма непоследовательна по эталонам
  // (Zabbix/Grafana — та же вертикальная колонна, аспект 0.45/0.54).
  {
    key: "stress",
    title: "stress (органическая, по расстояниям)",
    override: {
      "elk.algorithm": "org.eclipse.elk.stress",
      "org.eclipse.elk.stress.desiredEdgeLength": "260",
    },
  },
  // ELK radial на графах с циклами взрывает стек (Maximum call stack, elk.bundled) —
  // звезда реализована самописным сеятелем позиций (starPositions), см. ветку custom.
  { key: "star", title: "звезда (хаб в центре, кольца BFS)", override: null },
];

function revive(_k: string, v: unknown): unknown {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.__set)) return new Set(o.__set);
    if (Array.isArray(o.__map)) return new Map(o.__map as [unknown, unknown][]);
  }
  return v;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

describe.skipIf(!file)("мокапы форм автораскладки", () => {
  it("гонит варианты ELK и пишет SVG", async () => {
    const raw = JSON.parse(readFileSync(file!, "utf8"), revive) as PipelineInput;
    mkdirSync(outDir, { recursive: true });
    const base = basename(file!).replace(/\.json$/, "");
    const g = globalThis as unknown as {
      __archmapElkOverride?: Record<string, string>;
      __ARCHMAP_TRACE?: (stage: string, ms: number) => void;
    };
    // тайминги по вариантам: форма меняет геометрию рёбер → цену роутера; пишем
    // разбивку (ELK / роутер / всего) в <база>.timings.json рядом с SVG
    const timings: Record<string, { totalMs: number; elkMs: number; routerMs: number }> = {};
    // отображаемый граф для звезды: берём из прогона «текущей» (проекция уже сделана)
    let displayedForStar: Layout | null = null;
    for (const v of VARIANTS) {
      // вход БЕЗ сохранённых позиций и БЕЗ гистерезиса: дефолтная раскладка с нуля.
      // Для звезды позиции сеются через viewLayout (savedPos перетирает ELK) — роутер
      // и инварианты конвейера работают поверх них штатно.
      const seeded = v.key === "star" && displayedForStar
        ? Object.fromEntries(starPositions(displayedForStar, raw.sizes ?? {}))
        : {};
      const input: PipelineInput = {
        ...raw,
        viewLayout: seeded,
        prevRoutes: undefined, prevEdgeHandles: undefined,
        prevRouteSig: undefined, prevLabelPlacements: undefined,
        scopeNodeIds: undefined,
      };
      if (v.override) g.__archmapElkOverride = v.override;
      else delete g.__archmapElkOverride;
      const marks: Array<{ stage: string; ms: number }> = [];
      g.__ARCHMAP_TRACE = (stage, ms) => marks.push({ stage, ms });
      const t0 = performance.now();
      const out = await computeViewLayout(input);
      delete g.__ARCHMAP_TRACE;
      delete g.__archmapElkOverride;
      timings[v.key] = {
        totalMs: Math.round(performance.now() - t0),
        elkMs: Math.round(marks.filter((m) => m.stage === "ELK уровня").reduce((s, m) => s + m.ms, 0)),
        routerMs: Math.round(marks.filter((m) => m.stage.startsWith("роутер") || m.stage.startsWith("T4") || m.stage.startsWith("нуджинг") || m.stage.startsWith("спрямление") || m.stage.startsWith("плашки")).reduce((s, m) => s + m.ms, 0)),
      };
      if (v.key === "current") displayedForStar = out.layout;
      const svg = renderSvg(out.layout, v.title, raw.sizes ?? {});
      writeFileSync(join(outDir, `${base}.${v.key}.svg`), svg);
      expect(out.layout.positions.size).toBeGreaterThan(0);
    }
    writeFileSync(join(outDir, `${base}.timings.json`), JSON.stringify(timings, null, 2));
  }, 600_000);
});

type Layout = Awaited<ReturnType<typeof computeViewLayout>>["layout"];

// Позиции «звезды»: хаб (максимальная степень) в центре, остальные — кольцами BFS
// по эллипсу; порядок первого кольца — жадная цепочка по взаимной смежности, внешние
// кольца тянутся к среднему углу соседей внутреннего. Возвращает viewLayout-сеянцы
// {x,y} по ЦЕНТРАМ, пересчитанные в верхний-левый угол.
function starPositions(base: Layout, sizes: Record<string, { w: number; h: number }>): Map<string, { x: number; y: number }> {
  const ids: string[] = [
    ...base.nodes.map((n) => n.id),
    ...base.entities.map((e) => e.id),
  ];
  const sizeOf = (id: string): { w: number; h: number } => sizes[id] ?? { w: NODE_W, h: NODE_H };
  const adj = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  for (const grp of base.groupArr) {
    if (!adj.has(grp.source) || !adj.has(grp.target) || grp.source === grp.target) continue;
    adj.get(grp.source)!.add(grp.target);
    adj.get(grp.target)!.add(grp.source);
  }
  const hub = [...ids].sort((a, b) => (adj.get(b)!.size - adj.get(a)!.size) || a.localeCompare(b))[0];
  // BFS-глубина от хаба; недостижимые — на внешнее кольцо
  const depth = new Map<string, number>([[hub, 0]]);
  const queue = [hub];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const nb of adj.get(cur)!) {
      if (!depth.has(nb)) { depth.set(nb, depth.get(cur)! + 1); queue.push(nb); }
    }
  }
  let maxD = 0;
  for (const d of depth.values()) maxD = Math.max(maxD, d);
  for (const id of ids) if (!depth.has(id)) depth.set(id, maxD + 1);
  const rings = new Map<number, string[]>();
  for (const id of ids) {
    if (id === hub) continue;
    const d = depth.get(id)!;
    let ring = rings.get(d);
    if (!ring) { ring = []; rings.set(d, ring); }
    ring.push(id);
  }
  const angleOf = new Map<string, number>([[hub, 0]]);
  const pos = new Map<string, { x: number; y: number }>();
  const hubS = sizeOf(hub);
  pos.set(hub, { x: -hubS.w / 2, y: -hubS.h / 2 });
  let prevR = 0;
  for (const d of [...rings.keys()].sort((a, b) => a - b)) {
    const ring = rings.get(d)!;
    // порядок: первое кольцо — жадная цепочка по смежности (связанные соседствуют),
    // внешние — сортировка по желаемому углу (среднему углу соседей внутри)
    let ordered: string[];
    if (d === 1) {
      const rest = new Set(ring);
      ordered = [];
      let cur = [...ring].sort((a, b) => (adj.get(b)!.size - adj.get(a)!.size) || a.localeCompare(b))[0];
      ordered.push(cur); rest.delete(cur);
      while (rest.size > 0) {
        let best: string | null = null, bestScore = -1;
        for (const cand of rest) {
          const score = adj.get(cur)!.has(cand) ? 1 : 0;
          if (score > bestScore || (score === bestScore && (best === null || cand < best))) { best = cand; bestScore = score; }
        }
        cur = best!;
        ordered.push(cur); rest.delete(cur);
      }
    } else {
      const desired = (id: string): number => {
        const anchors = [...adj.get(id)!].filter((nb) => angleOf.has(nb) && nb !== hub);
        if (anchors.length === 0) return Math.PI; // сироты — вниз
        let sx = 0, sy = 0;
        for (const a of anchors) { sx += Math.cos(angleOf.get(a)!); sy += Math.sin(angleOf.get(a)!); }
        return Math.atan2(sy, sx);
      };
      ordered = [...ring].sort((a, b) => (desired(a) - desired(b)) || a.localeCompare(b));
    }
    // радиус: окружность вмещает тела с зазором; эллипс шире, чем выше (экран)
    const need = ordered.reduce((s, id) => s + sizeOf(id).w + 70, 0);
    const r = Math.max(prevR + 240, need / (2 * Math.PI * 1.08));
    prevR = r;
    ordered.forEach((id, i) => {
      const a = (2 * Math.PI * i) / ordered.length - Math.PI / 2;
      angleOf.set(id, a);
      const s = sizeOf(id);
      pos.set(id, { x: 1.35 * r * Math.cos(a) - s.w / 2, y: 0.78 * r * Math.sin(a) - s.h / 2 });
    });
  }
  return pos;
}

// Структурный SVG-мокап: тела узлов с именами, ортомаршруты, плашки подписей.
// Не пиксель-точная копия холста — честная СТРУКТУРА раскладки для выбора формы.
function renderSvg(layout: Layout, title: string, sizes: Record<string, { w: number; h: number }>): string {
  const rects: Array<{ x: number; y: number; w: number; h: number; name: string; sub: string; ext: boolean }> = [];
  const sizeOf = (id: string): { w: number; h: number } => sizes[id] ?? { w: NODE_W, h: NODE_H };
  for (const n of layout.nodes) {
    const p = layout.positions.get(n.id);
    if (!p) continue;
    const s = sizeOf(n.id);
    rects.push({ x: p.x, y: p.y, w: s.w, h: s.h, name: n.name, sub: n.role ?? "", ext: n.is_external });
  }
  for (const e of layout.entities) {
    const p = layout.positions.get(e.id);
    if (!p) continue;
    const s = sizeOf(e.id);
    const name = e.kind === "leaf" ? e.ghost.name : e.name;
    const ext = e.kind === "leaf" ? e.ghost.is_external : e.is_external;
    rects.push({ x: p.x, y: p.y, w: s.w, h: s.h, name, sub: "(гость)", ext });
  }
  const paths: string[] = [];
  const labels: Array<{ x: number; y: number; text: string }> = [];
  for (const grp of layout.groupArr) {
    const rt = layout.autoRoutes?.get(grp.id);
    if (rt && rt.length >= 2) {
      paths.push(rt.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "));
    }
    const lp = layout.labelPlacements?.get(grp.id);
    const meta = edgeLabelMeta(grp);
    if (lp && meta) labels.push({ x: lp.center.x, y: lp.center.y, text: meta.text.slice(0, 36) });
  }
  // рамки раскрытий (на свёрнутых корнях обычно пусто, но пусть будут)
  const frames = layout.guestFrames.map((f) => f.rect);

  const xs = [...rects.map((r) => r.x), ...rects.map((r) => r.x + r.w)];
  const ys = [...rects.map((r) => r.y), ...rects.map((r) => r.y + r.h)];
  const minX = Math.min(...xs) - 60, maxX = Math.max(...xs) + 60;
  const minY = Math.min(...ys) - 80, maxY = Math.max(...ys) + 60;
  const w = maxX - minX, h = maxY - minY;

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${w} ${h}" font-family="system-ui, sans-serif">`);
  parts.push(`<rect x="${minX}" y="${minY}" width="${w}" height="${h}" fill="#fafafa"/>`);
  parts.push(`<text x="${minX + 16}" y="${minY + 28}" font-size="18" font-weight="600" fill="#333">${esc(title)}</text>`);
  parts.push(`<defs><marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="#7a8699"/></marker></defs>`);
  for (const f of frames) {
    parts.push(`<rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" fill="none" stroke="#b9c2d0" stroke-dasharray="6 4" rx="10"/>`);
  }
  for (const d of paths) parts.push(`<path d="${d}" fill="none" stroke="#7a8699" stroke-width="1.4" marker-end="url(#arr)"/>`);
  for (const r of rects) {
    parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="8" fill="#fff" stroke="${r.ext ? "#9aa4b2" : "#4a6fa5"}" stroke-width="1.6"${r.ext ? ' stroke-dasharray="5 3"' : ""}/>`);
    parts.push(`<text x="${r.x + r.w / 2}" y="${r.y + r.h / 2 - 2}" font-size="12" font-weight="600" text-anchor="middle" fill="#222">${esc(r.name.slice(0, 28))}</text>`);
    if (r.sub) parts.push(`<text x="${r.x + r.w / 2}" y="${r.y + r.h / 2 + 13}" font-size="10" text-anchor="middle" fill="#777">${esc(r.sub.slice(0, 30))}</text>`);
  }
  for (const l of labels) {
    parts.push(`<text x="${l.x}" y="${l.y}" font-size="9" text-anchor="middle" fill="#8a5a2b" paint-order="stroke" stroke="#fafafa" stroke-width="5">${esc(l.text)}</text>`);
  }
  parts.push("</svg>");
  return parts.join("\n");
}
