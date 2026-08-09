// Тесты планировщиков анимации раскрытия/сворачивания (layoutAnimation.ts).
// Анимация презентационная: планировщики только переставляют первый кадр
// (спавн стопкой / схождение в точку) и решают, что спрятать (рамки, рёбра).
import { describe, it, expect } from "vitest";
import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import {
  planExpand, planCollapse, planRelayout, markDrawIn, clearDrawIn, changedEdgeIds,
  drawSpanMs, ANIM_DRAW_MS, DRAW_CASCADE, DRAW_WAVE_SIZE, DRAW_WAVE_STEP_MS,
} from "../graph/interaction/layoutAnimation";
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
  it("markDrawIn: помеченные показываются (hidden УДАЛЁН) с drawIn, прочие не тронуты", () => {
    const edges = [
      { ...edge("e1", "a", "b"), hidden: true, data: { memberIds: [] } },
      { ...edge("e2", "a", "c"), data: { memberIds: [] } },
    ];
    const out = markDrawIn(edges, new Set(["e1"]));
    // ключ удаляется, а не пишется false: отгоревшее ребро обязано быть
    // структурно равно свежесобранному (реконсиляция Ф2)
    expect("hidden" in out[0]).toBe(false);
    expect(out[0].data?.drawIn).toBe(true);
    expect(out[1]).toBe(edges[1]); // без пометки — та же ссылка
  });

  it("clearDrawIn: снимает флаг (ключ УДАЛЁН) только у рисующихся", () => {
    const edges = [
      { ...edge("e1", "a", "b"), data: { drawIn: true } },
      { ...edge("e2", "a", "c"), data: { memberIds: [] } },
    ];
    const out = clearDrawIn(edges);
    expect(out[0].data && "drawIn" in out[0].data).toBe(false);
    expect(out[1]).toBe(edges[1]);
  });
});

describe("каскад отрисовки (Ф5)", () => {
  // ребро с маршрутом заданной манхэттенской длины
  const routedEdge = (id: string, len: number): RFEdge =>
    ({ id, source: "a", target: "b", data: { autoRoute: [{ x: 0, y: 0 }, { x: len, y: 0 }] } } as RFEdge);

  it("волны по длине маршрута: короткие первыми, шаг DRAW_WAVE_STEP_MS", () => {
    if (!DRAW_CASCADE) return; // флаг откачен — каскадных ожиданий нет
    // WAVE_SIZE+2 рёбер: длинные объявлены первыми — сортировка обязана перегнать
    const n = DRAW_WAVE_SIZE + 2;
    const edges = Array.from({ length: n }, (_, i) => routedEdge(`e${i}`, (n - i) * 100));
    const ids = new Set(edges.map((e) => e.id));
    const out = markDrawIn(edges, ids);
    const delayOf = (id: string) =>
      (out.find((e) => e.id === id)!.data as { drawInDelay?: number }).drawInDelay ?? 0;
    // самые короткие (объявлены последними) — первая волна, задержки нет (ключ не пишется)
    expect(delayOf(`e${n - 1}`)).toBe(0);
    expect(delayOf(`e${n - 2}`)).toBe(0);
    // самые длинные (первые по объявлению) — вторая волна
    expect(delayOf("e0")).toBe(DRAW_WAVE_STEP_MS);
    expect(delayOf("e1")).toBe(DRAW_WAVE_STEP_MS);
    // нулевые задержки не записаны ключом (нормальная форма для реконсиляции)
    const first = out.find((e) => e.id === `e${n - 1}`)!;
    expect(first.data && "drawInDelay" in first.data).toBe(false);
  });

  it("делеи детерминированы (tie-break по id при равных длинах)", () => {
    if (!DRAW_CASCADE) return;
    const edges = Array.from({ length: DRAW_WAVE_SIZE + 1 }, (_, i) => routedEdge(`e${String(i).padStart(2, "0")}`, 100));
    const ids = new Set(edges.map((e) => e.id));
    const a = markDrawIn(edges, ids);
    const b = markDrawIn([...edges].reverse(), ids);
    const sig = (arr: RFEdge[]) =>
      arr.map((e) => `${e.id}:${(e.data as { drawInDelay?: number }).drawInDelay ?? 0}`).sort().join("|");
    expect(sig(a)).toBe(sig(b));
  });

  it("clearDrawIn снимает и drawInDelay", () => {
    const edges = [{ ...edge("e1", "a", "b"), data: { drawIn: true, drawInDelay: 120 } }];
    const out = clearDrawIn(edges);
    expect(out[0].data && "drawInDelay" in out[0].data).toBe(false);
  });

  it("drawSpanMs: одна волна = ANIM_DRAW_MS, дальше + шаг за волну", () => {
    expect(drawSpanMs(0)).toBe(ANIM_DRAW_MS);
    expect(drawSpanMs(1)).toBe(ANIM_DRAW_MS);
    expect(drawSpanMs(DRAW_WAVE_SIZE)).toBe(ANIM_DRAW_MS);
    if (DRAW_CASCADE) {
      expect(drawSpanMs(DRAW_WAVE_SIZE + 1)).toBe(ANIM_DRAW_MS + DRAW_WAVE_STEP_MS);
      expect(drawSpanMs(DRAW_WAVE_SIZE * 3)).toBe(ANIM_DRAW_MS + 2 * DRAW_WAVE_STEP_MS);
    }
  });
});

