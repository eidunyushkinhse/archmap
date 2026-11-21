// ВОРОТА КАЧЕСТВА МАРШРУТОВ шага «меньше проб» эпика render-scale (docs/plan-render-scale.md):
// правка, которая сокращает перебор Z-роутера, вправе менять маршруты, но метрики качества
// по корпусу сцен обязаны остаться в пределах ниже (против базовых дампов корпуса).
//   1. Сквозь тела, конфликты портов, шпильки: ни на одной сцене не больше базы.
//   2. Кресты: сумма по корпусу не больше базы +3% (с округлением вниз); на сцене не больше
//      базы плюс max(4, 8% базы).
//   3. Сквозь чужие плашки: сумма не больше базы +5%.
//   4. Изломы: сумма +3%; длина: сумма +2%; развороты: сумма +5%.
// Полигон стрелок и детерминизм проверяются отдельно (arrows-gate, два запуска --write-all).
import { METRIC_ORDER, type QualityMetrics } from "../../src/components/graph/layout/routeQualityMetrics";

export interface SceneQuality { name: string; before: QualityMetrics; after: QualityMetrics }

/** Пределы ворот, % к базе (суммы по корпусу) и на сцену. */
const GATE = {
  crossesSumPct: 3, crossesSceneAbs: 4, crossesScenePct: 8,
  labelsSumPct: 5, bendsSumPct: 3, lenSumPct: 2, reversalsSumPct: 5,
} as const;
/** Метрики, которые ни на одной сцене не вправе вырасти против базы. */
const NO_WORSE: ReadonlyArray<keyof QualityMetrics> = ["throughBodies", "portConflicts", "hairpins"];

const zero = (): QualityMetrics => ({
  crosses: 0, overlapPx: 0, bends: 0, totalLen: 0, throughBodies: 0,
  throughLabels: 0, portConflicts: 0, reversals: 0, hairpins: 0,
});

/** Вердикт ворот и строки отчёта (ИТОГО по метрикам, нарушения по сценам). */
export function checkQualityGates(scenes: ReadonlyArray<SceneQuality>): { ok: boolean; lines: string[] } {
  const before = zero(), after = zero();
  for (const s of scenes) {
    for (const k of METRIC_ORDER) { before[k] += s.before[k]; after[k] += s.after[k]; }
  }
  const lines: string[] = [];
  const bad: string[] = [];
  // ── по сценам ──
  let worstName = "", worstDelta = -Infinity;
  for (const s of scenes) {
    for (const k of NO_WORSE) {
      if (s.after[k] > s.before[k]) bad.push(`${s.name}: ${k} ${s.before[k]} → ${s.after[k]} (больше базы)`);
    }
    const lim = s.before.crosses + Math.max(GATE.crossesSceneAbs, (GATE.crossesScenePct / 100) * s.before.crosses);
    if (s.after.crosses > lim) bad.push(`${s.name}: кресты ${s.before.crosses} → ${s.after.crosses} (предел ${lim.toFixed(1)})`);
    const d = s.after.crosses - s.before.crosses;
    if (d > worstDelta) { worstDelta = d; worstName = s.name; }
  }
  // ── суммы ──
  const sumGate = (k: keyof QualityMetrics, pct: number, floorLimit = false): void => {
    const raw = before[k] * (1 + pct / 100);
    const lim = floorLimit ? Math.floor(raw) : raw;
    const ok = after[k] <= lim + 1e-9;
    if (!ok) bad.push(`ИТОГО ${k}: ${fmt(before[k])} → ${fmt(after[k])} (предел ${fmt(lim)}, +${pct}%)`);
  };
  sumGate("crosses", GATE.crossesSumPct, true);
  sumGate("throughLabels", GATE.labelsSumPct);
  sumGate("bends", GATE.bendsSumPct);
  sumGate("totalLen", GATE.lenSumPct);
  sumGate("reversals", GATE.reversalsSumPct);
  lines.push(`ИТОГО качества по ${scenes.length} сценам (база → сейчас):`);
  for (const k of METRIC_ORDER) {
    const pct = before[k] !== 0 ? ` (${after[k] >= before[k] ? "+" : ""}${((100 * (after[k] - before[k])) / before[k]).toFixed(2)}%)` : "";
    lines.push(`  ${k.padEnd(14)} ${fmt(before[k]).padStart(12)} → ${fmt(after[k]).padStart(12)}${pct}`);
  }
  if (scenes.length > 0) lines.push(`  худшая сцена по крестам: ${worstName} (${worstDelta >= 0 ? "+" : ""}${worstDelta})`);
  if (bad.length === 0) lines.push("ВОРОТА КАЧЕСТВА: пройдены");
  else {
    lines.push(`ВОРОТА КАЧЕСТВА: НЕ ПРОЙДЕНЫ (${bad.length})`);
    for (const b of bad) lines.push(`  • ${b}`);
  }
  return { ok: bad.length === 0, lines };
}

const fmt = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(1));
