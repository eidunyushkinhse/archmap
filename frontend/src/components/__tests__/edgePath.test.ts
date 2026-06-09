import { describe, it, expect } from "vitest";
import {
  orthogonalPoints, buildRenderPoints, segments, dragSegment, cleanup, interior, snapDragCursor,
} from "../graph/edgePath";
import type { EdgePoint } from "../../types";

const P = (x: number, y: number): EdgePoint => ({ x, y });

describe("orthogonalPoints", () => {
  it("горизонтальный поток — Z-кроссовер по вертикали на середине X", () => {
    expect(orthogonalPoints(0, 0, 100, 40)).toEqual([
      P(0, 0), P(50, 0), P(50, 40), P(100, 40),
    ]);
  });
  it("вертикальный поток — кроссовер по горизонтали на середине Y", () => {
    expect(orthogonalPoints(0, 0, 40, 100)).toEqual([
      P(0, 0), P(0, 50), P(40, 50), P(40, 100),
    ]);
  });
  it("соосные узлы — после cleanup это прямая", () => {
    expect(cleanup(orthogonalPoints(0, 0, 100, 0))).toEqual([P(0, 0), P(100, 0)]);
  });
});

describe("segments", () => {
  it("ориентация и индексы сегментов", () => {
    const pts = [P(0, 0), P(50, 0), P(50, 40), P(100, 40)];
    expect(segments(pts)).toEqual([
      { index: 0, x1: 0, y1: 0, x2: 50, y2: 0, orient: "h" },
      { index: 1, x1: 50, y1: 0, x2: 50, y2: 40, orient: "v" },
      { index: 2, x1: 50, y1: 40, x2: 100, y2: 40, orient: "h" },
    ]);
  });
});

describe("dragSegment — внутренний сегмент", () => {
  it("вертикальный кроссовер тянется по X (обе внутренние точки)", () => {
    const pts = [P(0, 0), P(50, 0), P(50, 40), P(100, 40)];
    const res = dragSegment(pts, 1, P(70, 999));
    expect(res).toEqual([P(0, 0), P(70, 0), P(70, 40), P(100, 40)]);
  });
});

describe("dragSegment — вставка колена у пиннутого конца", () => {
  it("прямая горизонталь → тянем единственный сегмент по Y → «стапл» из двух колен", () => {
    const pts = [P(0, 0), P(100, 0)]; // straight, S и T пиннутые
    const res = dragSegment(pts, 0, P(999, 30));
    // S → вниз до y=30 → поперёк → вверх к T
    expect(res).toEqual([P(0, 0), P(0, 30), P(100, 30), P(100, 0)]);
  });
  it("первый сегмент при пиннутом S сохраняет вертикальный стаб", () => {
    const pts = [P(0, 0), P(50, 0), P(50, 40), P(100, 40)];
    // тянем горизонтальный сегмент 0 (S→(50,0)) по Y вниз
    const res = dragSegment(pts, 0, P(999, 20));
    // S остаётся, стаб (0,20) вертикалью, сегмент на y=20, дальше как было
    expect(res).toEqual([P(0, 0), P(0, 20), P(50, 20), P(50, 40), P(100, 40)]);
  });
});

describe("cleanup", () => {
  it("сливает коллинеарные и выкидывает дубликаты", () => {
    const pts = [P(0, 0), P(0, 0), P(50, 0), P(100, 0), P(100, 40)];
    expect(cleanup(pts)).toEqual([P(0, 0), P(100, 0), P(100, 40)]);
  });
});

describe("buildRenderPoints — нормализация при сдвинутом узле", () => {
  it("диагональный концевой сегмент разбивается коленом (ортогональность сохранена)", () => {
    // waypoints заданы для старого S=(0,0); узел уехал, новый S=(0,30) → S→w0 диагональ
    const res = buildRenderPoints(P(0, 30), P(100, 40), [P(50, 0), P(50, 40)]);
    // ни одного диагонального звена
    for (const s of segments(res)) {
      const horiz = s.y1 === s.y2, vert = s.x1 === s.x2;
      expect(horiz || vert).toBe(true);
    }
  });
  it("без waypoints — прямой [S,T] (или одно колено)", () => {
    expect(buildRenderPoints(P(0, 0), P(100, 0), [])).toEqual([P(0, 0), P(100, 0)]);
  });
});

describe("snapDragCursor — примагничивание плеча к хэндлу", () => {
  const pts = [P(0, 0), P(50, 0), P(50, 40), P(100, 40)]; // S=(0,0), T=(100,40)
  it("горизонтальный сегмент: Y у y хэндла в пределах порога притягивается", () => {
    // тянем сегмент 2 (горизонталь у T, y≈40) к y=37 при пороге 5 → прилипает к T.y=40
    expect(snapDragCursor(pts, 2, P(70, 37), 5)).toEqual(P(70, 40));
    // к y=3 → прилипает к S.y=0
    expect(snapDragCursor(pts, 2, P(70, 3), 5)).toEqual(P(70, 0));
  });
  it("вне порога — координата не меняется", () => {
    expect(snapDragCursor(pts, 2, P(70, 25), 5)).toEqual(P(70, 25));
  });
  it("вертикальный сегмент: X у x хэндла в пределах порога притягивается", () => {
    // сегмент 1 (вертикаль, x≈50) к x=97 при пороге 5 → прилипает к T.x=100
    expect(snapDragCursor(pts, 1, P(97, 20), 5)).toEqual(P(100, 20));
    // к x=2 → прилипает к S.x=0
    expect(snapDragCursor(pts, 1, P(2, 20), 5)).toEqual(P(0, 20));
  });
  it("индекс вне диапазона — курсор без изменений", () => {
    expect(snapDragCursor(pts, 99, P(70, 37), 5)).toEqual(P(70, 37));
  });
});

describe("interior", () => {
  it("возвращает точки между концами", () => {
    expect(interior([P(0, 0), P(50, 0), P(50, 40), P(100, 40)])).toEqual([P(50, 0), P(50, 40)]);
    expect(interior([P(0, 0), P(100, 0)])).toEqual([]);
  });
});
