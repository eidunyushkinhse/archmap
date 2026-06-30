import { describe, it, expect } from "vitest";
import { nudgeOverlaps } from "../graph/layout/nudgeOverlaps";
import type { EdgePoint } from "../../types";

const h = (s: string, t: string) => ({ sourceHandle: s, targetHandle: t });

// Длина коллинеарного перекрытия вертикальных сегментов двух ломаных на линии x=axis.
function vOverlapAt(a: EdgePoint[], b: EdgePoint[], axis: number): number {
  const vsegs = (p: EdgePoint[]) =>
    p.slice(0, -1).map((q, i) => ({ q, r: p[i + 1] }))
      .filter(({ q, r }) => Math.abs(q.x - r.x) < 0.5 && Math.abs(q.x - axis) < 0.5)
      .map(({ q, r }) => [Math.min(q.y, r.y), Math.max(q.y, r.y)] as [number, number]);
  let max = 0;
  for (const [a1, a2] of vsegs(a)) for (const [b1, b2] of vsegs(b)) {
    max = Math.max(max, Math.min(a2, b2) - Math.max(a1, b1));
  }
  return max;
}

describe("nudgeOverlaps (расталкивание плеч из разных хэндлов, A13)", () => {
  it("реальный конфликт HelixMon: короткий джог уезжает с хайвэя соседа", () => {
    // ОС-хосты→ObsCore (хэндл ObsCore--left--2): короткий джог V@320 на y∈[255,265]
    const os: EdgePoint[] = [
      { x: -272, y: 304 }, { x: -252, y: 304 }, { x: -252, y: 265 },
      { x: 320, y: 265 }, { x: 320, y: 255 }, { x: 340, y: 255 },
    ];
    // ObsCore→JMX (хэндл ObsCore--left--1): длинный хайвэй V@320 на y∈[230,343]
    const jmx: EdgePoint[] = [
      { x: 340, y: 230 }, { x: 320, y: 230 }, { x: 320, y: 343 }, { x: -58, y: 343 },
    ];
    const routes = new Map<string, EdgePoint[]>([["os", os], ["jmx", jmx]]);
    const handles = new Map([
      ["os", h("7e1d--right--2", "68eb--left--2")],
      ["jmx", h("68eb--left--1", "44f9--right--1")],
    ]);
    const { routes: out, nudged } = nudgeOverlaps(routes, handles);
    // сдвинули короткий (os), хайвэй (jmx) нетронут
    expect(nudged.has("os")).toBe(true);
    expect(nudged.has("jmx")).toBe(false);
    // наложение на x=320 устранено
    expect(vOverlapAt(out.get("os")!, out.get("jmx")!, 320)).toBeLessThanOrEqual(3);
    // концы os не сдвинулись (стыковка с хэндлами цела)
    const o = out.get("os")!;
    expect(o[0]).toEqual({ x: -272, y: 304 });
    expect(o[o.length - 1]).toEqual({ x: 340, y: 255 });
  });

  it("совпадение из ОДНОГО хэндла (родственные стрелки) НЕ трогаем", () => {
    // оба выходят из 68eb--left--1, общий ствол H@230 — легитимно (R4)
    const a: EdgePoint[] = [{ x: 340, y: 230 }, { x: 100, y: 230 }, { x: 100, y: 100 }];
    const b: EdgePoint[] = [{ x: 340, y: 230 }, { x: 100, y: 230 }, { x: 100, y: 400 }];
    const routes = new Map<string, EdgePoint[]>([["a", a], ["b", b]]);
    const handles = new Map([
      ["a", h("68eb--left--1", "x--right--1")],
      ["b", h("68eb--left--1", "y--right--1")],
    ]);
    const { nudged } = nudgeOverlaps(routes, handles);
    expect(nudged.size).toBe(0);
  });

  it("концы на хэндлах не двигаем: если плечо концевое — сдвигаем встречного кандидата", () => {
    // edge A: наложение приходится на КОНЦЕВОЙ сегмент (последний, в хэндл) — двигать нельзя
    const a: EdgePoint[] = [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 50, y: 100 }];
    // edge B: то же плечо V@0, но у B оно ИНТЕРЬЕРНОЕ
    const b: EdgePoint[] = [{ x: -40, y: 50 }, { x: 0, y: 50 }, { x: 0, y: 80 }, { x: 40, y: 80 }, { x: 40, y: 200 } ];
    const routes = new Map<string, EdgePoint[]>([["a", a], ["b", b]]);
    const handles = new Map([
      ["a", h("p--top--1", "q--left--1")],
      ["b", h("r--right--1", "s--bottom--1")],
    ]);
    const { routes: out, nudged } = nudgeOverlaps(routes, handles);
    // A концевое плечо нетронуто, B (интерьерное) сдвинут
    expect(nudged.has("a")).toBe(false);
    expect(nudged.has("b")).toBe(true);
    // концы B на месте
    const ob = out.get("b")!;
    expect(ob[0]).toEqual({ x: -40, y: 50 });
    expect(ob[ob.length - 1]).toEqual({ x: 40, y: 200 });
  });

  it("нет наложений — маршруты возвращаются как есть (тот же объект)", () => {
    const a: EdgePoint[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
    const b: EdgePoint[] = [{ x: 0, y: 300 }, { x: 200, y: 300 }, { x: 200, y: 400 }];
    const routes = new Map<string, EdgePoint[]>([["a", a], ["b", b]]);
    const handles = new Map([
      ["a", h("p--bottom--1", "q--top--1")],
      ["b", h("r--bottom--1", "s--top--1")],
    ]);
    const { routes: out, nudged } = nudgeOverlaps(routes, handles);
    expect(nudged.size).toBe(0);
    expect(out.get("a")).toBe(a); // не пересоздаём нетронутые
    expect(out.get("b")).toBe(b);
  });
});
