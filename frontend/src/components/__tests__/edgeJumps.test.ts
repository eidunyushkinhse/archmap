import { describe, it, expect } from "vitest";
import { computeJumps, buildPathWithJumps } from "../graph/edgeJumps";
import type { EdgePoint } from "../../types";

// «Мостики» (line jumps): детект пересечений + сборка пути с дугами. Главное правило —
// дуга только на «крестике» (перпендикуляры, пересекающиеся строго внутри обоих);
// совместный ход / T-стыки / общие хэндлы дуги не дают.

const H: EdgePoint[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }];      // горизонталь y=0, x∈[0,100]
const V: EdgePoint[] = [{ x: 50, y: -50 }, { x: 50, y: 50 }];   // вертикаль x=50, y∈[-50,50]

describe("computeJumps", () => {
  it("перпендикулярный крест → прыгает ГОРИЗОНТАЛЬНОЕ ребро", () => {
    const j = computeJumps(new Map([["h", H], ["v", V]]));
    expect(j.get("h")).toEqual([{ x: 50, y: 0 }]);
    expect(j.get("v")).toEqual([]); // вертикаль не прыгает
  });

  it("параллельные/коллинеарные (совместный ход) → дуги нет", () => {
    const H2: EdgePoint[] = [{ x: 50, y: 0 }, { x: 150, y: 0 }]; // та же линия, перекрытие
    const j = computeJumps(new Map([["h", H], ["h2", H2]]));
    expect(j.get("h")).toEqual([]);
    expect(j.get("h2")).toEqual([]);
  });

  it("из общего хэндла, расходятся изломом → на углу дуги нет", () => {
    // второе ребро идёт по той же горизонтали [0..50], затем ломается вниз
    const diverge: EdgePoint[] = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }];
    const j = computeJumps(new Map([["h", H], ["d", diverge]]));
    expect(j.get("h")).toEqual([]); // вертикальный сегмент стартует НА линии (T-стык в углу)
    expect(j.get("d")).toEqual([]);
  });

  it("T-стык (конец вертикали лежит на горизонтали) → дуги нет", () => {
    const T: EdgePoint[] = [{ x: 50, y: 0 }, { x: 50, y: 50 }]; // начинается на H
    const j = computeJumps(new Map([["h", H], ["t", T]]));
    expect(j.get("h")).toEqual([]);
  });

  it("несколько пересечений на одной горизонтали", () => {
    const long: EdgePoint[] = [{ x: 0, y: 0 }, { x: 200, y: 0 }];
    const V1: EdgePoint[] = [{ x: 50, y: -10 }, { x: 50, y: 10 }];
    const V2: EdgePoint[] = [{ x: 150, y: -10 }, { x: 150, y: 10 }];
    const j = computeJumps(new Map([["h", long], ["v1", V1], ["v2", V2]]));
    expect(j.get("h")).toEqual([{ x: 50, y: 0 }, { x: 150, y: 0 }]);
  });

  it("не пересекаются (вертикаль в стороне) → дуги нет", () => {
    const far: EdgePoint[] = [{ x: 500, y: -50 }, { x: 500, y: 50 }];
    const j = computeJumps(new Map([["h", H], ["v", far]]));
    expect(j.get("h")).toEqual([]);
  });
});

describe("buildPathWithJumps", () => {
  it("горизонталь с одним мостиком — дуга радиуса jr", () => {
    const d = buildPathWithJumps(H, 12, [{ x: 50, y: 0 }], 6);
    // вправо (dir=1): подвод к 44, дуга вверх (sweep 0) до 56, затем к концу
    expect(d).toBe("M 0,0 L 44,0 A 6 6 0 0 0 56,0 L 100,0");
  });

  it("без мостиков — обычная прямая", () => {
    expect(buildPathWithJumps(H, 12, [], 6)).toBe("M 0,0 L 100,0");
  });

  it("ход справа налево — дуга всё равно вверх (sweep 1)", () => {
    const rtl: EdgePoint[] = [{ x: 100, y: 0 }, { x: 0, y: 0 }];
    const d = buildPathWithJumps(rtl, 12, [{ x: 50, y: 0 }], 6);
    expect(d).toBe("M 100,0 L 56,0 A 6 6 0 0 1 44,0 L 0,0");
  });

  it("вертикальный сегмент мостики игнорирует", () => {
    const v: EdgePoint[] = [{ x: 0, y: 0 }, { x: 0, y: 100 }];
    expect(buildPathWithJumps(v, 12, [{ x: 0, y: 50 }], 6)).toBe("M 0,0 L 0,100");
  });

  it("мостик не умещается у конца сегмента → пропущен", () => {
    const short: EdgePoint[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    expect(buildPathWithJumps(short, 12, [{ x: 5, y: 0 }], 6)).toBe("M 0,0 L 10,0");
  });

  it("излом без мостиков скругляется (есть Q)", () => {
    const bend: EdgePoint[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
    const d = buildPathWithJumps(bend, 12, [], 6);
    expect(d).toContain("Q 100,0");
  });
});
