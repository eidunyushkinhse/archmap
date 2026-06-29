import { describe, it, expect } from "vitest";
import { routeOrthogonal } from "../graph/layout/orthoRoute";
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
