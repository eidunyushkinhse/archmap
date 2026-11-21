// ПОСТРОЧНЫЙ ПРОФИЛЬ КОНВЕЙЕРА РАСКЛАДКИ (эпик render-scale, docs/plan-render-scale.md).
//
// Отвечает на вопрос «на какой строке горит время» для одного захваченного входа:
//   node scripts/prof-lines.mjs <вход.json> [сколько строк показать, по умолчанию 30]
//
// Что делает: собирает frontend/scripts/replay-prof.ts в НЕСЖАТЫЙ бандл с именами функций
// (esbuild --keep-names), гонит его под профилировщиком V8 (node --cpu-prof) и сводит
// профиль в три списка: включённое время по функциям, собственное по функциям и
// собственное по строкам (с текстом строки бандла). Под tsx так не выйдет: его
// преобразование кладёт весь модуль в одну строку, и профиль не различает функции.
//
// Номера строк — строки бандла (каталог печатается в конце): по имени функции и тексту
// строки место в исходнике находится однозначно. Первый вызов ELK включает его загрузку
// (0,3–0,5 с) — она видна в профиле отдельными функциями elk и к конвейеру не относится.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FRONT = join(ROOT, "frontend");
const [inputArg, topArg] = process.argv.slice(2);
if (!inputArg) {
  console.error("использование: node scripts/prof-lines.mjs <вход.json> [N строк]");
  process.exit(2);
}
const input = resolve(inputArg);
const topN = Number(topArg ?? 30);

const work = mkdtempSync(join(tmpdir(), "archmap-prof-"));
const bundle = join(work, "replay.mjs");
execFileSync(join(FRONT, "node_modules/.bin/esbuild"), [
  "scripts/replay-prof.ts", "--bundle", "--platform=node", "--format=esm", "--keep-names",
  `--outfile=${bundle}`, "--log-level=warning",
  // elkjs — CommonJS: бандлу в формате ESM нужен свой require
  "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
], { cwd: FRONT, stdio: "inherit" });

const run = spawnSync(process.execPath, ["--cpu-prof", `--cpu-prof-dir=${work}`, bundle, input], { encoding: "utf8" });
const stages = run.stderr.split("\n").filter((l) => /мс {2}|ИТОГО/.test(l)).map((l) => l.replace(/ +A\*=.*/, ""));
console.log(stages.join("\n"));

const profFile = readdirSync(work).find((f) => f.endsWith(".cpuprofile"));
if (!profFile) {
  console.error("профиль не записан");
  process.exit(1);
}
const prof = JSON.parse(readFileSync(join(work, profFile), "utf8"));
const src = readFileSync(bundle, "utf8").split("\n");
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const selfUs = new Map();
for (let i = 0; i < prof.samples.length; i++) {
  selfUs.set(prof.samples[i], (selfUs.get(prof.samples[i]) ?? 0) + (prof.timeDeltas[i] ?? 0));
}
const inBundle = (n) => n.callFrame.url.endsWith("replay.mjs");
// у стрелочной функции имени в профиле нет — берём «const имя» из её строки в бандле
const nameAt = (line) => (/(?:const|let|var)\s+([\w$]+)\s*=/.exec(src[line] ?? "")?.[1] ?? "(анонимная)");
const fnKey = (n) => `${n.callFrame.functionName || nameAt(n.callFrame.lineNumber)}@${n.callFrame.lineNumber + 1}`;
let total = 0;
const selfFn = new Map(), inclFn = new Map(), lineT = new Map();
for (const [id, t] of selfUs) {
  const n = byId.get(id);
  if (n.callFrame.functionName === "(idle)") continue;
  total += t;
  const k = inBundle(n) ? fnKey(n) : `[${n.callFrame.functionName || "анонимная"} ${n.callFrame.url.split("/").pop()}]`;
  selfFn.set(k, (selfFn.get(k) ?? 0) + t);
  // включённое: по цепочке предков, каждая функция один раз на сэмпл
  const seen = new Set();
  for (let cur = id; cur != null; cur = parent.get(cur)) {
    const c = byId.get(cur);
    if (!inBundle(c)) continue;
    const kk = fnKey(c);
    if (seen.has(kk)) continue;
    seen.add(kk);
    inclFn.set(kk, (inclFn.get(kk) ?? 0) + t);
  }
  // строки: собственное время узла делится по тикам его строк
  if (inBundle(n) && n.positionTicks?.length) {
    const ticks = n.positionTicks.reduce((s, x) => s + x.ticks, 0);
    for (const pt of n.positionTicks) lineT.set(pt.line, (lineT.get(pt.line) ?? 0) + (t * pt.ticks) / ticks);
  }
}
const cell = (t) => `${(t / 1000).toFixed(0).padStart(6)} мс ${((100 * t) / total).toFixed(1).padStart(5)}%`;
const top = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, topN);
console.log(`\nзанято ${(total / 1000).toFixed(0)} мс`);
console.log("== включённое время по функциям ==");
for (const [k, t] of top(inclFn)) console.log(cell(t), k);
console.log("== собственное время по функциям ==");
for (const [k, t] of top(selfFn)) console.log(cell(t), k);
console.log("== собственное время по строкам ==");
for (const [l, t] of top(lineT)) console.log(cell(t), `:${l}`, (src[l - 1] ?? "").trim().slice(0, 110));
console.log(`\nбандл и профиль: ${work}`);
