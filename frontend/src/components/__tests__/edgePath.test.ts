import { describe, it, expect } from "vitest";
import {
  orthogonalPoints, orthogonalPointsForHandles, ensureOutwardStubs, buildRenderPoints, segments, dragSegment, cleanup, interior, snapDragCursor, pathCrossesRects, pointAtFraction, nearestFraction, type NodeRect,
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

describe("orthogonalPointsForHandles", () => {
  it("противоположные горизонтальные стороны — серединный Z (как orthogonalPoints)", () => {
    expect(orthogonalPointsForHandles(0, 0, "right", 100, 40, "left")).toEqual([
      P(0, 0), P(50, 0), P(50, 40), P(100, 40),
    ]);
  });
  it("противоположные вертикальные стороны — Z через середину Y", () => {
    expect(orthogonalPointsForHandles(0, 0, "bottom", 40, 100, "top")).toEqual([
      P(0, 0), P(0, 50), P(40, 50), P(40, 100),
    ]);
  });
  it("смешанные: источник горизонтален, цель вертикальна → один сгиб (tx, sy)", () => {
    expect(orthogonalPointsForHandles(0, 0, "right", 80, 60, "top")).toEqual([
      P(0, 0), P(80, 0), P(80, 60),
    ]);
  });
  it("смешанные: источник вертикален, цель горизонтальна → один сгиб (sx, ty)", () => {
    expect(orthogonalPointsForHandles(0, 0, "bottom", 80, 60, "left")).toEqual([
      P(0, 0), P(0, 60), P(80, 60),
    ]);
  });
  it("учитывает сторону хэндла, а не доминанту dx/dy (где orthogonalPoints разошёлся бы)", () => {
    // dx(80) > dy(20): orthogonalPoints выбрал бы горизонтальный Z; но цель входит сверху,
    // поэтому маршрут грипов должен быть L со сгибом (tx, sy), совпадая со smoothstep.
    expect(orthogonalPointsForHandles(0, 0, "right", 80, 20, "top")).toEqual([
      P(0, 0), P(80, 0), P(80, 20),
    ]);
  });

  // --- стаб: хэндл смотрит ПРОТИВ цели → выход наружу перед изломом ---
  it("HH, хэндлы смотрят друг от друга (цель за источником) → стабы наружу + перемычка", () => {
    // S справа (выход вправо), но T слева от него и тоже смотрит наружу влево.
    // Прямой Z спрятался бы за узлами; ждём выход на stub=20 наружу обоих концов.
    expect(orthogonalPointsForHandles(100, 0, "right", 0, 40, "left", 20)).toEqual([
      P(100, 0), P(120, 0), P(120, 20), P(-20, 20), P(-20, 40), P(0, 40),
    ]);
  });
  it("HH, обе стороны справа → перемычка уводится за оба узла (вправо на stub)", () => {
    // оба хэндла на right: чистая перемычка снаружи справа, без захода под тело узлов.
    expect(orthogonalPointsForHandles(0, 0, "right", 100, 40, "right", 20)).toEqual([
      P(0, 0), P(120, 0), P(120, 40), P(100, 40),
    ]);
  });
  it("VV, хэндлы смотрят друг от друга → стабы наружу по Y + перемычка", () => {
    expect(orthogonalPointsForHandles(0, 100, "bottom", 40, 0, "top", 20)).toEqual([
      P(0, 100), P(0, 120), P(20, 120), P(20, -20), P(40, -20), P(40, 0),
    ]);
  });
  it("смешанный: источник смотрит ПРОТИВ цели → стаб наружу, затем разворот", () => {
    // S справа, но цель слева-снизу: чистый угол увёл бы линию сразу влево за узел.
    // Ждём стаб вправо на 20, спуск к уровню входа цели, затем в её колонку.
    expect(orthogonalPointsForHandles(0, 0, "right", -80, 60, "top", 20)).toEqual([
      P(0, 0), P(20, 0), P(20, 40), P(-80, 40), P(-80, 60),
    ]);
  });
});

describe("ensureOutwardStubs — обязательный выход из хэндла наружу", () => {
  const OUT = {
    left: P(-1, 0), right: P(1, 0), top: P(0, -1), bottom: P(0, 1),
  } as const;
  // первый сегмент должен идти строго наружу вдоль нормали стороны на ≥ 20
  const leavesOutward = (pts: EdgePoint[], side: keyof typeof OUT): boolean => {
    const n = OUT[side];
    const v = P(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    const along = v.x * n.x + v.y * n.y;
    const perp = Math.abs(v.x) * (1 - Math.abs(n.x)) + Math.abs(v.y) * (1 - Math.abs(n.y));
    return perp < 0.001 && along >= 20 - 0.001;
  };
  const entersOutward = (pts: EdgePoint[], side: keyof typeof OUT): boolean => {
    const n = OUT[side];
    const k = pts.length;
    const v = P(pts[k - 2].x - pts[k - 1].x, pts[k - 2].y - pts[k - 1].y); // от T наружу
    const along = v.x * n.x + v.y * n.y;
    const perp = Math.abs(v.x) * (1 - Math.abs(n.x)) + Math.abs(v.y) * (1 - Math.abs(n.y));
    return perp < 0.001 && along >= 20 - 0.001;
  };

  it("первый сегмент идёт ВНУТРЬ узла (bottom-хэндл, путь вверх и вбок) → стаб наружу", () => {
    const pts = [P(0, 100), P(50, 100), P(50, 40)]; // от bottom-хэндла сразу вбок
    const out = ensureOutwardStubs(pts, "bottom", "top");
    expect(leavesOutward(out, "bottom")).toBe(true);
    expect(out[0]).toEqual(P(0, 100)); // сам хэндл не сдвинулся
  });

  it("конец входит в цель ВНУТРЬ (top-хэндл, подход вбок) → стаб у цели наружу", () => {
    const pts = [P(0, 0), P(0, -60), P(50, -60)]; // в top-цель приходит сбоку
    const out = ensureOutwardStubs(pts, "bottom", "top");
    expect(entersOutward(out, "top")).toBe(true);
    expect(out[out.length - 1]).toEqual(P(50, -60)); // сам конец не сдвинулся
  });

  it("перпендикулярный первый сегмент вдоль края (right-хэндл, путь вверх) → стаб вправо", () => {
    const pts = [P(0, 0), P(0, -50), P(60, -50), P(60, 0)];
    const out = ensureOutwardStubs(pts, "right", "right");
    expect(leavesOutward(out, "right")).toBe(true);
  });

  it("здоровый путь (стаб уже наружу ≥ 20) — не трогаем", () => {
    const pts = [P(0, 0), P(0, -40), P(80, -40), P(80, 0)];
    expect(ensureOutwardStubs(pts, "top", "top")).toEqual(pts);
  });

  it("идемпотентность: повторный прогон ничего не меняет", () => {
    const pts = [P(0, 100), P(50, 100), P(50, 40)];
    const once = ensureOutwardStubs(pts, "bottom", "top");
    expect(ensureOutwardStubs(once, "bottom", "top")).toEqual(once);
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

describe("pathCrossesRects", () => {
  const rect: NodeRect = { x: 100, y: 100, w: 190, h: 100 }; // узел [100..290]×[100..200]
  it("горизонтальный сегмент сквозь узел → true", () => {
    // линия y=150 от x=0 до x=400 проходит через узел
    expect(pathCrossesRects([P(0, 150), P(400, 150)], [rect])).toBe(true);
  });
  it("вертикальный сегмент сквозь узел → true", () => {
    expect(pathCrossesRects([P(150, 0), P(150, 400)], [rect])).toBe(true);
  });
  it("сегмент мимо узла → false", () => {
    // y=50 выше узла
    expect(pathCrossesRects([P(0, 50), P(400, 50)], [rect])).toBe(false);
  });
  it("касание ровно по верхней границе не считается пересечением", () => {
    expect(pathCrossesRects([P(0, 100), P(400, 100)], [rect])).toBe(false);
  });
  it("ломаная-обвод над узлом → false (для того и нужен обвод)", () => {
    // S=(0,150) → вверх до y=40 → вправо до x=350 → вниз: огибает узел сверху
    const detour = [P(0, 150), P(0, 40), P(350, 40), P(350, 150)];
    expect(pathCrossesRects(detour, [rect])).toBe(false);
  });
  it("пустой список прямоугольников → false", () => {
    expect(pathCrossesRects([P(0, 150), P(400, 150)], [])).toBe(false);
  });
});

describe("interior", () => {
  it("возвращает точки между концами", () => {
    expect(interior([P(0, 0), P(50, 0), P(50, 40), P(100, 40)])).toEqual([P(50, 0), P(50, 40)]);
    expect(interior([P(0, 0), P(100, 0)])).toEqual([]);
  });
});

describe("pointAtFraction — точка по доле arc-length", () => {
  const line = [P(0, 0), P(100, 0)];        // прямой отрезок длины 100
  // Г-образный путь: горизонталь 100 + вертикаль 100, общая длина 200, угол на доле 0.5
  const ell = [P(0, 0), P(100, 0), P(100, 100)];

  it("t=0/1 → концы пути", () => {
    expect(pointAtFraction(line, 0)).toEqual(P(0, 0));
    expect(pointAtFraction(line, 1)).toEqual(P(100, 0));
    expect(pointAtFraction(ell, 1)).toEqual(P(100, 100));
  });
  it("t=0.5 на прямой — середина", () => {
    expect(pointAtFraction(line, 0.5)).toEqual(P(50, 0));
  });
  it("t зажат в [0,1]", () => {
    expect(pointAtFraction(line, -2)).toEqual(P(0, 0));
    expect(pointAtFraction(line, 5)).toEqual(P(100, 0));
  });
  it("учитывает arc-length по звеньям, а не индексы точек", () => {
    // на Г-пути доля 0.5 = ровно угол (100 из 200), 0.75 = середина вертикали
    expect(pointAtFraction(ell, 0.5)).toEqual(P(100, 0));
    expect(pointAtFraction(ell, 0.75)).toEqual(P(100, 50));
  });
  it("вырожденный путь → первая точка", () => {
    expect(pointAtFraction([P(7, 7)], 0.5)).toEqual(P(7, 7));
    expect(pointAtFraction([P(7, 7), P(7, 7)], 0.5)).toEqual(P(7, 7));
  });
});

describe("nearestFraction — проекция курсора на путь", () => {
  const line = [P(0, 0), P(100, 0)];
  const ell = [P(0, 0), P(100, 0), P(100, 100)];

  it("курсор над серединой → t≈0.5", () => {
    expect(nearestFraction(line, P(50, 30))).toBeCloseTo(0.5, 5);
  });
  it("курсор за концом → зажат к концу (t=0 или 1)", () => {
    expect(nearestFraction(line, P(-40, 5))).toBeCloseTo(0, 5);
    expect(nearestFraction(line, P(180, -5))).toBeCloseTo(1, 5);
  });
  it("обратима с pointAtFraction на середине вертикали Г-пути", () => {
    // точка чуть правее середины вертикали проецируется на неё → t≈0.75
    expect(nearestFraction(ell, P(130, 50))).toBeCloseTo(0.75, 5);
  });
  it("вырожденный путь → 0", () => {
    expect(nearestFraction([P(7, 7)], P(9, 9))).toBe(0);
  });
});
