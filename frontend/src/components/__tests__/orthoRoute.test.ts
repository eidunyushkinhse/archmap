import { describe, it, expect } from "vitest";
import { routeOrthogonal, routePorts } from "../graph/layout/orthoRoute";
import { pathCrossesRects, type NodeRect } from "../graph/edgePath";
import type { EdgePoint } from "../../types";

// Ортогональный роутер одного ребра (A2, R1): кратчайший путь в обход узлов со штрафом
// за повороты. Проверяем ортогональность, попадание в концы, обход препятствий, длину.

const isOrthogonal = (pts: EdgePoint[]): boolean =>
  pts.every((p, i) => i === 0 || Math.abs(p.x - pts[i - 1].x) < 0.5 || Math.abs(p.y - pts[i - 1].y) < 0.5);

const manhattan = (pts: EdgePoint[]): number =>
  pts.reduce((s, p, i) => (i === 0 ? 0 : s + Math.abs(p.x - pts[i - 1].x) + Math.abs(p.y - pts[i - 1].y)), 0);

const rect = (x: number, y: number, w: number, h: number): NodeRect => ({ x, y, w, h });

describe("routeOrthogonal — без препятствий", () => {
  it("соосные концы → прямой отрезок", () => {
    const p = routeOrthogonal({ x: 0, y: 0 }, { x: 300, y: 0 }, []);
    expect(p).toEqual([{ x: 0, y: 0 }, { x: 300, y: 0 }]);
  });

  it("диагональ → L-угол (1 излом), длина = манхэттен", () => {
    const p = routeOrthogonal({ x: 0, y: 0 }, { x: 200, y: 100 }, []);
    expect(p[0]).toEqual({ x: 0, y: 0 });
    expect(p[p.length - 1]).toEqual({ x: 200, y: 100 });
    expect(isOrthogonal(p)).toBe(true);
    expect(p.length).toBe(3);            // один излом
    expect(manhattan(p)).toBe(300);
  });
});

describe("routeOrthogonal — обход препятствия", () => {
  const blocker = rect(100, -50, 100, 100); // x∈[100,200], y∈[-50,50] на прямой y=0

  it("узел на прямой между концами → путь его огибает", () => {
    const p = routeOrthogonal({ x: 0, y: 0 }, { x: 300, y: 0 }, [blocker]);
    expect(p[0]).toEqual({ x: 0, y: 0 });
    expect(p[p.length - 1]).toEqual({ x: 300, y: 0 });
    expect(isOrthogonal(p)).toBe(true);
    expect(pathCrossesRects(p, [blocker])).toBe(false); // не режет тело узла
    expect(p.length).toBeGreaterThan(2);                // появился обход
  });

  it("обход — аккуратная C-скоба (минимум изломов, ровно 2)", () => {
    const p = routeOrthogonal({ x: 0, y: 0 }, { x: 300, y: 0 }, [blocker]);
    expect(p.length).toBe(4); // 2 излома: вверх/вниз и обратно
  });

  it("узел в стороне (не на пути) → маршрут не удлиняется лишним обходом", () => {
    const aside = rect(100, 200, 100, 100); // далеко снизу, прямую y=0 не задевает
    const p = routeOrthogonal({ x: 0, y: 0 }, { x: 300, y: 0 }, [aside]);
    expect(p).toEqual([{ x: 0, y: 0 }, { x: 300, y: 0 }]);
  });
});

describe("routeOrthogonal — запасной вариант", () => {
  it("совпавшие концы → единственная точка", () => {
    const p = routeOrthogonal({ x: 10, y: 10 }, { x: 10, y: 10 }, []);
    expect(p).toEqual([{ x: 10, y: 10 }]);
  });
});

// «Шпилька»: два излома подряд с разворотом направления на 180° и коротким средним
// сегментом — визуальный дефект V1, который V2.1 исключает по построению.
const hasHairpin = (pts: EdgePoint[], jog = 30): boolean => {
  const dirs: Array<{ dx: number; dy: number; len: number }> = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y;
    const len = Math.abs(dx) + Math.abs(dy);
    if (len < 0.5) continue;
    dirs.push({ dx: Math.sign(dx), dy: Math.sign(dy), len });
  }
  for (let i = 0; i + 2 < dirs.length + 0 && dirs[i + 2]; i++) {
    const a = dirs[i], b = dirs[i + 1], c = dirs[i + 2];
    if (a.dx === -c.dx && a.dy === -c.dy && b.len <= jog) return true;
  }
  return false;
};

