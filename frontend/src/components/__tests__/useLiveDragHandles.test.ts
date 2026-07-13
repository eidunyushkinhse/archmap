import { describe, it, expect } from "vitest";
import type { Edge as RFEdge } from "@xyflow/react";
import { resolveDragEdge } from "../graph/interaction/useLiveDragHandles";
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
});
