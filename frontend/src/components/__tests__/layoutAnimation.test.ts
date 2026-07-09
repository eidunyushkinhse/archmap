// Тесты планировщиков анимации раскрытия/сворачивания (layoutAnimation.ts).
// Анимация презентационная: планировщики только переставляют первый кадр
// (спавн стопкой / схождение в точку) и решают, что спрятать (рамки, рёбра).
import { describe, it, expect } from "vitest";
import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import { planExpand, planCollapse, markDrawIn, clearDrawIn } from "../graph/interaction/layoutAnimation";
import { NODE_W, NODE_H } from "../graph/constants";

// Мини-фабрики RF-объектов: только поля, которые читают планировщики.
const node = (
  id: string, type: string, x: number, y: number,
  opts: { parentId?: string; w?: number; h?: number } = {},
): RFNode => ({
  id, type, position: { x, y }, data: {},
  ...(opts.parentId ? { parentId: opts.parentId } : null),
  ...(opts.w != null ? { width: opts.w } : null),
  ...(opts.h != null ? { height: opts.h } : null),
} as RFNode);

const edge = (id: string, source: string, target: string): RFEdge =>
  ({ id, source, target } as RFEdge);

const posOf = (nodes: RFNode[], id: string) => nodes.find((n) => n.id === id)!.position;
const styleOf = (nodes: RFNode[], id: string) => nodes.find((n) => n.id === id)!.style;

describe("planExpand", () => {
  // prev: свёрнутый блок X + статичный сосед; next: рамка X с детьми
  const prev = [
    node("X", "block", 500, 500),
    node("S", "block", 0, 0),
    node("N", "block", 900, 100),
  ];
  const prevEdges = [edge("eSN", "S", "N")];
  const next = [
    node("X", "frame", 60, 60, { w: 400, h: 300 }),
    node("c1", "block", 40, 40, { parentId: "X" }),
    node("c2", "block", 240, 160, { parentId: "X" }),
    node("S", "block", 0, 0),
    node("N", "block", 1000, 100), // сосед сдвинут раскрытием
  ];
  const nextEdges = [
    edge("eSN", "S", "N"),      // конец N движется — прятать
    edge("eSc1", "S", "c1"),    // конец c1 новый — прятать
  ];

  it("дети спавнятся стопкой в центре свёрнутого узла, финал — в плане", () => {
    const plan = planExpand(prev, prevEdges, next, nextEdges, "X")!;
    expect(plan).not.toBeNull();
    // центр X: (500 + NODE_W/2, 500 + NODE_H/2); rel — минус позиция рамки (60,60)
    const cx = 500 + NODE_W / 2, cy = 500 + NODE_H / 2;
    expect(posOf(plan.initialNodes, "c1")).toEqual({ x: cx - NODE_W / 2 - 60, y: cy - NODE_H / 2 - 60 });
    expect(posOf(plan.initialNodes, "c2")).toEqual(posOf(plan.initialNodes, "c1")); // стопка
    expect(plan.finalPositions.get("c1")).toEqual({ x: 40, y: 40 });
    expect(plan.finalPositions.get("c2")).toEqual({ x: 240, y: 160 });
  });

  it("рамка скрыта на разъезд; сосед и статичный узел — сразу на финальных местах", () => {
    const plan = planExpand(prev, prevEdges, next, nextEdges, "X")!;
    expect(plan.hiddenFrameIds.has("X")).toBe(true);
    expect(styleOf(plan.initialNodes, "X")).toMatchObject({ opacity: 0 });
    expect(posOf(plan.initialNodes, "N")).toEqual({ x: 1000, y: 100 }); // CSS довезёт
    expect(posOf(plan.initialNodes, "S")).toEqual({ x: 0, y: 0 });
  });

  it("прячутся рёбра с новым/движущимся концом; статичные — нет", () => {
    const nextE = [...nextEdges, edge("eXtra", "S", "S")]; // статичное — не прятать
    const plan = planExpand(prev, prevEdges, next, nextE, "X")!;
    expect(plan.hiddenEdgeIds.has("eSc1")).toBe(true); // новый конец
    expect(plan.hiddenEdgeIds.has("eSN")).toBe(true);  // движущийся конец
    expect(plan.hiddenEdgeIds.has("eXtra")).toBe(true); // НОВЫЙ пучок (нет в prev)
    const planStable = planExpand(prev, [...prevEdges, edge("eXtra", "S", "S")], next, nextE, "X")!;
    expect(planStable.hiddenEdgeIds.has("eXtra")).toBe(false); // старый статичный
  });

  it("вложенная рамка: rel спавна считается через цепочку родителей", () => {
    const nested = [
      node("F", "frame", 100, 100, { w: 800, h: 600 }),
      node("X", "frame", 60, 60, { parentId: "F", w: 400, h: 300 }),
      node("c1", "block", 40, 40, { parentId: "X" }),
    ];
    const prevN = [node("F", "frame", 100, 100, { w: 300, h: 200 }), node("X", "block", 160, 160, { parentId: "F" })];
    const plan = planExpand(prevN, [], nested, [], "X")!;
    // абсолютный центр X в prev: (100+160 + W/2, 100+160 + H/2); chain c1 = F+X = (160,160)
    const cx = 260 + NODE_W / 2, cy = 260 + NODE_H / 2;
    expect(posOf(plan.initialNodes, "c1")).toEqual({ x: cx - NODE_W / 2 - 160, y: cy - NODE_H / 2 - 160 });
  });

  it("рамки в next ещё нет (дети локала грузятся) → null, интент ждёт", () => {
    const notReady = [node("X", "block", 500, 500), node("S", "block", 0, 0)];
    expect(planExpand(prev, prevEdges, notReady, [], "X")).toBeNull();
  });
});

