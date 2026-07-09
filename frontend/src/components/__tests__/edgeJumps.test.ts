import { describe, it, expect } from "vitest";
import { computeJumps, buildPathWithJumps } from "../graph/edgeJumps";
import type { EdgePoint } from "../../types";

// «Мостики» (line jumps): детект пересечений + сборка пути с дугами. Главное правило —
// дуга только на «крестике» (перпендикуляры, пересекающиеся строго внутри обоих);
// совместный ход / T-стыки / общие хэндлы дуги не дают.
// «Дуга всегда» (2026-07-09): ось и радиус выбирает computeJumps по доступной прямой
// части сегментов (после трима скруглений r): горизонталь → фолбэк на вертикаль →
// деградация радиуса. Дуга пропадает только в зоне скруглений ОБОИХ рёбер.

const H: EdgePoint[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }];      // горизонталь y=0, x∈[0,100]
const V: EdgePoint[] = [{ x: 50, y: -50 }, { x: 50, y: 50 }];   // вертикаль x=50, y∈[-50,50]

describe("computeJumps", () => {
  it("перпендикулярный крест → прыгает ГОРИЗОНТАЛЬНОЕ ребро (конвенция)", () => {
    const j = computeJumps(new Map([["h", H], ["v", V]]));
    expect(j.get("h")).toEqual([{ x: 50, y: 0, jr: 6 }]);
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
    expect(j.get("h")).toEqual([{ x: 50, y: 0, jr: 6 }, { x: 150, y: 0, jr: 6 }]);
  });

  it("не пересекаются (вертикаль в стороне) → дуги нет", () => {
    const far: EdgePoint[] = [{ x: 500, y: -50 }, { x: 500, y: 50 }];
    const j = computeJumps(new Map([["h", H], ["v", far]]));
    expect(j.get("h")).toEqual([]);
  });

  it("ФОЛБЭК ОСИ: крест у излома горизонтали → прыгает ВЕРТИКАЛЬ полным радиусом", () => {
    // горизонталь x∈[0,60] поворачивает вниз на x=60; крест на x=50 — в 10px от излома.
    // Прямая часть горизонтали после трима r=12: [0, 48] — крест за её пределами.
    const bendH: EdgePoint[] = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 80 }];
    const j = computeJumps(new Map([["h", bendH], ["v", V]]));
    expect(j.get("h")).toEqual([]);
    expect(j.get("v")).toEqual([{ x: 50, y: 0, jr: 6 }]);
  });

  it("ДЕГРАДАЦИЯ: обеим осям тесно → ось с большим запасом, уменьшенный радиус", () => {
    // горизонталь как выше (запас -2), вертикаль короткая: y∈[-5,5] → запас 5 < jr=6
    const bendH: EdgePoint[] = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 80 }];
    const shortV: EdgePoint[] = [{ x: 50, y: -5 }, { x: 50, y: 5 }];
    const j = computeJumps(new Map([["h", bendH], ["v", shortV]]));
    expect(j.get("h")).toEqual([]);
    expect(j.get("v")).toEqual([{ x: 50, y: 0, jr: 4.75 }]);
  });

  it("ПУЧОК: одиночка × 3 совпадающих вертикали → у одиночки РОВНО ОДНА дуга полного радиуса", () => {
    // общее плечо трёх стрелок из одного хэндла: расходятся изломами на разных y.
    // Попарное решение давало одиночке 3 дубля-мостика в одной точке → сжатие
    // ужимало их до микродуги JR_MIN (жалоба: ОС-хосты→Zabbix Core).
    const t1: EdgePoint[] = [{ x: 50, y: -80 }, { x: 50, y: 40 }, { x: 120, y: 40 }];
    const t2: EdgePoint[] = [{ x: 50, y: -80 }, { x: 50, y: 60 }, { x: 120, y: 60 }];
    const t3: EdgePoint[] = [{ x: 50, y: -80 }, { x: 50, y: 80 }, { x: 120, y: 80 }];
    const j = computeJumps(new Map([["h", H], ["t1", t1], ["t2", t2], ["t3", t3]]));
    expect(j.get("h")).toEqual([{ x: 50, y: 0, jr: 6 }]); // одна, не три
    expect(j.get("t1")).toEqual([]);
    expect(j.get("t2")).toEqual([]);
    expect(j.get("t3")).toEqual([]);
  });

  it("ПУЧОК-ГОРИЗОНТАЛЬ: 3 совпадающих горизонтали × одиночка-вертикаль → прыгает ОДИНОЧКА", () => {
    // сторона-одиночка предпочтительнее пучка, даже когда пучок горизонтален
    // (иначе дугу пришлось бы давать каждому члену)
    const g1: EdgePoint[] = [{ x: -20, y: 0 }, { x: 100, y: 0 }, { x: 100, y: -70 }];
    const g2: EdgePoint[] = [{ x: -20, y: 0 }, { x: 120, y: 0 }, { x: 120, y: -70 }];
    const g3: EdgePoint[] = [{ x: -20, y: 0 }, { x: 140, y: 0 }, { x: 140, y: -70 }];
    const j = computeJumps(new Map([["g1", g1], ["g2", g2], ["g3", g3], ["v", V]]));
    expect(j.get("v")).toEqual([{ x: 50, y: 0, jr: 6 }]);
    expect(j.get("g1")).toEqual([]);
    expect(j.get("g2")).toEqual([]);
    expect(j.get("g3")).toEqual([]);
  });

  it("ПУЧОК, одиночке тесно → дугу получает КАЖДЫЙ член пучка (одинаковый радиус)", () => {
    // вертикаль-одиночка коротка (запас 5 < jr) → прыгает сторона-пучок, все члены
    const shortV: EdgePoint[] = [{ x: 50, y: -5 }, { x: 50, y: 5 }];
    const g1: EdgePoint[] = [{ x: -20, y: 0 }, { x: 100, y: 0 }, { x: 100, y: -70 }];
    const g2: EdgePoint[] = [{ x: -20, y: 0 }, { x: 120, y: 0 }, { x: 120, y: -70 }];
    const j = computeJumps(new Map([["g1", g1], ["g2", g2], ["v", shortV]]));
    expect(j.get("v")).toEqual([]);
    expect(j.get("g1")).toEqual([{ x: 50, y: 0, jr: 6 }]);
    expect(j.get("g2")).toEqual([{ x: 50, y: 0, jr: 6 }]);
  });

  it("предел: крест в зоне скруглений ОБОИХ рёбер → дуги нет (негде стоять)", () => {
    // обе ломаные поворачивают в 3px от креста: прямые части не покрывают точку
    const bendH: EdgePoint[] = [{ x: 0, y: 0 }, { x: 53, y: 0 }, { x: 53, y: 80 }];
    const bendV: EdgePoint[] = [{ x: 50, y: -40 }, { x: 50, y: 3 }, { x: -90, y: 3 }];
    const j = computeJumps(new Map([["h", bendH], ["v", bendV]]));
    expect(j.get("h")).toEqual([]);
    expect(j.get("v")).toEqual([]);
  });
});

