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
  {
    key: "wrap",
    title: "layered + свёртка слоёв (аспект 1.6)",
    override: {
      "elk.layered.wrapping.strategy": "MULTI_EDGE",
      "elk.aspectRatio": "1.6",
    },
  },
  {
    key: "stress",
    title: "stress (органическая, по расстояниям)",
    override: {
      "elk.algorithm": "org.eclipse.elk.stress",
      "org.eclipse.elk.stress.desiredEdgeLength": "260",
    },
  },
  {
    key: "radial",
    title: "radial (звезда от корня)",
    override: {
      "elk.algorithm": "org.eclipse.elk.radial",
      "elk.spacing.nodeNode": "60",
    },
  },
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
    const g = globalThis as unknown as { __archmapElkOverride?: Record<string, string> };
    for (const v of VARIANTS) {
      // вход БЕЗ сохранённых позиций и БЕЗ гистерезиса: дефолтная раскладка с нуля
      const input: PipelineInput = {
        ...raw,
        viewLayout: {},
        prevRoutes: undefined, prevEdgeHandles: undefined,
        prevRouteSig: undefined, prevLabelPlacements: undefined,
        scopeNodeIds: undefined,
      };
      if (v.override) g.__archmapElkOverride = v.override;
      else delete g.__archmapElkOverride;
      const out = await computeViewLayout(input);
      delete g.__archmapElkOverride;
      const svg = renderSvg(out.layout, v.title, raw.sizes ?? {});
      writeFileSync(join(outDir, `${base}.${v.key}.svg`), svg);
      expect(out.layout.positions.size).toBeGreaterThan(0);
    }
  }, 600_000);
});

type Layout = Awaited<ReturnType<typeof computeViewLayout>>["layout"];

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
    parts.push(`<text x="${l.x}" y="${l.y}" font-size="9" text-anchor="middle" fill="#8a5a2b" paint-order="stroke" stroke="#fafafa" stroke-width="2.5">${esc(l.text)}</text>`);
  }
  parts.push("</svg>");
  return parts.join("\n");
}
