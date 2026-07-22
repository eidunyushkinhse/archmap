import { describe, it, expect } from "vitest";
import { projectLabelOntoRoute, seamRoute } from "../graph/edges";
import { cleanup, ensureOutwardStubs } from "../graph/edgePath";
import type { LabelPlacement } from "../graph/layout/labelLayout";
import type { EdgePoint } from "../../types";

// Привязка плашки к НАРИСОВАННОЙ ломаной (edges.tsx). Фикс сползания плашек при драге
// (2026-07-22): драг-хук кладёт плашку на интерполированный маршрут, а рендер рисует линию
// по живым хэндлам — «ШОВ V2.2b» выпрямляет концы, ensureOutwardStubs вставляет изломы
// (диагональ из 2 точек → 3-плечая ортогональ). Нарисованная линия расходится с маршрутом
// плашки, и без привязки плашка сползает. projectLabelOntoRoute окончательно кладёт плашку
// на видимую линию. Тестируем чистую функцию (без React/RF).

function place(cx: number, cy: number): LabelPlacement {
  return { mode: "online", center: { x: cx, y: cy }, anchor: { x: cx, y: cy }, leaderEnd: { x: cx, y: cy } };
}

function leader(ax: number, ay: number, ox: number, oy: number): LabelPlacement {
  return {
    mode: "leader",
    anchor: { x: ax, y: ay },
    center: { x: ax + ox, y: ay + oy },
    leaderEnd: { x: ax + ox, y: ay + oy },
  };
}

// Расстояние от точки до ломаной (минимум по сегментам) — инвариант «плашка на линии».
function distToRoute(p: { x: number; y: number }, route: EdgePoint[]): number {
  let best = Infinity;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i], b = route[i + 1];
    const abx = b.x - a.x, aby = b.y - a.y;
    const lenSq = abx * abx + aby * aby;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq));
    const qx = a.x + t * abx, qy = a.y + t * aby;
    best = Math.min(best, Math.hypot(p.x - qx, p.y - qy));
  }
  return best;
}

describe("projectLabelOntoRoute (привязка плашки к нарисованной линии)", () => {
  it("online-плашка вне линии проецируется на ближайший сегмент", () => {
    // Нарисованная L-линия; плашка в (50,25) — НАД первым сегментом (y=0), как если бы её
    // оставила интерполяция на диагонали, а линия выпрямилась.
    const drawn: EdgePoint[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }];
    const out = projectLabelOntoRoute(place(50, 25), drawn);
    expect(out.center).toEqual({ x: 50, y: 0 }); // легла на горизонтальный сегмент
    expect(out.anchor).toEqual({ x: 50, y: 0 });
    expect(distToRoute(out.center, drawn)).toBeLessThan(1e-6);
  });

  it("сценарий пользователя: диагональ → 3-плечая ортогональ (ensureOutwardStubs), плашка на линии", () => {
    // В покое стрелка из ОДНОГО плеча (2 точки). При драге источника перпендикулярно интерполяция
    // даёт диагональ, а рендер через ensureOutwardStubs (концы выходят из узлов перпендикулярно
    // стороне хэндла) превращает её в ортогональ с изломами. Плашка, посчитанная на диагонали,
    // обязана лечь на эту ортогональ.
    const diagonal: EdgePoint[] = [{ x: 0, y: 40 }, { x: 100, y: 0 }]; // источник сдвинут вниз
    // Та же обработка, что в рендере (edges.tsx): cleanup + ensureOutwardStubs(minAlong=2).
    const drawn = ensureOutwardStubs(cleanup(diagonal), "right", "left", undefined, 2);
    // ensureOutwardStubs вставил изломы — плеч стало больше, и они ортогональны.
    expect(drawn.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < drawn.length - 1; i++) {
      const horiz = drawn[i].y === drawn[i + 1].y, vert = drawn[i].x === drawn[i + 1].x;
      expect(horiz || vert).toBe(true);
    }
    // Плашка на середине диагонали (50,20) — там её оставляет интерполяция.
    const out = projectLabelOntoRoute(place(50, 20), drawn);
    expect(distToRoute(out.center, drawn)).toBeLessThan(1e-6); // легла на нарисованную ортогональ
  });

  it("leader-плашка: якорь проецируется на линию, вынос центра сохранён", () => {
    const drawn: EdgePoint[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }];
    // якорь в (50,25) — над линией; центр вынесен на (0,-20) → (50,5)
    const out = projectLabelOntoRoute(leader(50, 25, 0, -20), drawn);
    expect(out.anchor).toEqual({ x: 50, y: 0 });    // якорь на линии
    expect(out.center).toEqual({ x: 50, y: -20 });  // вынос (0,-20) сохранён
    expect(out.mode).toBe("leader");
    expect(distToRoute(out.anchor, drawn)).toBeLessThan(1e-6);
  });

  it("no-op: плашка уже на линии — возвращается тот же объект", () => {
    const drawn: EdgePoint[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    const lp = place(50, 0);
    expect(projectLabelOntoRoute(lp, drawn)).toBe(lp);
  });

  it("маршрут короче 2 точек — плашка не меняется (тот же объект)", () => {
    const lp = place(50, 0);
    expect(projectLabelOntoRoute(lp, [{ x: 0, y: 0 }])).toBe(lp);
    expect(projectLabelOntoRoute(lp, [])).toBe(lp);
  });

  it("инвариант: опорная точка ложится на линию для серии позиций вне маршрута", () => {
    const drawn: EdgePoint[] = [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 90 }, { x: 240, y: 90 }];
    const offs = [{ x: 60, y: 30 }, { x: 60, y: -30 }, { x: 120, y: 45 }, { x: 200, y: 60 }, { x: 10, y: 15 }];
    for (const p of offs) {
      const onl = projectLabelOntoRoute(place(p.x, p.y), drawn);
      expect(distToRoute(onl.center, drawn)).toBeLessThan(1e-6);
      const led = projectLabelOntoRoute(leader(p.x, p.y, 12, -18), drawn);
      expect(distToRoute(led.anchor, drawn)).toBeLessThan(1e-6);
      // вынос лидера сохранён
      expect(led.center.x - led.anchor.x).toBe(12);
      expect(led.center.y - led.anchor.y).toBe(-18);
    }
  });
});

