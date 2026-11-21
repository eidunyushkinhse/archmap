/// <reference types="node" />
// ВОРОТА ПОЛИГОНА СТРЕЛОК для шага «меньше проб» эпика render-scale (docs/plan-render-scale.md):
// сравнивает отчёт полигона (arrowsPolygon.perf.test → report.json, 28 строк «сцена ×
// вариант») с прежним отчётом.
//   • ports.leaders, ports.labelsOffRoute, ports.overlapIllegal — 0 во всех строках;
//   • quality.crosses — ни в одной строке не больше прежнего плюс 1, сумма не больше прежней;
//   • quality.throughLabels — сумма не больше прежней плюс 2.
// Запуск из frontend/:
//   npm run arrows-gate -- <прежний report.json> <новый report.json>
// Код возврата 1 — ворота не пройдены.
import { readFileSync } from "node:fs";

interface Row {
  scene: string;
  variant: string;
  quality: { crosses: number; throughLabels: number };
  ports: { leaders: number; labelsOffRoute: number; overlapIllegal: number };
}

const [beforeFile, afterFile] = process.argv.slice(2);
if (!beforeFile || !afterFile) {
  console.error("использование: npm run arrows-gate -- <прежний report.json> <новый report.json>");
  process.exit(2);
}
const read = (f: string): Row[] => JSON.parse(readFileSync(f, "utf8")) as Row[];
const before = read(beforeFile), after = read(afterFile);
const key = (r: Row): string => `${r.scene}·${r.variant}`;
const byKey = new Map(before.map((r) => [key(r), r]));
const bad: string[] = [];
let crB = 0, crA = 0, tlB = 0, tlA = 0;
for (const a of after) {
  const b = byKey.get(key(a));
  if (!b) { bad.push(`${key(a)}: нет прежней строки`); continue; }
  crB += b.quality.crosses; crA += a.quality.crosses;
  tlB += b.quality.throughLabels; tlA += a.quality.throughLabels;
  for (const k of ["leaders", "labelsOffRoute", "overlapIllegal"] as const) {
    if (a.ports[k] !== 0) bad.push(`${key(a)}: ports.${k} = ${a.ports[k]}`);
  }
  if (a.quality.crosses > b.quality.crosses + 1) bad.push(`${key(a)}: кресты ${b.quality.crosses} → ${a.quality.crosses}`);
  const moved = a.quality.crosses !== b.quality.crosses || a.quality.throughLabels !== b.quality.throughLabels;
  if (moved) console.log(`${key(a).padEnd(28)} кресты ${b.quality.crosses}→${a.quality.crosses}, сквозь плашки ${b.quality.throughLabels}→${a.quality.throughLabels}`);
}
if (after.length !== before.length) bad.push(`строк ${before.length} → ${after.length}`);
if (crA > crB) bad.push(`сумма крестов ${crB} → ${crA}`);
if (tlA > tlB + 2) bad.push(`сумма «сквозь плашки» ${tlB} → ${tlA} (предел ${tlB + 2})`);
console.log(`строк ${after.length}: кресты ${crB} → ${crA}, сквозь плашки ${tlB} → ${tlA}`);
if (bad.length === 0) console.log("ВОРОТА ПОЛИГОНА СТРЕЛОК: пройдены");
else {
  console.log(`ВОРОТА ПОЛИГОНА СТРЕЛОК: НЕ ПРОЙДЕНЫ (${bad.length})`);
  for (const b of bad) console.log(`  • ${b}`);
}
process.exit(bad.length === 0 ? 0 : 1);
