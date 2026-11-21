/// <reference types="node" />
// ТАБЛИЦА СТАДИЙ ПО НАБОРУ СЦЕН (эпик render-scale, docs/plan-render-scale.md).
// Гонит захваченные входы раскладки оффлайн и печатает по строке на сцену: размер,
// время прогона и его разбивку (ELK, роутер, пост-стадии, прочее), долю роутера и
// счётчики Z-роутера — сколько раз вызван zRoutes и сколько раз он заново оценил цену
// всей сцены (пробы спуска и прохода носителей). replay-prof даёт глубину по одной
// сцене, эта таблица — срез по всем сразу: её и сравнивают до и после правки.
//
// Запуск из frontend/:
//   npm run stage-table -- <вход.json> [<вход.json> …]
// Входы — снимки PipelineInput (scripts/perf-battery.mjs --capture-dir либо
// perf-probe.mjs --capture; Set/Map закодированы метками, см. revive).
//
// Каждая сцена считается дважды: первый прогон — чистый тайминг (ELK и JIT прогреты
// отдельным холостым прогоном, кэш ELK сброшен, как в свежем воркере), второй — с
// отладочным следом Z-роутера ради счётчиков (его время в таблицу не идёт).
// Абсолютные времена под Node примерно в полтора раза выше браузерных; доли и счётчики
// переносимы.
import { readFileSync } from "node:fs";
import { computeViewLayout, type PipelineInput } from "../src/components/graph/layout/pipeline";
import { __zDebug } from "../src/components/graph/layout/zRoutes";
import { __routeCounters as rc } from "../src/components/graph/layout/orthoRoute";
import { __clearElkCacheForTests } from "../src/components/graph/layout/engine";
import { diag } from "../src/components/graph/layout/diag";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("использование: npm run stage-table -- <вход.json> [<вход.json> …]");
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
const load = (file: string): PipelineInput =>
  JSON.parse(readFileSync(file, "utf8"), revive) as PipelineInput;

// Прогрев: загрузка ELK и первая компиляция конвейера не должны лечь на первую сцену.
{
  const warm = load(files[0]);
  warm.edgeQuality = "skip";
  await computeViewLayout(warm);
}

const pad = (v: string | number, n: number): string => String(v).padStart(n);
const header = [
  "сцена".padEnd(40), pad("узл/связ", 8), pad("всего", 7), pad("ELK", 6), pad("роутер", 7),
  pad("после", 6), pad("проч", 5), pad("роут%", 6), pad("Z-выз", 6), pad("оценок", 7), pad("A*", 4),
].join(" ");
console.log(header);

for (const file of files) {
  // ── прогон 1: тайминг по стадиям ────────────────────────────────────────────────
  const stages = new Map<string, number>();
  diag.__ARCHMAP_TRACE = (stage, ms) => { stages.set(stage, (stages.get(stage) ?? 0) + ms); };
  __zDebug.on = false;
  __zDebug.lines = [];
  __clearElkCacheForTests();
  const astar0 = rc.routePortsCalls;
  const t0 = performance.now();
  const out = await computeViewLayout(load(file));
  const total = performance.now() - t0;
  const astar = rc.routePortsCalls - astar0;
  const sum = (...prefixes: string[]): number => {
    let acc = 0;
    for (const [stage, ms] of stages) if (prefixes.some((p) => stage.startsWith(p))) acc += ms;
    return acc;
  };
  const elk = sum("ELK уровня", "спавн детей");
  const router = sum("роутер:");
  const post = sum("нуджинг", "спрямление", "плашки", "T4");
  const rest = total - elk - router - post;

  // ── прогон 2: счётчики Z-роутера по отладочному следу ───────────────────────────
  // Строка следа — «<id8> <вид> …»: «try» — проба варианта в спуске, «host-off» — проба
  // снятия носителя подписи; каждая — полная переоценка цены сцены. Вызов zRoutes
  // кончается пачкой строк «→» (по одной на связь) — по её началу считаем вызовы.
  diag.__ARCHMAP_TRACE = undefined;
  __zDebug.on = true;
  __zDebug.lines = [];
  await computeViewLayout(load(file));
  let calls = 0, evals = 0, inArrows = false;
  for (const line of __zDebug.lines) {
    const kind = line.split(" ")[1];
    if (kind === "try" || kind === "host-off") evals++;
    const arrow = kind === "→";
    if (arrow && !inArrows) calls++;
    inArrows = arrow;
  }
  __zDebug.on = false;
  __zDebug.lines = [];

  const nodes = out.layout.nodes.length + out.layout.entities.length;
  const name = file.split("/").slice(-2).join("/").replace(/\.json$/, "");
  console.log([
    name.slice(-40).padEnd(40), pad(`${nodes}/${out.layout.groupArr.length}`, 8),
    pad(Math.round(total), 7), pad(Math.round(elk), 6), pad(Math.round(router), 7),
    pad(Math.round(post), 6), pad(Math.round(rest), 5),
    pad(`${total > 0 ? Math.round((100 * router) / total) : 0}%`, 6),
    pad(calls, 6), pad(evals, 7), pad(astar, 4),
  ].join(" "));
}
