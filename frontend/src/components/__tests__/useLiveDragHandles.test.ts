import { describe, it, expect } from "vitest";
import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import {
  resolveDragEdge,
  gestureAbsPositions,
  restoreDragEdges,
} from "../graph/interaction/useLiveDragHandles";
import type { LabelPlacement } from "../graph/layout/labelLayout";
import type { WrappedEdgeData } from "../graph/types";
import type { EdgePoint } from "../../types";

// Чистое решение по одному ребру за кадр драга (см. useLiveDragHandles). Тестируем узкие
// инварианты, которые ломались в бою: дрейф плашки при мультидраге (улетала за экран) и
// живой ре-роут гостевых/сквозных стрелок (плашка «слетала», превью ≠ финал).

function place(cx: number, cy: number): LabelPlacement {
  return {
    mode: "online",
    center: { x: cx, y: cy },
    anchor: { x: cx, y: cy },
    leaderEnd: { x: cx, y: cy },
  };
}

// leader-плашка: центр вынесен от якоря на (ox,oy) (поводок), режим "leader".
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

function edge(id: string, source: string, target: string, data: Partial<WrappedEdgeData> = {}): RFEdge {
  return { id, source, target, data } as unknown as RFEdge;
}

// Только поля, которые читает resolveDragEdge; остальное — дефолты. delta одинакова для
// всех тащимых узлов (как в реальном selection-драге — синхронный сдвиг).
type Frame = Parameters<typeof resolveDragEdge>[1];
function frame(over: {
  dragged: string[];
  delta?: { dx: number; dy: number };
  deltas?: Record<string, { dx: number; dy: number }>; // на узел (иначе общая delta)
  snapRoutes?: Map<string, EdgePoint[]>;
  snapLabels?: Map<string, LabelPlacement>;
  liveRoutes?: Map<string, EdgePoint[]> | null;
  liveHandles?: Map<string, { sourceHandle: string; targetHandle: string }> | null;
  liveLabels?: Map<string, LabelPlacement> | null;
  localIds?: Set<string>;
  fallbackHandles?: Map<string, { sourceHandle: string; targetHandle: string }>;
}): Frame {
  const delta = over.delta ?? { dx: 0, dy: 0 };
  return {
    draggedIds: new Set(over.dragged),
    deltaOf: (id) => over.deltas?.[id] ?? delta,
    snapRoutes: over.snapRoutes ?? new Map(),
    snapLabels: over.snapLabels ?? new Map(),
    liveRoutes: over.liveRoutes ?? null,
    liveHandles: over.liveHandles ?? null,
    liveLabels: over.liveLabels ?? null,
    localIds: over.localIds ?? new Set(),
    fallbackHandles: over.fallbackHandles ?? new Map(),
  };
}

