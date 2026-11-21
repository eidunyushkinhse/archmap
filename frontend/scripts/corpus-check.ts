/// <reference types="node" />
// СВЕРКА КОРПУСА (эпик render-scale, docs/plan-render-scale.md): гонит все захваченные
// входы раскладки и сверяет структурный дамп результата (маршруты, тела, плашки) с
// базовым дампом БАЙТ-В-БАЙТ. Это ворота правок, которые обязаны не менять картинку, и
// измеритель тех, что меняют её осознанно (отличия едут в --write для route-quality).
//
// Запуск из frontend/:
//   npm run corpus-check -- <каталог входов> <каталог базовых дампов> [опции]
// Обычно: npm run corpus-check -- ../scripts/.polygon/render-scale/inputs ../scripts/.polygon/render-scale/baseline
// Опции:
//   --only <имя,имя>      только эти сцены (имя файла без .json; подстрока тоже годится)
//   --skip <имя,имя>      пропустить сцены
//   --write <каталог>     сохранить дампы, отличающиеся от базовых (сравнение качества)
//   --write-all <каталог> сохранить дампы всех сцен (сверка детерминизма: два запуска в
//                         разные каталоги обязаны дать побитово одинаковые файлы)
//   --save-times <файл>   записать времена сцен (мс) — опорный замер «до»
//   --ref-times <файл>    показать ускорение против опорного замера
//   --save-stats <файл>   записать по сценам время, оценки цены сцены и вызовы zRoutes
//   --ref-stats <файл>    показать оценки «было → стало» против записанных --save-stats
//   --quality             ВОРОТА КАЧЕСТВА (шаг «меньше проб»): метрики качества «база →
//                         сейчас» по каждой сцене, ИТОГО по корпусу и вердикт ворот;
//                         код возврата 1 — ворота не пройдены (отличия от базы сами по
//                         себе ошибкой в этом режиме не считаются)
//   --selfcheck           самопроверка кэшей Z-роутера (diag.__ARCHMAP_Z_SELFCHECK): каждое
//                         попадание в кэш дополнительно считается честно и сверяется,
//                         расхождение — исключение с названием кэша (прогон медленнее)
// Вход без базового дампа считается (время печатается), но не сверяется.
// Код возврата 1 — есть отличия от базовых дампов (без --quality) либо не пройдены ворота
// качества (с --quality).
//
// «Оценок» — сколько раз Z-роутер за прогон заново посчитал цену всей сцены (счётчик
// diag.__ARCHMAP_Z_STATS, без отладочного следа); «Z» — вызовов zRoutes (повторный круг с
// теми же портами берёт готовый результат и вызовом не считается).
//
// Все сцены идут в ОДНОМ процессе: скрытое состояние между прогонами (кэш, забытый
// в модуле) проявится расхождением с дампами, снятыми отдельными процессами.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeViewLayout, type PipelineInput } from "../src/components/graph/layout/pipeline";
import { __clearElkCacheForTests } from "../src/components/graph/layout/engine";
import { diag } from "../src/components/graph/layout/diag";
import { measureQuality, type QualityMetrics, type RouteDump } from "../src/components/graph/layout/routeQualityMetrics";
import { buildRouteDump, reviveInput } from "./lib/routeDump";
import { checkQualityGates, type SceneQuality } from "./lib/qualityGates";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const [inputsDir, baselineDir] = argv;
if (!inputsDir || !baselineDir || inputsDir.startsWith("--") || baselineDir.startsWith("--")) {
  console.error("использование: npm run corpus-check -- <каталог входов> <каталог базовых дампов> [--only a,b] [--skip a,b] [--write dir] [--write-all dir] [--save-times f] [--ref-times f] [--save-stats f] [--ref-stats f] [--quality] [--selfcheck]");
  process.exit(2);
}
const list = (v: string | undefined): string[] => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
const only = list(flag("--only"));
const skip = list(flag("--skip"));
const writeDir = flag("--write");
const writeAllDir = flag("--write-all");
const saveTimes = flag("--save-times");
const refTimesFile = flag("--ref-times");
const saveStats = flag("--save-stats");
const refStatsFile = flag("--ref-stats");
const quality = argv.includes("--quality");
const selfCount: Record<string, number> = {};
if (argv.includes("--selfcheck")) {
  diag.__ARCHMAP_Z_SELFCHECK = true;
  diag.__ARCHMAP_Z_SELFCHECK_COUNT = selfCount;
  console.log("самопроверка кэшей Z-роутера включена: времена не сравнимы с опорными");
}
const refTimes: Record<string, number> = refTimesFile
  ? (JSON.parse(readFileSync(refTimesFile, "utf8")) as Record<string, number>)
  : {};
interface SceneStats { ms: number; evals: number; calls: number }
const refStats: Record<string, SceneStats> = refStatsFile
  ? (JSON.parse(readFileSync(refStatsFile, "utf8")) as Record<string, SceneStats>)
  : {};

const names = readdirSync(inputsDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""))
  .filter((n) => (only.length === 0 || only.some((o) => n.includes(o))) && !skip.some((s) => n.includes(s)))
  .sort();
if (names.length === 0) {
  console.error("сцен не найдено");
  process.exit(2);
}

const load = (name: string): PipelineInput =>
  JSON.parse(readFileSync(join(inputsDir, `${name}.json`), "utf8"), reviveInput) as PipelineInput;