describe("planCollapse", () => {
  // prev: рамка X с детьми и вложенной рамкой Y; next: свёрнутый блок X
  const prev = [
    node("X", "frame", 60, 60, { w: 400, h: 300 }),
    node("c1", "block", 40, 40, { parentId: "X" }),
    node("Y", "frame", 200, 100, { parentId: "X", w: 150, h: 150 }),
    node("c3", "block", 20, 30, { parentId: "Y" }),
    node("N", "block", 900, 100),
    node("S", "block", 0, 0),
  ];
  const prevEdges = [
    edge("eSc1", "S", "c1"), // конец в поддереве — прятать
    edge("eSN", "S", "N"),   // конец движется — прятать
    edge("eSS", "S", "S"),   // статичное — не прятать
  ];
  const next = [
    node("X", "block", 200, 200),
    node("N", "block", 800, 100), // сосед возвращается/съезжает
    node("S", "block", 0, 0),
  ];

  it("потомки (в т.ч. глубокие) съезжаются в центр будущего узла", () => {
    const plan = planCollapse(prev, prevEdges, next, "X")!;
    expect(plan).not.toBeNull();
    const cx = 200 + NODE_W / 2, cy = 200 + NODE_H / 2; // центр X из next
    // c1: chain = X(60,60)
    expect(posOf(plan.phase1Nodes, "c1")).toEqual({ x: cx - NODE_W / 2 - 60, y: cy - NODE_H / 2 - 60 });
    // c3: chain = X + Y = (260,160)
    expect(posOf(plan.phase1Nodes, "c3")).toEqual({ x: cx - NODE_W / 2 - 260, y: cy - NODE_H / 2 - 160 });
  });

  it("рамки поддерева гаснут, соседи параллельно едут на next-позиции", () => {
    const plan = planCollapse(prev, prevEdges, next, "X")!;
    expect(styleOf(plan.phase1Nodes, "X")).toMatchObject({ opacity: 0 });
    expect(styleOf(plan.phase1Nodes, "Y")).toMatchObject({ opacity: 0 });
    expect(posOf(plan.phase1Nodes, "N")).toEqual({ x: 800, y: 100 });
    expect(posOf(plan.phase1Nodes, "S")).toEqual({ x: 0, y: 0 });
  });

  it("прячутся рёбра поддерева и движущихся соседей; статичные — нет", () => {
    const plan = planCollapse(prev, prevEdges, next, "X")!;
    expect(plan.hiddenEdgeIds.has("eSc1")).toBe(true);
    expect(plan.hiddenEdgeIds.has("eSN")).toBe(true);
    expect(plan.hiddenEdgeIds.has("eSS")).toBe(false);
  });

  it("снимки не в той фазе (рамки уже нет / узла ещё нет) → null", () => {
    expect(planCollapse(next, [], next, "X")).toBeNull(); // prev без рамки
    const nextNoX = [node("N", "block", 800, 100)];
    expect(planCollapse(prev, prevEdges, nextNoX, "X")).toBeNull(); // next без узла
  });
});

describe("drawIn (анимированная отрисовка стрелок)", () => {
  it("markDrawIn: помеченные показываются с drawIn, прочие не тронуты", () => {
    const edges = [
      { ...edge("e1", "a", "b"), hidden: true, data: { memberIds: [] } },
      { ...edge("e2", "a", "c"), data: { memberIds: [] } },
    ];
    const out = markDrawIn(edges, new Set(["e1"]));
    expect(out[0].hidden).toBe(false);
    expect(out[0].data?.drawIn).toBe(true);
    expect(out[1]).toBe(edges[1]); // без пометки — та же ссылка
  });

  it("clearDrawIn: снимает флаг только у рисующихся", () => {
    const edges = [
      { ...edge("e1", "a", "b"), data: { drawIn: true } },
      { ...edge("e2", "a", "c"), data: { memberIds: [] } },
    ];
    const out = clearDrawIn(edges);
    expect(out[0].data?.drawIn).toBe(false);
    expect(out[1]).toBe(edges[1]);
  });
});