// «ШОВ V2.2b» (seamRoute): концы маршрута по живым хэндлам + выпрямление концевых сегментов
// по ОСИ ХЭНДЛА. Фикс петель при драге (2026-07-22): интерполяция ставит первый сегмент
// «боком» к хэндлу; выпрямление по оси хэндла (а не по ориентации сегмента) даёт чистый выход
// наружу → ensureOutwardStubs no-op, крюк-петля не вставляется.
describe("seamRoute (шов по оси хэндла, фикс петель)", () => {
  // Та же обработка, что в рендере: seamRoute → cleanup → ensureOutwardStubs(minAlong=2).
  const drawn = (route: EdgePoint[], s: EdgePoint, t: EdgePoint, sSide: "left" | "right" | "top" | "bottom", tSide: "left" | "right" | "top" | "bottom") =>
    ensureOutwardStubs(cleanup(seamRoute(route.map((p) => ({ ...p })), s, t, sSide, tSide)), sSide, tSide, undefined, 2);

  it("перпендикулярный драг (источник далеко вниз): чистая ортогональ без петель", () => {
    // Интерполированный маршрут: источник уехал вниз, первый сегмент стал «более вертикальным».
    // s — живой хэндл источника (правый), t — хэндл цели (левый).
    const interp: EdgePoint[] = [{ x: 0, y: 300 }, { x: 50, y: 225 }, { x: 50, y: 175 }, { x: 100, y: 100 }];
    const out = drawn(interp, { x: 0, y: 300 }, { x: 100, y: 100 }, "right", "left");
    // Шов по оси хэндла: первый сегмент горизонтален (right), последний горизонтален (left).
    // ensureOutwardStubs — no-op (чистый выход наружу), крюки НЕ вставляются → 4 точки.
    expect(out).toEqual([
      { x: 0, y: 300 }, { x: 50, y: 300 }, { x: 50, y: 100 }, { x: 100, y: 100 },
    ]);
  });

  it("регрессия: шов по ориентации сегмента (старое решение) вставлял крюки-петли", () => {
    // Тот же интерполированный маршрут, но ось выпрямления — по ориентации сегмента (как было):
    // первый сегмент «более вертикальный» → выпрямляется ВЕРТИКАЛЬНО → идёт вдоль края узла,
    // ensureOutwardStubs вставляет крюки с обоих концов (точки лишние — это и есть петли).
    const interp: EdgePoint[] = [{ x: 0, y: 300 }, { x: 50, y: 225 }, { x: 50, y: 175 }, { x: 100, y: 100 }];
    const raw = interp.map((p) => ({ ...p }));
    const headHoriz = Math.abs(raw[1].y - raw[0].y) <= Math.abs(raw[1].x - raw[0].x); // 75<=50 → false
    const tailHoriz = Math.abs(raw[2].y - raw[3].y) <= Math.abs(raw[2].x - raw[3].x); // 75<=50 → false
    if (headHoriz) raw[1].y = 300; else raw[1].x = 0;
    if (tailHoriz) raw[2].y = 100; else raw[2].x = 100;
    raw[0] = { x: 0, y: 300 };
    raw[3] = { x: 100, y: 100 };
    const oldOut = ensureOutwardStubs(cleanup(raw), "right", "left", undefined, 2);
    // Крюки вставились: точек больше, чем 4 (чистая ортогональ).
    expect(oldOut.length).toBeGreaterThan(4);
  });

  it("покой: маршрут роутера (сегмент по оси хэндла) не меняется", () => {
    const route: EdgePoint[] = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 100 }, { x: 100, y: 100 }];
    const out = drawn(route, { x: 0, y: 0 }, { x: 100, y: 100 }, "right", "left");
    expect(out).toEqual([
      { x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 100 }, { x: 100, y: 100 },
    ]);
  });

  it("вертикальный хэндл (bottom): первый сегмент выпрямляется вертикально", () => {
    // Хэндл источника снизу (нормаль +y) → первый сегмент вертикальный (headHoriz=false).
    const interp: EdgePoint[] = [{ x: 0, y: 0 }, { x: 30, y: 50 }, { x: 100, y: 50 }];
    const out = seamRoute(interp.map((p) => ({ ...p })), { x: 0, y: 0 }, { x: 100, y: 50 }, "bottom", "left");
    // raw[1].x = s.x = 0 (вертикальный выход вниз из источника)
    expect(out[1]).toEqual({ x: 0, y: 50 });
    expect(out[0]).toEqual({ x: 0, y: 0 });
  });

  it("короткий маршрут (<3 точек): только пересъём концов", () => {
    const out = seamRoute([{ x: 5, y: 5 }, { x: 90, y: 95 }], { x: 0, y: 0 }, { x: 100, y: 100 }, "right", "left");
    expect(out).toEqual([{ x: 0, y: 0 }, { x: 100, y: 100 }]);
  });
});
