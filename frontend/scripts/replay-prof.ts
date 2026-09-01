/// <reference types="node" />
// ПОСТОЯННЫЙ РЕПЛЕЙ КОНВЕЙЕРА (Ф0 эпика «глубокая оптимизация роутера», 2026-08-21).
// Гонит захваченный вход раскладки оффлайн — без браузера, БД и воркера — и печатает
// в stderr атрибуцию: тайминги стадий с дельтами ВСЕХ счётчиков роутера, сводку
// T4-диагностики и итоговую гистограмму экспансий на вызов A*. Требование В8.2 плана:
// атрибуция обязана быть воспроизводимой (прежний одноразовый скрипт жил в скретчпаде).
//
// Запуск СТРОГО из frontend/ (иначе vite-node молча возьмёт не тот контекст):
//   npx vite-node scripts/replay-prof.ts <вход.json> [--dump <файл.json>]
// Под V8-профилем (мишени микрооптимизаций):
//   NODE_OPTIONS="--cpu-prof --cpu-prof-dir=<каталог>" npx vite-node scripts/replay-prof.ts <вход.json>
//
// Вход — снимок PipelineInput, снятый в браузере хуком __archmapCaptureInput
// (Set/Map сериализованы как {"__set": [...]} / {"__map": [...]}, см. revive).
// --dump кладёт СТРУКТУРНЫЙ снимок результата (маршруты + тела узлов + плашки) —
// им сверяется байт-в-байт равенство маршрутов до и после оптимизаций.
import { readFileSync, writeFileSync } from "node:fs";
import { computeViewLayout, edgeLabelMeta, type PipelineInput, type T4Diag } from "../src/components/graph/layout/pipeline";
import { __routeCounters as rc } from "../src/components/graph/layout/orthoRoute";
import { metaLabelBox } from "../src/components/graph/layout/labelBox";
import { NODE_W, NODE_H } from "../src/components/graph/constants";

// ── аргументы ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const inputFile = argv[0];
const dumpAt = argv.indexOf("--dump");
const dumpFile = dumpAt >= 0 ? argv[dumpAt + 1] : undefined;
if (!inputFile || (dumpAt >= 0 && !dumpFile)) {
  console.error("использование: npx vite-node scripts/replay-prof.ts <вход.json> [--dump <файл.json>]");
  process.exit(2);
}

// Оживление снимка: Set/Map в JSON не выживают — захват кладёт их метками.
function revive(_k: string, v: unknown): unknown {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.__set)) return new Set(o.__set);
    if (Array.isArray(o.__map)) return new Map(o.__map as [unknown, unknown][]);
  }
  return v;
}
const input = JSON.parse(readFileSync(inputFile, "utf8"), revive) as PipelineInput;

// ── снимок счётчиков (для дельт по стадиям) ─────────────────────────────────────
interface Snap {
  calls: number; exp: number; mc: number;
  ripCalls: number; ripExp: number;
  weldTails: number; weldCalls: number; weldExp: number;
  retries: number; chainOk: number; chainNull: number;
  prepMs: number; floodMs: number; failed: number;
}
const snap = (): Snap => ({
  calls: rc.routePortsCalls, exp: rc.expansions, mc: rc.moveCostCalls,
  ripCalls: rc.ripupCalls, ripExp: rc.ripupExpansions,
  weldTails: rc.weldTails, weldCalls: rc.weldCalls, weldExp: rc.weldExpansions,
  retries: rc.marginRetries, chainOk: rc.marginChainOk, chainNull: rc.marginChainNull,
  prepMs: rc.prepMs, floodMs: rc.floodMs, failed: rc.failedExpansions,
});
const diff = (a: Snap, b: Snap): Snap => {
  const out = {} as Snap;
  for (const k of Object.keys(a) as (keyof Snap)[]) out[k] = a[k] - b[k];
  return out;
};
const M = (n: number): string => `${(n / 1e6).toFixed(2)}M`;
const ms = (n: number): string => `${Math.round(n)}мс`;

