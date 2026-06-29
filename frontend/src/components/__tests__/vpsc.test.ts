import { describe, it, expect } from "vitest";
import { solveSeparation, type SepConstraint } from "../graph/layout/vpsc";

// helper: максимум нарушения по всем ограничениям (≤ ~0 ⇒ решение допустимо)
const maxViolation = (x: number[], cs: SepConstraint[]): number =>
  cs.reduce((m, c) => Math.max(m, x[c.left] + c.gap - x[c.right]), -Infinity);

describe("solveSeparation (1D weighted VPSC)", () => {
  it("без ограничений — позиции равны желаемым", () => {
    const d = [0, 5, -3, 12];
    const x = solveSeparation(d, [1, 1, 1, 1], []);
    expect(x).toEqual(d);
  });

  it("одно нарушенное ограничение, равные веса — симметричное раздвижение вокруг центра", () => {
    // обе хотят в 0, нужен зазор 10 → оптимум: −5 и +5 (минимум Σ(x−d)²)
    const x = solveSeparation([0, 0], [1, 1], [{ left: 0, right: 1, gap: 10 }]);
    expect(x[0]).toBeCloseTo(-5, 6);
    expect(x[1]).toBeCloseTo(5, 6);
  });

  it("веса задают приоритет подвижности — тяжёлая переменная почти не двигается", () => {
    // вес 1000 vs 1: «локал» стоит, «новичок» уезжает на ~gap
    const x = solveSeparation([0, 0], [1000, 1], [{ left: 0, right: 1, gap: 10 }]);
    expect(x[0]).toBeCloseTo(0, 1); // тяжёлый сдвинулся на ~0.01
    expect(x[1]).toBeCloseTo(10, 1);
    expect(x[1] - x[0]).toBeGreaterThanOrEqual(10 - 1e-6);
  });

  it("не двигает то, что уже удовлетворяет ограничению", () => {
    const x = solveSeparation([0, 100], [1, 1], [{ left: 0, right: 1, gap: 10 }]);
    expect(x).toEqual([0, 100]);
  });

  it("цепочка сохраняет относительный порядок и разводит на зазоры", () => {
    const cs: SepConstraint[] = [
      { left: 0, right: 1, gap: 10 },
      { left: 1, right: 2, gap: 10 },
    ];
    const x = solveSeparation([0, 1, 2], [1, 1, 1], cs);
    expect(x[0]).toBeLessThan(x[1]);
    expect(x[1]).toBeLessThan(x[2]);
    expect(maxViolation(x, cs)).toBeLessThanOrEqual(1e-6);
  });

  it("DAG (не полная цепочка) — гэпит только заданные пары, остальное не трогает", () => {
    // три точки 0,5,200; ограничение только между 0 и 1, точка 2 далеко и свободна
    const cs: SepConstraint[] = [{ left: 0, right: 1, gap: 30 }];
    const x = solveSeparation([0, 5, 200], [1, 1, 1], cs);
    expect(x[2]).toBe(200); // свободная переменная не сдвинута (R2)
    expect(x[1] - x[0]).toBeGreaterThanOrEqual(30 - 1e-6);
    // симметрично вокруг (0+5)/2 = 2.5 → центр сохраняется
    expect((x[0] + x[1]) / 2).toBeCloseTo(2.5, 6);
  });

  it("одна переменная под двумя ограничениями — оба удовлетворены", () => {
    // 1 должна быть ≥10 справа от 0 и ≥10 слева от 2; стартуют в одной точке
    const cs: SepConstraint[] = [
      { left: 0, right: 1, gap: 10 },
      { left: 1, right: 2, gap: 10 },
    ];
    const x = solveSeparation([0, 0, 0], [1, 1, 1], cs);
    expect(maxViolation(x, cs)).toBeLessThanOrEqual(1e-6);
  });

  it("АБВ-регресс: И и З разводятся по оси, владеемый сосед тяжелее → двигается новичок", () => {
    // на оси перекрытия (y) З=318 владеем (тяжёлый), И=310 новичок (лёгкий); зазор = NODE_H=100.
    // порядок desired: И(310) < З(318) → ограничение И→З. Ожидаем: З почти на месте,
    // И уезжает вверх так, чтобы З − И ≥ 100, при минимальном суммарном смещении.
    const NODE_H = 100;
    const desired = [310, 318]; // [И, З]
    const weight = [1, 1000]; // И лёгкий, З тяжёлый (владеемый)
    const cs: SepConstraint[] = [{ left: 0, right: 1, gap: NODE_H }];
    const x = solveSeparation(desired, weight, cs);
    expect(x[1]).toBeCloseTo(318, 0); // З не сдвинулся (тяжёлый)
    expect(x[1] - x[0]).toBeGreaterThanOrEqual(NODE_H - 1e-6); // развели
    expect(x[0]).toBeLessThan(310); // И уехал вверх (к меньшему y), минимально
    expect(maxViolation(x, cs)).toBeLessThanOrEqual(1e-6);
  });
});
