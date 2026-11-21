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
//   --save-times <файл>   записать времена сцен (мс) — опорный замер «до»
//   --ref-times <файл>    показать ускорение против опорного замера
// Вход без базового дампа считается (время печатается), но не сверяется.
// Код возврата 1 — есть отличия от базовых дампов.
//
// Все сцены идут в ОДНОМ процессе: скрытое состояние между прогонами (кэш, забытый
// в модуле) проявится расхождением с дампами, снятыми отдельными процессами.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeViewLayout, type PipelineInput } from "../src/components/graph/layout/pipeline";
import { __clearElkCacheForTests } from "../src/components/graph/layout/engine";
import { buildRouteDump, reviveInput } from "./lib/routeDump";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const [inputsDir, baselineDir] = argv;
if (!inputsDir || !baselineDir || inputsDir.startsWith("--") || baselineDir.startsWith("--")) {
  console.error("использование: npm run corpus-check -- <каталог входов> <каталог базовых дампов> [--only a,b] [--skip a,b] [--write dir] [--save-times f] [--ref-times f]");
  process.exit(2);
}
const list = (v: string | undefined): string[] => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
const only = list(flag("--only"));
const skip = list(flag("--skip"));
const writeDir = flag("--write");
const saveTimes = flag("--save-times");
const refTimesFile = flag("--ref-times");
const refTimes: Record<string, number> = refTimesFile
  ? (JSON.parse(readFileSync(refTimesFile, "utf8")) as Record<string, number>)
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
let same = 0, differ = 0, unchecked = 0, sum = 0, refSum = 0;
const differing: string[] = [];
for (const name of names) {
  const input = load(name);
  __clearElkCacheForTests(); // как в свежем воркере: ELK считается заново
  const t0 = performance.now();
  const out = await computeViewLayout(input);
  const ms = performance.now() - t0;
  times[name] = Math.round(ms);
  sum += ms;
  const dump = JSON.stringify(buildRouteDump(input, out));
  const baseFile = join(baselineDir, `${name}.json`);
  let verdict: string;
  if (!existsSync(baseFile)) {
    unchecked++;
    verdict = "без базы";
  } else if (readFileSync(baseFile, "utf8") === dump) {
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
  const ref = refTimes[name];
  if (ref !== undefined) refSum += ref;
  const speed = ref !== undefined && ms > 0 ? `  было ${String(ref).padStart(6)} мс, ×${(ref / ms).toFixed(1)}` : "";
  console.log(`${name.padEnd(24)} ${String(Math.round(ms)).padStart(7)} мс  ${verdict}${speed}`);
}
if (saveTimes) writeFileSync(saveTimes, JSON.stringify(times, null, 2));
const total = `сцен ${names.length}: совпало ${same}, отличается ${differ}, без базы ${unchecked}; всего ${Math.round(sum)} мс`;
console.log(refSum > 0 ? `${total} (было ${Math.round(refSum)} мс, ×${(refSum / sum).toFixed(1)})` : total);
if (differ > 0) {
  console.log(`отличаются: ${differing.join(", ")}`);
  process.exit(1);
}
