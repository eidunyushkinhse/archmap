// ВОРОТА КАЧЕСТВА МАРШРУТОВ эпика render-scale (docs/plan-render-scale.md): правка вправе
// менять маршруты, но метрики качества по корпусу сцен обязаны остаться в пределах набора
// ворот (против базовых дампов корпуса). Наборов два, выбор — опцией corpus-check --gates.
//
// "search" (по умолчанию; шаг «меньше проб» — тот же вход, меньше перебора, поэтому сцена
// сверяется со сценой):
//   1. Сквозь тела, конфликты портов, шпильки: ни на одной сцене не больше базы.
//   2. Кресты: сумма по корпусу не больше базы +3% (с округлением вниз); на сцене не больше
//      базы плюс max(4, 8% базы).
//   3. Сквозь чужие плашки: сумма не больше базы +5%.
//   4. Изломы: сумма +3%; длина: сумма +2%; развороты: сумма +5%.
// "elk" (шаг «быстрый ELK и один прогон»: другая расстановка узлов, позиции другие, поэтому
// сцена со сценой не сверяется — только суммы по корпусу):
//   1. Сквозь тела, конфликты портов, шпильки: сумма не больше базы.
//   2. Кресты +3% (с округлением вниз), изломы +4%, длина +5%, сквозь чужие плашки +15%,
//      развороты +10%.
// Полигон стрелок и детерминизм проверяются отдельно (arrows-gate, два запуска --write-all).
import { METRIC_ORDER, type QualityMetrics } from "../../src/components/graph/layout/routeQualityMetrics";

export interface SceneQuality { name: string; before: QualityMetrics; after: QualityMetrics }

/** Набор пределов ворот: % к базе для сумм по корпусу и правила на сцену. */
interface GateSet {
  title: string;
  /** пределы сумм по корпусу, % к базе */
  sumPct: Partial<Record<keyof QualityMetrics, number>>;
  /** метрики, которые не вправе вырасти против базы: на каждой сцене или суммой */
  noWorse: ReadonlyArray<keyof QualityMetrics>;
  noWorseScope: "scene" | "sum";
  /** предел крестов на сцену: база + max(abs, pct% базы); null — сцена не сверяется */
  crossesScene: { abs: number; pct: number } | null;
}

const GATE_SETS = {
  search: {
    title: "шаг «меньше проб»",
    sumPct: { crosses: 3, throughLabels: 5, bends: 3, totalLen: 2, reversals: 5 },
    noWorse: ["throughBodies", "portConflicts", "hairpins"],
    noWorseScope: "scene",
    crossesScene: { abs: 4, pct: 8 },
  },
  elk: {
    title: "шаг «быстрый ELK и один прогон»",
    sumPct: { crosses: 3, bends: 4, totalLen: 5, throughLabels: 15, reversals: 10 },
    noWorse: ["throughBodies", "portConflicts", "hairpins"],
    noWorseScope: "sum",
    crossesScene: null,
  },
} as const satisfies Record<string, GateSet>;

export type GateSetName = keyof typeof GATE_SETS;

export function isGateSetName(v: string): v is GateSetName {
  return Object.prototype.hasOwnProperty.call(GATE_SETS, v);
}

const zero = (): QualityMetrics => ({
  crosses: 0, overlapPx: 0, bends: 0, totalLen: 0, throughBodies: 0,
  throughLabels: 0, portConflicts: 0, reversals: 0, hairpins: 0,
});

/** Вердикт ворот и строки отчёта (ИТОГО по метрикам, нарушения по сценам). */
export function checkQualityGates(
  scenes: ReadonlyArray<SceneQuality>,
  setName: GateSetName = "search",
): { ok: boolean; lines: string[] } {
  const gate: GateSet = GATE_SETS[setName];
  const before = zero(), after = zero();
  for (const s of scenes) {
    for (const k of METRIC_ORDER) { before[k] += s.before[k]; after[k] += s.after[k]; }
  }
  const lines: string[] = [];
  const bad: string[] = [];
  // ── по сценам ──
  let worstName = "", worstDelta = -Infinity;
  for (const s of scenes) {
    if (gate.noWorseScope === "scene") {
      for (const k of gate.noWorse) {
        if (s.after[k] > s.before[k]) bad.push(`${s.name}: ${k} ${s.before[k]} → ${s.after[k]} (больше базы)`);
      }
    }
    if (gate.crossesScene) {
      const lim = s.before.crosses + Math.max(gate.crossesScene.abs, (gate.crossesScene.pct / 100) * s.before.crosses);
      if (s.after.crosses > lim) bad.push(`${s.name}: кресты ${s.before.crosses} → ${s.after.crosses} (предел ${lim.toFixed(1)})`);
    }
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
  for (const [k, pct] of Object.entries(gate.sumPct) as [keyof QualityMetrics, number][]) {
    sumGate(k, pct, k === "crosses");
  }
  if (gate.noWorseScope === "sum") for (const k of gate.noWorse) sumGate(k, 0);
  lines.push(`ИТОГО качества по ${scenes.length} сценам (база → сейчас), ворота: ${gate.title}:`);
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