// ── трасса стадий ───────────────────────────────────────────────────────────────
const traceG = globalThis as unknown as {
  __ARCHMAP_TRACE?: (stage: string, msSpent: number) => void;
  __ARCHMAP_T4_DIAG?: (d: T4Diag) => void;
};
let prev = snap();
traceG.__ARCHMAP_TRACE = (stage, msSpent) => {
  const now = snap();
  const d = diff(now, prev);
  prev = now;
  const parts = [`${Math.round(msSpent).toString().padStart(7)}мс  ${stage.padEnd(48)}`];
  parts.push(`A*=${d.calls} exp=${M(d.exp)} mc=${M(d.mc)}`);
  if (d.ripCalls || d.ripExp) parts.push(`| rip-up ${d.ripCalls}/${M(d.ripExp)}`);
  if (d.weldTails || d.weldCalls) parts.push(`| сварка ${d.weldTails}хв ${d.weldCalls}выз/${M(d.weldExp)}`);
  if (d.calls) {
    const first = d.calls - d.ripCalls - d.weldCalls;
    const firstExp = d.exp - d.ripExp - d.weldExp;
    parts.push(`| проход-1 ${first}/${M(firstExp)}`);
  }
  if (d.retries) parts.push(`| ретраи ${d.retries} (цепочек ok=${d.chainOk} null=${d.chainNull})`);
  if (d.prepMs >= 1 || d.floodMs >= 1) parts.push(`| prep ${ms(d.prepMs)} flood ${ms(d.floodMs)}`);
  console.error(parts.join(" "));
};

// ── сводка T4-диагностики ───────────────────────────────────────────────────────
const t4: T4Diag[] = [];
traceG.__ARCHMAP_T4_DIAG = (d) => { t4.push(d); };

// ── прогон ──────────────────────────────────────────────────────────────────────
const t0 = performance.now();
const out = await computeViewLayout(input);
const total = performance.now() - t0;
const routes = out.layout.autoRoutes ?? new Map<string, { x: number; y: number }[]>();
console.error(`ИТОГО ${ms(total)}, маршрутов ${routes.size}`);

for (const d of t4) {
  const hist = new Map<number, number>();
  for (const c of d.cutDepths) hist.set(c.depth, (hist.get(c.depth) ?? 0) + 1);
  const cells = [2, 4, 6, 8, 10, 12]
    .map((k) => `${k === 12 ? ">10" : `≤${k}`}:${hist.get(k) ?? 0}`)
    .join(" ");
  console.error(
    `T4-diag: |dirty|=${d.dirtyIds.length}, из них конец-рамка ${d.frameEndDirtyIds.length}` +
    ` (${d.dirtyIds.length ? Math.round((100 * d.frameEndDirtyIds.length) / d.dirtyIds.length) : 0}%)` +
    `; глубина вреза: ${cells}`,
  );
  // labelFirst появился в Ф4-II; на дампах/сборках без него скрипт обязан не падать —
  // им же гоняются контрольные зонды со старым конвейером.
  const lf: T4Diag["labelFirst"] | undefined = d.labelFirst;
  if (lf) {
    console.error(
      `  Б3б: конфликтов ${lf.conflicts} на ${lf.victims} плашках-жертвах;` +
      ` переехало ${lf.moved}; рёбер было бы грязных ${lf.dirtyBefore} →` +
      ` снято плашкой ${lf.solvedEdges}, осталось нерешённых ${d.dirtyIds.length}`,
    );
  }
  if (d.finalRepair) {
    console.error(
      `  Б3б-финал: конфликтов после пере-размещения ${d.finalRepair.conflicts}` +
      ` на ${d.finalRepair.victims} плашках; переехало ${d.finalRepair.moved}`,
    );
  }
}
if (t4.length === 0) console.error("T4-diag: мини-проход не запускался (грязных рёбер нет либо стадии качества пропущены)");

