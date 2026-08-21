/// <reference types="node" />
// CLI отчёта КАЧЕСТВА маршрутов по дампу сцены (Ф0 эпика «глубокая оптимизация
// роутера», docs/plan-router-deep-opt.md § «Метрики качества»).
//
// Запуск ИЗ frontend/ (иначе vite не найдёт корень проекта):
//   npx vite-node scripts/route-quality.ts <dump.json>
//   npx vite-node scripts/route-quality.ts <до.json> <после.json>
//   npx vite-node scripts/route-quality.ts <dump.json> --assert    # exit 1 при нарушении «обязано 0»
//
// --assert: на ОДНОМ дампе роняет при абсолютном значении > 0 (честный показ), на
// ПАРЕ дампов — только при НОВОМ нарушении (after > before): известный дефект
// базлайна не должен ронять каждое сравнение (см. шапку routeQualityMetrics.ts).
//
// Формат дампа (routeQualityMetrics.RouteDump — согласован с реплей-скриптом
// атрибуции, менять нельзя):
//   { "routes": [[groupId, [{x,y}, …]], …],
//     "rects":  [{id,x,y,w,h}, …],            // тела узлов (и плашки рамок, если есть)
//     "labels": [[groupId, {x,y,w,h}], …] }   // плашки подписей связей
// rects/labels можно опустить — тогда соответствующие метрики выйдут нулевыми (CLI
// об этом предупреждает). Принимается и ГОЛЫЙ МАССИВ маршрутов `[[id, [{x,y}…]], …]`
// — в таком виде их пишет harness байт-в-байт дампов (routes-*.json).
import { readFileSync } from "node:fs";
import {
  measureQuality, compareQuality, METRIC_ORDER, METRIC_LABELS, MUST_BE_ZERO,
  type QualityMetrics, type RouteDump,
} from "../src/components/graph/layout/routeQualityMetrics";

const COUNTERS: ReadonlyArray<keyof QualityMetrics> = [
  "crosses", "bends", "throughBodies", "throughLabels", "portConflicts", "reversals", "hairpins",
];

const fmt = (metric: keyof QualityMetrics, v: number): string =>
  COUNTERS.includes(metric) ? String(v) : v.toFixed(1);

// Чтение и минимальная валидация дампа: внятная ошибка лучше падения на undefined.
function readDump(path: string): RouteDump {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${path}: ожидался объект дампа`);
  }
  // голый массив маршрутов (routes-*.json от harness'а байт-в-байт) — тоже вход
  if (Array.isArray(parsed)) {
    return { routes: parsed as RouteDump["routes"], rects: [], labels: [] };
  }
  const o = parsed as Partial<RouteDump>;
  if (!Array.isArray(o.routes)) {
    throw new Error(
      `${path}: нет поля routes (ожидается {routes, rects?, labels?} либо голый массив пар [id, точки])`,
    );
  }
  return {
    routes: o.routes,
    rects: Array.isArray(o.rects) ? o.rects : [],
    labels: Array.isArray(o.labels) ? o.labels : [],
  };
}

const head = (path: string, dump: RouteDump): string => {
  const name = path.split("/").pop() ?? path;
  // Предупреждение вместо тихого нуля: без тел «сквозь тела = 0» читалось бы как
  // «чисто», хотя метрика просто не измерима на таком дампе.
  const gaps = [
    dump.rects.length === 0 ? "тел нет → E19 не измерим" : "",
    dump.labels.length === 0 ? "плашек нет → T4 не измерим" : "",
  ].filter(Boolean);
  return `${name}: маршрутов ${dump.routes.length}, тел ${dump.rects.length}, ` +
    `плашек ${dump.labels.length}${gaps.length > 0 ? `  ⚠ ${gaps.join(", ")}` : ""}`;
};

const LABEL_W = 32;

function printOne(m: QualityMetrics): void {
  for (const metric of METRIC_ORDER) {
    const flag = MUST_BE_ZERO.includes(metric) ? (m[metric] > 0 ? "  ✗ НАРУШЕНО" : "  ✓") : "";
    console.log(`  ${METRIC_LABELS[metric].padEnd(LABEL_W)}${fmt(metric, m[metric]).padStart(12)}${flag}`);
  }
}

// Печатает таблицу сравнения и возвращает НОВЫЕ нарушения инвариантов (after > before):
// известный дефект базлайна гейт не роняет — см. шапку routeQualityMetrics.ts.
function printDiff(a: QualityMetrics, b: QualityMetrics): string[] {
  const cmp = compareQuality(a, b);
  console.log(`  ${"метрика".padEnd(LABEL_W)}${"до".padStart(12)}${"после".padStart(12)}${"Δ".padStart(12)}${"%".padStart(9)}`);
  for (const row of cmp.rows) {
    const pct = row.pct === null ? "—" : `${row.pct > 0 ? "+" : ""}${row.pct.toFixed(1)}%`;
    const delta = `${row.delta > 0 ? "+" : ""}${fmt(row.metric, row.delta)}`;
    const flag = row.violated ? "  ✗ НАРУШЕНО" : row.worse ? "  хуже" : "";
    console.log(
      `  ${row.label.padEnd(LABEL_W)}${fmt(row.metric, row.before).padStart(12)}` +
      `${fmt(row.metric, row.after).padStart(12)}${delta.padStart(12)}${pct.padStart(9)}${flag}`,
    );
  }
  if (cmp.violations.length > 0) {
    console.log("\nНОВЫЕ НАРУШЕНИЯ ИНВАРИАНТОВ «обязано быть 0»:");
    for (const v of cmp.violations) console.log(`  • ${v}`);
  }
  return cmp.violations;
}

function main(): number {
  const argv = process.argv.slice(2);
  const assertMode = argv.includes("--assert");
  const files = argv.filter((a) => !a.startsWith("--"));
  if (files.length === 0 || files.length > 2) {
    console.error(
      "Использование (из frontend/):\n" +
      "  npx vite-node scripts/route-quality.ts <dump.json> [<dump2.json>] [--assert]",
    );
    return 2;
  }

  const dumpA = readDump(files[0]);
  const a = measureQuality(dumpA);
  console.log(head(files[0], dumpA));
  if (files.length === 1) {
    printOne(a);
    const violated = MUST_BE_ZERO.filter((k) => a[k] > 0);
    if (violated.length > 0) {
      console.log(`\nНАРУШЕНЫ ИНВАРИАНТЫ «обязано быть 0»: ${violated.map((k) => `${METRIC_LABELS[k]} = ${a[k]}`).join(", ")}`);
    }
    return assertMode && violated.length > 0 ? 1 : 0;
  }

  const dumpB = readDump(files[1]);
  const b = measureQuality(dumpB);
  console.log(head(files[1], dumpB));
  console.log("");
  const newViolations = printDiff(a, b);
  return assertMode && newViolations.length > 0 ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 2;
}