describe("routeOrthogonal — направленные порты (V2.1)", () => {
  // источник x∈[0,100] y∈[0,100], цель x∈[400,500] y∈[0,100] — тела СВОИХ узлов в препятствиях
  const src = rect(0, 0, 100, 100);
  const tgt = rect(400, 0, 100, 100);

  it("обращённые стороны → прямой маршрут, стабы схлопнуты cleanup-ом", () => {
    const p = routeOrthogonal({ x: 100, y: 50 }, { x: 400, y: 50 }, [src, tgt], {
      startSide: "right", endSide: "left",
    });
    expect(p).toEqual([{ x: 100, y: 50 }, { x: 400, y: 50 }]);
  });

  it("хэндл «не с той стороны» → честный обход своего тела, без шпильки", () => {
    // выход из ЛЕВОЙ грани источника, цель справа: раньше A* шёл сквозь своё тело, а
    // стаб-патч приклеивал разворот. Теперь маршрут обязан выйти влево и обогнуть узел.
    const p = routeOrthogonal({ x: 0, y: 50 }, { x: 400, y: 50 }, [src, tgt], {
      startSide: "left", endSide: "left",
    });
    expect(p[0]).toEqual({ x: 0, y: 50 });
    expect(p[p.length - 1]).toEqual({ x: 400, y: 50 });
    expect(p[1].x).toBeLessThanOrEqual(-20 + 0.5);        // вышел наружу на полный стаб
    expect(pathCrossesRects(p, [src, tgt])).toBe(false);  // своё тело не режет
    expect(hasHairpin(p)).toBe(false);                    // разворотов-шпилек нет
  });

  it("стаб укорачивается до зазора, когда сосед вплотную (NODE_SEP_PAD)", () => {
    const neighbor = rect(112, 0, 100, 100); // 12px от правой грани источника
    const p = routeOrthogonal({ x: 100, y: 50 }, { x: 312, y: 150 }, [src, neighbor], {
      startSide: "right", endSide: "bottom",
    });
    expect(p[0]).toEqual({ x: 100, y: 50 });
    expect(pathCrossesRects(p, [src, neighbor])).toBe(false); // стаб-точка не внутри соседа
  });
});

describe("routePorts — порты-кандидаты (V2.2, ядро)", () => {
  const src = rect(0, 0, 100, 100);
  const tgt = rect(400, 0, 100, 100);

  it("из двух стартовых портов выбирает тот, что даёт лучший маршрут", () => {
    const r = routePorts(
      [
        { point: { x: 0, y: 50 }, side: "left" },    // пришлось бы огибать своё тело
        { point: { x: 100, y: 50 }, side: "right" }, // прямой ход к цели
      ],
      [{ point: { x: 400, y: 50 }, side: "left" }],
      [src, tgt],
    );
    expect(r).not.toBeNull();
    expect(r!.startIdx).toBe(1);
    expect(r!.pts).toEqual([{ x: 100, y: 50 }, { x: 400, y: 50 }]);
  });

  it("из двух целевых портов выбирает ближний по маршруту", () => {
    const r = routePorts(
      [{ point: { x: 100, y: 50 }, side: "right" }],
      [
        { point: { x: 450, y: 100 }, side: "bottom" },
        { point: { x: 400, y: 50 }, side: "left" },
      ],
      [src, tgt],
    );
    expect(r).not.toBeNull();
    expect(r!.endIdx).toBe(1);
  });
});

// Штраф порта (2026-07-15, против нелегальной парковки Т4): дорогой порт проигрывает
// чистой альтернативе, даже более дальней; при отсутствии альтернатив остаётся достижим.
describe("routePorts — штраф порта (penalty)", () => {
  it("дорогая ближняя цель проигрывает чистой дальней", () => {
    const r = routePorts(
      [{ point: { x: 0, y: 0 } }],
      [
        { point: { x: 200, y: 0 }, penalty: 600 }, // прямая, но порт занят (штраф)
        { point: { x: 200, y: 50 } },              // +50px и излом, зато чисто
      ],
      [],
    );
    expect(r).not.toBeNull();
    expect(r!.endIdx).toBe(1);
    expect(r!.pts[r!.pts.length - 1]).toEqual({ x: 200, y: 50 });
  });

  it("без штрафов выбор прежний (ближняя прямая)", () => {
    const r = routePorts(
      [{ point: { x: 0, y: 0 } }],
      [{ point: { x: 200, y: 0 } }, { point: { x: 200, y: 50 } }],
      [],
    );
    expect(r).not.toBeNull();
    expect(r!.endIdx).toBe(0);
  });

  it("штраф стартового порта отводит на чистый старт", () => {
    const r = routePorts(
      [
        { point: { x: 0, y: 0 }, penalty: 600 },
        { point: { x: 0, y: 50 } },
      ],
      [{ point: { x: 200, y: 0 } }],
      [],
    );
    expect(r).not.toBeNull();
    expect(r!.startIdx).toBe(1);
  });

  it("единственный дорогой порт НЕ блокирует маршрут (мягкость)", () => {
    const r = routePorts(
      [{ point: { x: 0, y: 0 } }],
      [{ point: { x: 200, y: 0 }, penalty: 600 }],
      [],
    );
    expect(r).not.toBeNull();
    expect(r!.pts[r!.pts.length - 1]).toEqual({ x: 200, y: 0 });
  });
});
