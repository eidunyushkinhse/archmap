import { describe, it, expect } from "vitest";
import { computeViewLayout, type LayoutResult, type PipelineInput } from "../graph/layout/pipeline";
import type { Node as AppNode, Edge as AppEdge, GhostNode, AncestorRef } from "../../types";

// Характеризация КОМПОЗИЦИИ конвейера раскладки (R1): отдельные стадии покрыты своими
// тестами, здесь — сквозные инварианты целого: детерминизм, засев владения интентами
// (а не записью в БД), конвергенция «второй прогон с засеянными позициями — no-op»,
// слияние мастеров, контекст-режим без интентов.

const a = (id: string): AncestorRef => ({ id, name: id, is_external: false });

function appNode(id: string, pos?: { x: number; y: number }): AppNode {
  return {
    id, name: id, description: null, role: null, technology: null,
    parent_id: "P", shape: "service", is_external: false, status: "existing",
    flowchart: null, openapi_spec: null,
    pos_x: pos?.x ?? null, pos_y: pos?.y ?? null,
    created_at: "", updated_at: "", has_children: false, child_count: 0,
  } as AppNode;
}

function ghost(id: string, ancestors: AncestorRef[]): GhostNode {
  return {
    id, name: id, role: null, technology: null, is_external: true,
    shape: "service", status: "existing", node_depth: ancestors.length,
    has_children: false, child_count: 0, ancestors, is_ghost: true,
  } as GhostNode;
}

function edge(id: string, source_id: string, target_id: string, label: string | null = null): AppEdge {
  return {
    id, label, technology: null, source_id, target_id,
    source_handle: null, target_handle: null, created_at: "2026-07-07T00:00:00Z",
  } as AppEdge;
}

// Базовая сцена уровня: два владеемых локала, гость-лист (без предков) и гость,
// свёрнутый в контейнер D (предок вне breadcrumb) — оба требуют засева.
function levelInput(overrides: Partial<PipelineInput> = {}): PipelineInput {
  return {
    nodes: [appNode("A", { x: 0, y: 0 }), appNode("B", { x: 400, y: 0 })],
    ghostNodes: [ghost("G", []), ghost("H", [a("D")])],
    edges: [edge("eAB", "A", "B", "зов"), edge("eGA", "G", "A"), edge("eHB", "H", "B")],
    levelPositions: {},
    levelEdgeHandles: {},
    levelEdgeWaypoints: {},
    ancestorIds: ["P"],
    expanded: new Set(),
    isContext: false,
    ...overrides,
  };
}

// Стабильная сериализация раскладки (Map → отсортированные пары) для сравнения прогонов.
function sig(l: LayoutResult): string {
  const m = (x?: Map<string, unknown>) => (x ? [...x.entries()].sort((p, q) => p[0].localeCompare(q[0])) : null);
  return JSON.stringify({
    pos: m(l.positions),
    handles: m(l.edgeHandles),
    routes: m(l.autoRoutes),
    labels: m(l.labelPlacements),
    wp: l.levelWaypoints,
    groups: l.groupArr.map((g) => ({ id: g.id, n: g.members.length })).sort((p, q) => p.id.localeCompare(q.id)),
  });
}

describe("computeViewLayout — композиция конвейера уровня", () => {
  it("позиции у всех сущностей, маршруты у всех групп, засев гостей — интентами", async () => {
    const out = await computeViewLayout(levelInput());
    // сущности: гость-лист G и контейнер D (H свёрнут в предка)
    expect(out.layout.entities.map((e) => e.id).sort()).toEqual(["D", "G"]);
    for (const id of ["A", "B", "G", "D"]) expect(out.layout.positions.get(id)).toBeTruthy();
    // сохранённые позиции локалов уважены (не пересчитаны ELK)
    expect(out.layout.positions.get("A")).toEqual({ x: 0, y: 0 });
    expect(out.layout.positions.get("B")).toEqual({ x: 400, y: 0 });
    // все три группы рёбер получили авто-маршрут (ручных правок нет)
    expect(out.layout.groupArr.map((g) => g.id).sort()).toEqual(["eAB", "eGA", "eHB"]);
    for (const g of out.layout.groupArr) {
      expect(out.layout.autoRoutes?.get(g.id)?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
    // засев владения пришёл интентом (никаких вызовов персиста из конвейера)
    const seeds = out.intents.filter((i) => i.kind === "seed-ghost-positions").flatMap((i) => i.seeds);
    expect(seeds.map((s) => `${s.id}:${s.entityKind}`).sort()).toEqual(["D:container", "G:ghost"]);
    // liveInputs согласованы с раскладкой
    expect(out.liveInputs.localIds).toEqual(new Set(["A", "B"]));
    expect(out.liveInputs.layoutEdges.map((e) => e.id).sort()).toEqual(["eAB", "eGA", "eHB"]);
  });

  it("конвергенция: второй прогон с засеянными позициями — без интентов и без сдвигов", async () => {
    const first = await computeViewLayout(levelInput());
    const seeded = Object.fromEntries(
      first.intents
        .filter((i) => i.kind === "seed-ghost-positions")
        .flatMap((i) => i.seeds)
        .map((s) => [s.id, { pos_x: s.pos_x, pos_y: s.pos_y }]),
    );
    const second = await computeViewLayout(levelInput({ levelPositions: seeded }));
    expect(second.intents).toEqual([]);
    expect(sig(second.layout)).toBe(sig(first.layout));
  });

  it("детерминизм: два одинаковых прогона дают идентичную раскладку", async () => {
    const [r1, r2] = await Promise.all([computeViewLayout(levelInput()), computeViewLayout(levelInput())]);
    expect(sig(r1.layout)).toBe(sig(r2.layout));
  });

  it("две связи одного направления сливаются в мастер-группу merge:", async () => {
    const inp = levelInput({
      edges: [edge("e1", "A", "B", "раз"), edge("e2", "A", "B", "два")],
      ghostNodes: [],
    });
    const out = await computeViewLayout(inp);
    expect(out.layout.groupArr).toHaveLength(1);
    expect(out.layout.groupArr[0].id).toBe("merge:A->B");
    expect(out.layout.groupArr[0].members.map((m) => m.id).sort()).toEqual(["e1", "e2"]);
  });

  it("контекст-режим: раскладка есть, интентов нет (эфемерная звезда)", async () => {
    const out = await computeViewLayout({
      nodes: [appNode("F", { x: 999, y: 999 })], // savedPos в контексте игнорируется
      ghostNodes: [ghost("N", [])],
      edges: [edge("eNF", "N", "F")],
      levelPositions: {},
      levelEdgeHandles: {},
      levelEdgeWaypoints: {},
      ancestorIds: ["P"],
      expanded: new Set(),
      isContext: true,
    });
    expect(out.intents).toEqual([]);
    expect(out.layout.positions.get("F")).toBeTruthy();
    expect(out.layout.positions.get("N")).toBeTruthy();
    // контекст игнорирует сохранённые координаты — фокус в предписанном центре звезды
    expect(out.layout.positions.get("F")).not.toEqual({ x: 999, y: 999 });
    // маршруты глобального роутера в контексте не считаются
    expect(out.layout.autoRoutes).toBeUndefined();
  });
});