describe("buildPathWithJumps", () => {
  it("горизонталь с одним мостиком — дуга радиуса jr", () => {
    const d = buildPathWithJumps(H, 12, [{ x: 50, y: 0, jr: 6 }], 6);
    // вправо (dir=1): подвод к 44, дуга вверх (sweep 1) до 56, затем к концу
    expect(d).toBe("M 0,0 L 44,0 A 6 6 0 0 1 56,0 L 100,0");
  });

  it("без мостиков — обычная прямая", () => {
    expect(buildPathWithJumps(H, 12, [], 6)).toBe("M 0,0 L 100,0");
  });

  it("ход справа налево — дуга всё равно вверх (sweep 1)", () => {
    const rtl: EdgePoint[] = [{ x: 100, y: 0 }, { x: 0, y: 0 }];
    const d = buildPathWithJumps(rtl, 12, [{ x: 50, y: 0, jr: 6 }], 6);
    expect(d).toBe("M 100,0 L 56,0 A 6 6 0 0 0 44,0 L 0,0");
  });

  it("ВЕРТИКАЛЬНЫЙ мостик: дуга выгибается вправо (sweep 1 при ходе вниз)", () => {
    const v: EdgePoint[] = [{ x: 0, y: 0 }, { x: 0, y: 100 }];
    const d = buildPathWithJumps(v, 12, [{ x: 0, y: 50, jr: 6 }], 6);
    expect(d).toBe("M 0,0 L 0,44 A 6 6 0 0 1 0,56 L 0,100");
  });

  it("вертикаль ходом вверх — дуга тоже вправо (sweep 0)", () => {
    const v: EdgePoint[] = [{ x: 0, y: 100 }, { x: 0, y: 0 }];
    const d = buildPathWithJumps(v, 12, [{ x: 0, y: 50, jr: 6 }], 6);
    expect(d).toBe("M 0,100 L 0,56 A 6 6 0 0 0 0,44 L 0,0");
  });

  it("тесно у конца сегмента → радиус клампится (деградация вместо пропуска)", () => {
    const short: EdgePoint[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    const d = buildPathWithJumps(short, 12, [{ x: 5, y: 0, jr: 6 }], 6);
    expect(d).toBe("M 0,0 L 0.25,0 A 4.75 4.75 0 0 1 9.75,0 L 10,0");
  });

  it("совсем нет места (< JR_MIN) → прямая без дуги", () => {
    const tiny: EdgePoint[] = [{ x: 0, y: 0 }, { x: 4, y: 0 }];
    expect(buildPathWithJumps(tiny, 12, [{ x: 2, y: 0, jr: 6 }], 6)).toBe("M 0,0 L 4,0");
  });

  it("перекрывающиеся соседние дуги сжимаются до полузазора", () => {
    const long: EdgePoint[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    const d = buildPathWithJumps(long, 12, [{ x: 46, y: 0, jr: 6 }, { x: 54, y: 0, jr: 6 }], 6);
    // зазор 8 < 6+6 → оба радиуса сжаты до (8-0.5)/2 = 3.75
    expect(d).toContain("A 3.75 3.75");
    expect(d).not.toContain("A 6 6");
  });

  it("излом без мостиков скругляется (есть Q)", () => {
    const bend: EdgePoint[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
    const d = buildPathWithJumps(bend, 12, [], 6);
    expect(d).toContain("Q 100,0");
  });
});