// ── итоговые счётчики ───────────────────────────────────────────────────────────
const first = rc.routePortsCalls - rc.ripupCalls - rc.weldCalls;
const firstExp = rc.expansions - rc.ripupExpansions - rc.weldExpansions;
console.error(
  `счётчики: A* ${rc.routePortsCalls} вызовов, экспансий ${M(rc.expansions)},` +
  ` moveCost ${M(rc.moveCostCalls)}, failed ${M(rc.failedExpansions)}`,
);
console.error(
  `  фазы: проход-1 ${first}/${M(firstExp)} · rip-up ${rc.ripupCalls}/${M(rc.ripupExpansions)}` +
  ` · сварка ${rc.weldTails}хв ${rc.weldCalls}выз/${M(rc.weldExpansions)}`,
);
console.error(`  подготовка: prepareGrid ${ms(rc.prepMs)}, flood-fill ${ms(rc.floodMs)}`);
console.error(
  `  маргин-ретраи: ${rc.marginRetries} вызовов; цепочек: успех на пониженной ступени` +
  ` ${rc.marginChainOk}, дошли до null ${rc.marginChainNull}`,
);
// СТУПЕНЬ 1 БЮДЖЕТА (Ф5, perf.md P13): на эталонах обязана быть нулём — потолок вызова
// взят ~3× от максимума гистограммы. Ненулевое значение здесь означает, что сцена
// вышла за огибающую эталонов, и часть маршрутов доигрывалась гриди-фолбэком.
console.error(`  гриди-фолбэк потолка вызова: ${rc.budgetGreedyCalls} вызовов`);

// Гистограмма экспансий на вызов + грубые медиана/P95 (по бакетам: точнее — только
// пофакторный сбор, а он в горячем цикле запрещён).
const EDGES = ["≤100", "≤300", "≤1e3", "≤3e3", "≤1e4", "≤3e4", "≤1e5", ">1e5"];
const buckets = [...rc.expBuckets];
const totalCalls = buckets.reduce((a, b) => a + b, 0);
console.error(
  `  экспансий/вызов: ${buckets.map((n, i) => `${EDGES[i]}:${n}`).join(" ")}` +
  ` · max ${rc.maxExpansionsPerCall}`,
);
const quantile = (q: number): string => {
  const target = q * totalCalls;
  let acc = 0;
  for (let i = 0; i < buckets.length; i++) {
    acc += buckets[i];
    if (acc >= target) return EDGES[i];
  }
  return EDGES[EDGES.length - 1];
};
if (totalCalls > 0) {
  console.error(`  распределение (по бакетам): медиана ${quantile(0.5)}, P95 ${quantile(0.95)}, P99 ${quantile(0.99)}`);
}

// ── структурный дамп результата (сверка байт-в-байт) ────────────────────────────
if (dumpFile) {
  const byId = (a: string, b: string): number => a.localeCompare(b);
  const routesOut = [...routes].sort(([a], [b]) => byId(a, b));

  // Тела ОТОБРАЖАЕМЫХ узлов (рамки — не тела и сюда не идут).
  const displayIds = [
    ...out.layout.nodes.map((n) => n.id),
    ...out.layout.entities.map((e) => e.id),
  ];
  const rects: { id: string; x: number; y: number; w: number; h: number }[] = [];
  for (const id of displayIds) {
    const p = out.layout.positions.get(id);
    if (!p) continue;
    const s = input.sizes?.[id];
    rects.push({ id, x: p.x, y: p.y, w: s?.w ?? NODE_W, h: s?.h ?? NODE_H });
  }
  rects.sort((a, b) => byId(a.id, b.id));

  // Плашки подписей: центр из размещения, габарит — единой оценкой metaLabelBox.
  const groupById = new Map(out.layout.groupArr.map((g) => [g.id, g]));
  const labels: [string, { x: number; y: number; w: number; h: number }][] = [];
  for (const [id, lp] of out.layout.labelPlacements ?? []) {
    const g = groupById.get(id);
    const meta = g ? edgeLabelMeta(g) : null;
    if (!meta) continue;
    const box = metaLabelBox(meta);
    labels.push([id, { x: lp.center.x - box.w / 2, y: lp.center.y - box.h / 2, w: box.w, h: box.h }]);
  }
  labels.sort(([a], [b]) => byId(a, b));

  writeFileSync(dumpFile, JSON.stringify({ routes: routesOut, rects, labels }));
  console.error(`дамп → ${dumpFile} (маршрутов ${routesOut.length}, тел ${rects.length}, плашек ${labels.length})`);
}
