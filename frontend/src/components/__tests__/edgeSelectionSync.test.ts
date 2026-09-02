import { describe, expect, it } from "vitest";
import type { Edge as RFEdge } from "@xyflow/react";
import { selectCarrierEdge } from "../graph/interaction/useLevelSelection";

// Перенос RF-выделения на несущее ребро выбранной связи (CV32-исключение следует
// за выбором из панели/модалки; находка приёмки 2026-09-02).
const edge = (id: string, opts: { memberIds?: string[]; selected?: boolean } = {}): RFEdge =>
  ({ id, source: "a", target: "b", selected: opts.selected,
     data: opts.memberIds ? { memberIds: opts.memberIds } : {} }) as unknown as RFEdge;

describe("selectCarrierEdge — перенос RF-выделения на несущее ребро", () => {
  it("выбранный член пучка резолвится в мастера; прежнее выделение снимается", () => {
    const edges = [edge("m1", { selected: true }), edge("master", { memberIds: ["e1", "e2"] })];
    const next = selectCarrierEdge(edges, "e2");
    expect(next).not.toBeNull();
    expect(next!.map((e) => [e.id, !!e.selected])).toEqual([["m1", false], ["master", true]]);
  });

  it("одиночное ребро выбирается по своему id", () => {
    const edges = [edge("x"), edge("y")];
    const next = selectCarrierEdge(edges, "y");
    expect(next!.find((e) => e.id === "y")!.selected).toBe(true);
    // «x» и так был невыделен (selected: undefined) — объект сохраняется как есть
    expect(next!.find((e) => e.id === "x")!.selected).toBeFalsy();
  });

  it("нечего менять (выделение уже ровно такое) → null, массив не пересобирается", () => {
    const edges = [edge("x"), edge("master", { memberIds: ["e1"], selected: true })];
    expect(selectCarrierEdge(edges, "e1")).toBeNull();
  });

  it("связь не отрисована (нет ни id, ни членства) → null", () => {
    expect(selectCarrierEdge([edge("x")], "ghost")).toBeNull();
  });

  it("нетронутые объекты сохраняют идентичность (реконсиляция/memo)", () => {
    const untouched = edge("x", { selected: false });
    const next = selectCarrierEdge([untouched, edge("y")], "y")!;
    expect(next[0]).toBe(untouched);
  });
});