// Прогрев: загрузка ELK и первая компиляция конвейера не должны лечь на первую сцену.
{
  const warm = load(names[0]);
  warm.edgeQuality = "skip";
  await computeViewLayout(warm);
}

const times: Record<string, number> = {};
const statsOut: Record<string, SceneStats> = {};
const scenes: SceneQuality[] = [];
let same = 0, differ = 0, unchecked = 0, sum = 0, refSum = 0, evalSum = 0, refEvalSum = 0, callSum = 0;
const differing: string[] = [];
for (const name of names) {
  const input = load(name);
  __clearElkCacheForTests(); // как в свежем воркере: ELK считается заново
  const zStats: Record<string, number> = {};
  diag.__ARCHMAP_Z_STATS = zStats;
  const t0 = performance.now();
  const out = await computeViewLayout(input);
  const ms = performance.now() - t0;
  diag.__ARCHMAP_Z_STATS = undefined;
  const evals = zStats.evals ?? 0, calls = zStats.calls ?? 0;
  times[name] = Math.round(ms);
  statsOut[name] = { ms: Math.round(ms), evals, calls };
  sum += ms;
  evalSum += evals;
  callSum += calls;
  const dumpObj = buildRouteDump(input, out);
  const dump = JSON.stringify(dumpObj);
  if (writeAllDir) {
    mkdirSync(writeAllDir, { recursive: true });
    writeFileSync(join(writeAllDir, `${name}.json`), dump);
  }
  const baseFile = join(baselineDir, `${name}.json`);
  let verdict: string;
  let baseText: string | null = null;
  if (!existsSync(baseFile)) {
    unchecked++;
    verdict = "без базы";
  } else if ((baseText = readFileSync(baseFile, "utf8")) === dump) {
    same++;
    verdict = "совпал";
  } else {
    differ++;
    differing.push(name);
    verdict = "ОТЛИЧАЕТСЯ";
    if (writeDir) {
      mkdirSync(writeDir, { recursive: true });
      writeFileSync(join(writeDir, `${name}.json`), dump);
    }
  }
  let qText = "";
  if (quality && baseText !== null) {
    const before = measureQuality(JSON.parse(baseText) as RouteDump);
    const after = verdict === "совпал" ? before : measureQuality(dumpObj as RouteDump);
    scenes.push({ name, before, after });
    if (verdict !== "совпал") qText = `  кр ${before.crosses}→${after.crosses}${deltas(before, after)}`;
  }
  const ref = refTimes[name];
  if (ref !== undefined) refSum += ref;
  const rs = refStats[name];
  if (rs) refEvalSum += rs.evals;
  const speed = ref !== undefined && ms > 0 ? `  было ${String(ref).padStart(6)} мс, ×${(ref / ms).toFixed(1)}` : "";
  const evalText = rs ? `${String(rs.evals).padStart(5)}→${String(evals).padEnd(5)}` : String(evals).padStart(5);
  console.log(`${name.padEnd(24)} ${String(Math.round(ms)).padStart(7)} мс  оценок ${evalText} Z ${String(calls).padStart(2)}  ${verdict}${speed}${qText}`);
}
diag.__ARCHMAP_Z_STATS = undefined;
if (saveTimes) writeFileSync(saveTimes, JSON.stringify(times, null, 2));
if (saveStats) writeFileSync(saveStats, JSON.stringify(statsOut, null, 2));
const total = `сцен ${names.length}: совпало ${same}, отличается ${differ}, без базы ${unchecked}; всего ${Math.round(sum)} мс`;
console.log(refSum > 0 ? `${total} (было ${Math.round(refSum)} мс, ×${(refSum / sum).toFixed(1)})` : total);
console.log(`ИТОГО оценок цены сцены ${refEvalSum > 0 ? `${refEvalSum} → ` : ""}${evalSum}${refEvalSum > 0 ? ` (×${(refEvalSum / Math.max(1, evalSum)).toFixed(2)} меньше)` : ""}, вызовов zRoutes ${callSum}`);
if (diag.__ARCHMAP_Z_SELFCHECK) {
  console.log(`сверок самопроверки: ${Object.entries(selfCount).map(([k, v]) => `${k} ${v}`).join(", ") || "ни одной"}`);
}
if (differ > 0) console.log(`отличаются: ${differing.join(", ")}`);
if (quality) {
  const gate = checkQualityGates(scenes);
  for (const line of gate.lines) console.log(line);
  process.exit(gate.ok ? 0 : 1);
}
if (differ > 0) process.exit(1);

// Короткая строка отличий метрик сцены (кроме крестов, они впереди): только сдвинувшиеся.
function deltas(a: QualityMetrics, b: QualityMetrics): string {
  const parts: string[] = [];
  const show = (key: keyof QualityMetrics, label: string, digits = 0): void => {
    if (a[key] === b[key]) return;
    parts.push(`${label} ${a[key].toFixed(digits)}→${b[key].toFixed(digits)}`);
  };
  show("bends", "изл");
  show("totalLen", "дл");
  show("throughLabels", "плаш");
  show("reversals", "разв");
  show("throughBodies", "тела");
  show("portConflicts", "порты");
  show("hairpins", "шп");
  return parts.length > 0 ? `, ${parts.join(", ")}` : "";
}