describe("changedEdgeIds (дифф геометрии рёбер для перерисовки после жеста)", () => {
  const nodes = [node("a", "block", 0, 0), node("b", "block", 400, 0), node("c", "block", 0, 300)];

  it("сдвиг конца, смена хэндла, маршрута и центра плашки — изменение; прочее — нет", () => {
    const prevEdges = [
      { ...edge("e1", "a", "b"), sourceHandle: "a--right--1", targetHandle: "b--left--1" },
      { ...edge("e2", "a", "c"), data: { autoRoute: [{ x: 0, y: 0 }, { x: 0, y: 300 }] } },
      { ...edge("e3", "b", "c"), data: { labelPlacement: { center: { x: 200, y: 150 } } } },
      { ...edge("e4", "a", "b") }, // без геометрии — стабильное
    ];
    // b сдвинут → e1 (конец) изменилось; у e2 новый маршрут; у e3 новая плашка
    const nextNodes = [nodes[0], node("b", "block", 500, 0), nodes[2]];
    const nextEdges = [
      { ...edge("e1", "a", "b"), sourceHandle: "a--right--1", targetHandle: "b--left--1" },
      { ...edge("e2", "a", "c"), data: { autoRoute: [{ x: 0, y: 0 }, { x: 40, y: 300 }] } },
      { ...edge("e3", "b", "c"), data: { labelPlacement: { center: { x: 260, y: 150 } } } },
      { ...edge("e4", "a", "b") },
    ];
    const changed = changedEdgeIds(nodes, prevEdges, nextNodes, nextEdges);
    expect(changed).toEqual(new Set(["e1", "e2", "e3", "e4"])); // e4 тоже: конец b сдвинут
  });

  it("идентичные снимки и микро-дрейф < 0.5px — не изменение", () => {
    const prevEdges = [{ ...edge("e1", "a", "b"), data: { autoRoute: [{ x: 0, y: 0 }, { x: 400, y: 0 }] } }];
    const nextNodes = [node("a", "block", 0.1, 0), nodes[1], nodes[2]];
    const nextEdges = [{ ...edge("e1", "a", "b"), data: { autoRoute: [{ x: 0.1, y: 0 }, { x: 400, y: 0 }] } }];
    expect(changedEdgeIds(nodes, prevEdges, nextNodes, nextEdges).size).toBe(0);
  });

  it("новые и скрытые рёбра не входят; смена хэндла входит", () => {
    const prevEdges = [{ ...edge("e1", "a", "b"), sourceHandle: "a--right--1" }];
    const nextEdges = [
      { ...edge("e1", "a", "b"), sourceHandle: "a--bottom--1" }, // хэндл сменился
      { ...edge("eNew", "a", "c") },                             // новое — монтаж, не перекладка
      { ...edge("eHid", "a", "c"), hidden: true },
    ];
    expect(changedEdgeIds(nodes, prevEdges, nodes, nextEdges)).toEqual(new Set(["e1"]));
  });

  it("ребёнок compound-рамки сравнивается по АБСОЛЮТУ: сдвиг rel при том же месте — не изменение", () => {
    const prev = [node("F", "frame", 100, 100), node("k", "block", 20, 20, { parentId: "F" }), nodes[1]];
    // рамка уехала, rel скомпенсирован — абсолют ребёнка тот же
    const next = [node("F", "frame", 60, 100), node("k", "block", 60, 20, { parentId: "F" }), nodes[1]];
    const prevEdges = [{ ...edge("e1", "k", "b") }];
    expect(changedEdgeIds(prev, prevEdges, next, prevEdges).size).toBe(0);
  });
});

describe("planRelayout («Переразложить» без сворачивания раскрытий)", () => {
  // Состав до и после идентичен (раскрытия переживают сброс) — меняется только
  // раскладка: узлы и рамка едут, стрелки прячутся на переезд.
  const prev = [
    node("F", "frame", 100, 100, { w: 400, h: 300 }),
    node("k1", "block", 20, 20, { parentId: "F" }),
    node("k2", "block", 220, 160, { parentId: "F" }),
    node("S", "block", 700, 100),
  ];
  const next = [
    node("F", "frame", 300, 200, { w: 420, h: 310 }),
    node("k1", "block", 30, 30, { parentId: "F" }),
    node("k2", "block", 240, 170, { parentId: "F" }),
    node("S", "block", 900, 150),
  ];
  const prevEdges = [edge("e1", "k1", "S"), edge("e2", "k1", "k2")];

  it("состав не меняется, узлы едут — спрятаны все стрелки с изменившейся геометрией", () => {
    const plan = planRelayout(prev, prevEdges, next, prevEdges)!;
    expect(plan).not.toBeNull();
    expect(plan.hiddenEdgeIds).toEqual(new Set(["e1", "e2"]));
  });

  it("ничего реально не сдвинулось (повторная переразкладка) — режиссуры нет", () => {
    expect(planRelayout(prev, prevEdges, prev, prevEdges)).toBeNull();
  });

  it("первый рендер (prev пуст) — режиссуры нет", () => {
    expect(planRelayout([], prevEdges, next, prevEdges)).toBeNull();
  });

  it("состав изменился (параллельная структурная правка) — режиссуры нет", () => {
    const nextPlus = [...next, node("N", "block", 0, 0)];
    expect(planRelayout(prev, prevEdges, nextPlus, prevEdges)).toBeNull();
    const nextMinus = next.slice(0, 3);
    expect(planRelayout(prev, prevEdges, nextMinus, prevEdges)).toBeNull();
  });

  it("новое ребро (появилось в свежей раскладке) тоже прячется на переезд", () => {
    const nextEdges = [...prevEdges, edge("eNew", "k2", "S")];
    const plan = planRelayout(prev, prevEdges, next, nextEdges)!;
    expect(plan.hiddenEdgeIds).toEqual(new Set(["e1", "e2", "eNew"]));
  });
});
