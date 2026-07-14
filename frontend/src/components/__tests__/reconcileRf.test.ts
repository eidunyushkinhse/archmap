// Реконсиляция сборки RF (Ф2 плавности): неизменённые объекты сохраняют identity
// (memo-бейлаут), любое содержательное изменение — включая ИСЧЕЗНОВЕНИЕ поля —
// отдаёт свежий объект (класс риска «залипший рендер»).
import { describe, it, expect } from "vitest";
import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import { reconcileNodes, reconcileEdges } from "../graph/reconcileRf";

const node = (over: Partial<RFNode> = {}): RFNode => ({
  id: "n1",
  type: "block",
  position: { x: 10, y: 20 },
  data: {
    appNode: { id: "n1", name: "A", status: "existing" },
    colors: { bg: "#fff", border: "#000" },
    onDrillDown: () => {},
  },
  ...over,
});

const edge = (over: Partial<RFEdge> = {}): RFEdge => ({
  id: "e1",
  source: "n1",
  target: "n2",
  sourceHandle: "r-1",
  targetHandle: "l-1",
  type: "wrapped",
  data: {
    memberIds: ["e1"],
    autoRoute: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
    onOpenDetails: () => {},
  },
  style: { stroke: "#64748b", strokeWidth: 1.5 },
  ...over,
});

describe("reconcileRf", () => {
  it("идентичное содержимое → прошлые объекты и ПРОШЛЫЙ массив", () => {
    const prev = [node()];
    const next = [node()]; // другие ссылки, то же содержимое (и другие функции)
    const out = reconcileNodes(prev, next);
    expect(out).toBe(prev);
  });

  it("RF-приватные поля прошлого (selected/measured/dragging) не считаются различием", () => {
    const prev = [{ ...node(), selected: true, dragging: false, measured: { width: 180, height: 72 } }];
    const out = reconcileNodes(prev, [node()]);
    expect(out).toBe(prev); // старый объект сохранён — выделение переживает пересчёт
  });

  it("изменение значения поля отдаёт свежий объект", () => {
    const prev = [node()];
    const out = reconcileNodes(prev, [node({ position: { x: 11, y: 20 } })]);
    expect(out).not.toBe(prev);
    expect(out[0]).not.toBe(prev[0]);
  });

  it("изменение глубокого поля data отдаёт свежий объект", () => {
    const prev = [node()];
    const fresh = node();
    (fresh.data as { appNode: { name: string } }).appNode.name = "B";
    const out = reconcileNodes(prev, [fresh]);
    expect(out[0]).toBe(fresh);
  });

  it("ИСЧЕЗНОВЕНИЕ поля — тоже изменение (style приглушения, parentId, hidden)", () => {
    const dimmed = [node({ style: { opacity: 0.12 } })];
    const undimmed = reconcileNodes(dimmed, [node()]);
    expect(undimmed[0]).not.toBe(dimmed[0]);

    const framed = [node({ parentId: "f1" } as Partial<RFNode>)];
    const unframed = reconcileNodes(framed, [node()]);
    expect(unframed[0]).not.toBe(framed[0]);

    const hidden = [edge({ hidden: true })];
    const shown = reconcileEdges(hidden, [edge()]);
    expect(shown[0]).not.toBe(hidden[0]);
  });

  it("появление поля — изменение (drawIn поверх data)", () => {
    const prev = [edge()];
    const fresh = edge();
    (fresh.data as Record<string, unknown>).drawIn = true;
    const out = reconcileEdges(prev, [fresh]);
    expect(out[0]).toBe(fresh);
  });

  it("смена состава и порядка отражается в свежем массиве", () => {
    const a = node({ id: "a" });
    const b = node({ id: "b" });
    const prev = [a, b];
    // тот же состав, другой порядок: объекты переиспользованы, массив новый
    const out = reconcileNodes(prev, [node({ id: "b" }), node({ id: "a" })]);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(b);
    expect(out[1]).toBe(a);
    // удаление элемента
    const shorter = reconcileNodes(prev, [node({ id: "a" })]);
    expect(shorter).not.toBe(prev);
    expect(shorter).toHaveLength(1);
    expect(shorter[0]).toBe(a);
  });

  it("частичное изменение: только задетые объекты свежие", () => {
    const prev = [node({ id: "a" }), node({ id: "b" })];
    const freshB = node({ id: "b", position: { x: 99, y: 0 } });
    const out = reconcileNodes(prev, [node({ id: "a" }), freshB]);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(freshB);
  });

  it("маркер-объекты рёбер сравниваются по значению", () => {
    const prev = [edge({ markerEnd: { type: "arrowclosed", color: "#64748b" } } as unknown as Partial<RFEdge>)];
    const same = reconcileEdges(prev, [edge({ markerEnd: { type: "arrowclosed", color: "#64748b" } } as unknown as Partial<RFEdge>)]);
    expect(same).toBe(prev);
    const changed = reconcileEdges(prev, [edge({ markerEnd: { type: "arrowclosed", color: "#dc2626" } } as unknown as Partial<RFEdge>)]);
    expect(changed[0]).not.toBe(prev[0]);
  });
});