describe("resolveDragEdge", () => {
  it("ребро без тащимых концов возвращается тем же объектом (RF не перерисует)", () => {
    const e = edge("e1", "a", "b", { autoRoute: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
    expect(resolveDragEdge(e, frame({ dragged: ["c"] }))).toBe(e);
  });

  it("мультидраг: маршрут и плашка едут от СНИМКА старта на суммарную дельту (без накопления)", () => {
    const route: EdgePoint[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    const snapRoutes = new Map([["e1", route]]);
    const snapLabels = new Map([["e1", place(50, 0)]]); // старт: центр (50,0)

    // Кадр 1: дельта (50,50). Плашка = снимок + дельта.
    const e0 = edge("e1", "a", "b", { autoRoute: route, labelPlacement: place(50, 0) });
    const f1 = resolveDragEdge(e0, frame({ dragged: ["a", "b"], delta: { dx: 50, dy: 50 }, snapRoutes, snapLabels }));
    const d1 = f1.data as WrappedEdgeData;
    expect(d1.labelPlacement?.center).toEqual({ x: 100, y: 50 });
    expect(d1.autoRoute).toEqual([{ x: 50, y: 50 }, { x: 150, y: 50 }]);

    // Кадр 2: суммарная дельта (100,100). КРИТИЧНО: даже если подать f1 (в его data уже
    // сдвинутая плашка), результат = снимок + 100,100, а НЕ f1 + 100,100. Так ловим регрессию
    // «плашка накапливала дельту каждый кадр и улетала за экран».
    const f2 = resolveDragEdge(f1, frame({ dragged: ["a", "b"], delta: { dx: 100, dy: 100 }, snapRoutes, snapLabels }));
    expect((f2.data as WrappedEdgeData).labelPlacement?.center).toEqual({ x: 150, y: 100 });
  });

  it("гостевое/сквозное ребро с одним тащимым концом ре-роутится живьём (плашка на живой позиции)", () => {
    const liveRoute: EdgePoint[] = [{ x: 0, y: 0 }, { x: 200, y: 0 }];
    // web вне localIds — гость (ребёнок раскрытого контейнера); tgt не тащим
    const e = edge("e1", "seller", "web", { autoRoute: [{ x: 0, y: 0 }, { x: 1, y: 1 }], labelPlacement: place(1, 1) });
    const out = resolveDragEdge(e, frame({
      dragged: ["seller"],
      localIds: new Set(["seller"]),
      liveRoutes: new Map([["e1", liveRoute]]),
      liveLabels: new Map([["e1", place(100, 0)]]),
      liveHandles: new Map([["e1", { sourceHandle: "seller__r__1", targetHandle: "web__l__1" }]]),
    }));
    const d = out.data as WrappedEdgeData;
    expect(d.autoRoute).toBe(liveRoute);
    expect(d.labelPlacement?.center).toEqual({ x: 100, y: 0 });
    expect(out.sourceHandle).toBe("seller__r__1");
    expect(out.targetHandle).toBe("web__l__1");
  });

  it("живое размещение применяется как есть (и leader тоже — контекст полный, совпадает с финалом)", () => {
    const liveLeader = leader(150, 40, 0, -40);
    const out = resolveDragEdge(edge("e1", "a", "b", { labelPlacement: leader(100, 0, 0, -40) }), frame({
      dragged: ["a"],
      deltas: { a: { dx: 40, dy: 20 }, b: { dx: 0, dy: 0 } },
      liveRoutes: new Map([["e1", [{ x: 0, y: 0 }, { x: 200, y: 0 }]]]),
      liveLabels: new Map([["e1", liveLeader]]),
      snapLabels: new Map([["e1", leader(100, 0, 0, -40)]]),
    }));
    expect((out.data as WrappedEdgeData).labelPlacement).toBe(liveLeader);
  });

  it("нет живого размещения → фолбэк: снимок плашки + СРЕДНЕЕ смещение концов ребра", () => {
    // старт: leader-плашка, якорь (100,0), вынос (0,-40) → центр (100,-40)
    const out = resolveDragEdge(edge("e1", "a", "b", { labelPlacement: leader(100, 0, 0, -40) }), frame({
      dragged: ["a"],                          // тащим только a (source)
      deltas: { a: { dx: 40, dy: 20 }, b: { dx: 0, dy: 0 } }, // среднее = (20,10)
      liveRoutes: new Map([["e1", [{ x: 0, y: 0 }, { x: 200, y: 0 }]]]),
      liveLabels: new Map(),                   // размещение не посчиталось
      snapLabels: new Map([["e1", leader(100, 0, 0, -40)]]),
    }));
    const d = out.data as WrappedEdgeData;
    // снимок (центр 100,-40) + среднее смещение (20,10) = (120,-30)
    expect(d.labelPlacement?.mode).toBe("leader");
    expect(d.labelPlacement?.center).toEqual({ x: 120, y: -30 });
    expect(d.labelPlacement?.anchor).toEqual({ x: 120, y: 10 });
  });

  it("гостевое ребро без живого маршрута фолбэком НЕ трогается (тот же объект)", () => {
    const e = edge("e1", "seller", "web", { autoRoute: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
    const out = resolveDragEdge(e, frame({
      dragged: ["seller"],
      localIds: new Set(["seller"]), // web вне localIds
      liveRoutes: new Map(),         // роутер маршрут не дал
      fallbackHandles: new Map([["e1", { sourceHandle: "x", targetHandle: "y" }]]),
    }));
    expect(out).toBe(e);
  });

  it("локальное ребро без живого маршрута: фолбэк меняет сторону хэндла", () => {
    const e = edge("e1", "a", "b");
    const out = resolveDragEdge(e, frame({
      dragged: ["a"],
      localIds: new Set(["a", "b"]),
      liveRoutes: new Map(),
      fallbackHandles: new Map([["e1", { sourceHandle: "a__b__1", targetHandle: "b__t__1" }]]),
    }));
    expect(out.sourceHandle).toBe("a__b__1");
    expect(out.targetHandle).toBe("b__t__1");
  });

  // Фикс 2026-07-22: плашки сползали со стрелок при драге. Корень — интерполяция дельты
  // делает концевые сегменты диагональными, а рендер «ШВОМ V2.2b» выпрямляет их до оси по
  // живым хэндлам; плашка считалась по диагональному маршруту и отставала от нарисованной
  // (выпрямленной) линии у конца. Особенно на ортогональных стрелках с изломами. Фикс:
  // straightenEnds выпрямляет концы как рендер + reprojectOntoRoute кладёт плашку на линию.
  describe("фолбэк 1: плашка не сползает со стрелки (фикс 2026-07-22)", () => {
    it("L-маршрут, драг источника перпендикулярно: конец выпрямляется, online-плашка на линии", () => {
      const route: EdgePoint[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }];
      const out = resolveDragEdge(edge("e1", "a", "b", { autoRoute: route, labelPlacement: place(50, 0) }), frame({
        dragged: ["a"],
        deltas: { a: { dx: 0, dy: 40 }, b: { dx: 0, dy: 0 } },
        snapRoutes: new Map([["e1", route]]),
        snapLabels: new Map([["e1", place(50, 0)]]),
      }));
      const d = out.data as WrappedEdgeData;
      // концевой сегмент выпрямлен до горизонтали y=40 (как шов рендера — он станет no-op)
      expect(d.autoRoute).toEqual([{ x: 0, y: 40 }, { x: 100, y: 40 }, { x: 100, y: 80 }]);
      // плашка легла на выпрямленную линию (y=40), а не на диагональ интерполяции (y≈28.9)
      expect(d.labelPlacement?.center).toEqual({ x: 50, y: 40 });
    });

    it("leader-плашка у конца: якорь на выпрямленной линии, вынос сохранён", () => {
      const route: EdgePoint[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }];
      const out = resolveDragEdge(edge("e1", "a", "b", { autoRoute: route, labelPlacement: leader(50, 0, 0, -30) }), frame({
        dragged: ["a"],
        deltas: { a: { dx: 0, dy: 40 }, b: { dx: 0, dy: 0 } },
        snapRoutes: new Map([["e1", route]]),
        snapLabels: new Map([["e1", leader(50, 0, 0, -30)]]),
      }));
      const lp = (out.data as WrappedEdgeData).labelPlacement!;
      expect(lp.mode).toBe("leader");
      expect(lp.anchor).toEqual({ x: 50, y: 40 }); // якорь на выпрямленной линии
      expect(lp.center).toEqual({ x: 50, y: 10 }); // вынос (0,-30) сохранён
    });

    it("инвариант: опорная точка плашки лежит на маршруте при разных направлениях драга", () => {
      const route: EdgePoint[] = [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 90 }, { x: 240, y: 90 }];
      const dirs = [
        { dx: 0, dy: 50 }, { dx: 0, dy: -50 }, { dx: 60, dy: 0 },
        { dx: 40, dy: 70 }, { dx: -30, dy: 20 }, { dx: 80, dy: -60 },
      ];
      for (const dd of dirs) {
        // online: опорная точка — центр
        const onl = resolveDragEdge(edge("e1", "a", "b", { autoRoute: route, labelPlacement: place(60, 0) }), frame({
          dragged: ["a"], deltas: { a: dd, b: { dx: 0, dy: 0 } },
          snapRoutes: new Map([["e1", route]]), snapLabels: new Map([["e1", place(60, 0)]]),
        }));
        const donl = onl.data as WrappedEdgeData;
        expect(distToRoute(donl.labelPlacement!.center, donl.autoRoute!)).toBeLessThan(1e-6);
        // leader: опорная точка — якорь (центр вынесен и на линии не лежит)
        const led = resolveDragEdge(edge("e1", "a", "b", { autoRoute: route, labelPlacement: leader(60, 0, 0, -25) }), frame({
          dragged: ["a"], deltas: { a: dd, b: { dx: 0, dy: 0 } },
          snapRoutes: new Map([["e1", route]]), snapLabels: new Map([["e1", leader(60, 0, 0, -25)]]),
        }));
        const dled = led.data as WrappedEdgeData;
        expect(distToRoute(dled.labelPlacement!.anchor, dled.autoRoute!)).toBeLessThan(1e-6);
      }
    });

    it("двухточечный маршрут (прямая) не ломается: straightenEnds не применяется (<3 точек)", () => {
      const route: EdgePoint[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
      const out = resolveDragEdge(edge("e1", "a", "b", { autoRoute: route, labelPlacement: place(50, 0) }), frame({
        dragged: ["a"],
        deltas: { a: { dx: 0, dy: 40 }, b: { dx: 0, dy: 0 } },
        snapRoutes: new Map([["e1", route]]),
        snapLabels: new Map([["e1", place(50, 0)]]),
      }));
      const d = out.data as WrappedEdgeData;
      // прямая стала диагональю (интерполяция), плашка — на ней
      expect(distToRoute(d.labelPlacement!.center, d.autoRoute!)).toBeLessThan(1e-6);
    });
  });
});

// Позиции кадра драга для живого роутера: ВСЕГДА абсолют вида. Регрессия бага
// 2026-07-16: у детей compound-рамок position относительна рамке — сырые rel в
// buildAutoRoutes смещали ребро ребёнка к началу координат (на -origin рамки),
// живые маршруты резали чужие тела, плашки размещались по фантомам.
describe("gestureAbsPositions (живой драг детей раскрытых рамок)", () => {
  const node = (id: string, x: number, y: number, parentId?: string): RFNode =>
    ({ id, position: { x, y }, parentId, data: {} }) as unknown as RFNode;

  it("топ-узел: позиция и так абсолютна — не меняется", () => {
    const top = node("a", 300, 400);
    const byId = new Map([["a", top]]);
    const base = new Map([["a", { x: 300, y: 400 }]]);
    const out = gestureAbsPositions(base, [node("a", 350, 420)], byId);
    expect(out.get("a")).toEqual({ x: 350, y: 420 });
  });

  it("ребёнок рамки: rel из RF конвертируется цепочкой родителей в абсолют", () => {
    const frameNode = node("f", 960, 645); // раскрытая рамка контейнера
    const child = node("c", 10, 20, "f");
    const byId = new Map([["f", frameNode], ["c", child]]);
    const base = new Map([["f", { x: 960, y: 645 }], ["c", { x: 970, y: 665 }]]);
    // живой кадр: RF отдал ребёнку rel (30,40) — абсолют обязан быть (990,685)
    const out = gestureAbsPositions(base, [node("c", 30, 40, "f")], byId);
    expect(out.get("c")).toEqual({ x: 990, y: 685 });
    expect(out.get("f")).toEqual({ x: 960, y: 645 }); // не перетаскиваемые — из базы
  });

  it("вложенная рамка: суммируется вся цепочка родителей", () => {
    const outer = node("fo", 100, 200);
    const inner = node("fi", 50, 60, "fo");
    const child = node("c", 5, 10, "fi");
    const byId = new Map([["fo", outer], ["fi", inner], ["c", child]]);
    const base = new Map<string, { x: number; y: number }>();
    const out = gestureAbsPositions(base, [child], byId);
    expect(out.get("c")).toEqual({ x: 155, y: 270 });
  });
});

// Откат живого превью: жест без записи раскладки не запускает пересчёт — рёбра с
// перетаскиваемым концом возвращаются к объектам старта, прочие сохраняют ссылку
// (RF не перерисует). Регрессия бага 2026-07-16: фантомные маршруты последнего
// кадра оставались в rfEdges насовсем.
describe("restoreDragEdges (жест без записи раскладки)", () => {
  it("затронутые рёбра → объект старта, незатронутые → та же ссылка", () => {
    const touched = edge("e1", "drag", "other");
    const untouched = edge("e2", "x", "y");
    const orig = edge("e1", "drag", "other", { autoRoute: [{ x: 0, y: 0 }, { x: 9, y: 9 }] });
    const out = restoreDragEdges([touched, untouched], new Set(["drag"]), new Map([["e1", orig], ["e2", untouched]]));
    expect(out[0]).toBe(orig);      // превью откатилось к снимку старта
    expect(out[1]).toBe(untouched); // идентичность сохранена — без перерисовки
  });

  it("ребро без снимка (появилось позже) остаётся как есть", () => {
    const e = edge("e1", "drag", "b");
    const out = restoreDragEdges([e], new Set(["drag"]), new Map());
    expect(out[0]).toBe(e);
  });
});
