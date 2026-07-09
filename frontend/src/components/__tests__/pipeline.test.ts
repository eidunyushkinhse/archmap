import { describe, it, expect } from "vitest";
import { computeViewLayout, type LayoutResult, type PipelineInput } from "../graph/layout/pipeline";
import type { Node as AppNode, Edge as AppEdge, GhostNode, AncestorRef } from "../../types";

// Характеризация КОМПОЗИЦИИ конвейера раскладки (R1/R3): отдельные стадии покрыты
// своими тестами, здесь — сквозные инварианты целого: детерминизм, засев владения
// интентами (а не записью в БД), конвергенция «второй прогон с засеянными позициями —
// no-op», слияние мастеров, геометрия по ключу пучка, контекст-режим без интентов.

const a = (id: string): AncestorRef => ({ id, name: id, is_external: false });

function appNode(id: string): AppNode {
  return {
    id, name: id, description: null, role: null, technology: null,
    parent_id: "P", shape: "service", is_external: false, status: "existing",
    flowchart: null, openapi_spec: null,
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
    created_at: "2026-07-07T00:00:00Z",
  } as AppEdge;
}

// Базовая сцена уровня (сырьё R2/R3): два локала — дети контейнера P — с владеемыми
// позициями в viewLayout; рёбра с РЕАЛЬНЫМИ концами; в реестре endpoints — внешний
// корневой лист G и H под чужим корнем D (свернётся в контейнер D). Гости требуют засева.
function levelInput(overrides: Partial<PipelineInput> = {}): PipelineInput {
  return {
    nodes: [appNode("A"), appNode("B")],
    endpoints: [ghost("G", []), ghost("H", [a("D")])],
    edges: [edge("eAB", "A", "B", "зов"), edge("eGA", "G", "A"), edge("eHB", "H", "B")],
    containerId: "P",
    viewLayout: { A: { x: 0, y: 0 }, B: { x: 400, y: 0 } },
    ancestorIds: ["P"],
    expanded: new Set(),
    localChildren: {},
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
    groups: l.groupArr.map((g) => ({ id: g.id, n: g.members.length })).sort((p, q) => p.id.localeCompare(q.id)),
  });
}

describe("computeViewLayout — композиция конвейера уровня", () => {
  it("позиции у всех сущностей, маршруты у всех групп, засев гостей — интентами", async () => {
    const out = await computeViewLayout(levelInput());
    // сущности: гость-лист G и контейнер D (H свёрнут в предка)
    expect(out.layout.entities.map((e) => e.id).sort()).toEqual(["D", "G"]);
    for (const id of ["A", "B", "G", "D"]) expect(out.layout.positions.get(id)).toBeTruthy();
    // сохранённые позиции локалов (viewLayout) уважены — не пересчитаны ELK
    expect(out.layout.positions.get("A")).toEqual({ x: 0, y: 0 });
    expect(out.layout.positions.get("B")).toEqual({ x: 400, y: 0 });
    // все три группы рёбер получили авто-маршрут (ручных правок нет)
    expect(out.layout.groupArr.map((g) => g.id).sort()).toEqual(["eAB", "eGA", "eHB"]);
    for (const g of out.layout.groupArr) {
      expect(out.layout.autoRoutes?.get(g.id)?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
    // засев владения пришёл интентом (никаких вызовов персиста из конвейера)
    const seeds = out.intents.filter((i) => i.kind === "seed-positions").flatMap((i) => i.seeds);
    expect(seeds.map((s) => s.id).sort()).toEqual(["D", "G"]);
    // liveInputs согласованы с раскладкой
    expect(out.liveInputs.localIds).toEqual(new Set(["A", "B"]));
    expect(out.liveInputs.layoutEdges.map((e) => e.id).sort()).toEqual(["eAB", "eGA", "eHB"]);
  });

  it("конвергенция: второй прогон с засеянными позициями — без интентов и без сдвигов", async () => {
    const first = await computeViewLayout(levelInput());
    const seeded = Object.fromEntries(
      first.intents
        .filter((i) => i.kind === "seed-positions")
        .flatMap((i) => i.seeds)
        .map((s) => [s.id, { x: s.x, y: s.y }]),
    );
    const second = await computeViewLayout(
      levelInput({ viewLayout: { A: { x: 0, y: 0 }, B: { x: 400, y: 0 }, ...seeded } }),
    );
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
      endpoints: [],
    });
    const out = await computeViewLayout(inp);
    expect(out.layout.groupArr).toHaveLength(1);
    expect(out.layout.groupArr[0].id).toBe("merge:A->B");
    expect(out.layout.groupArr[0].members.map((m) => m.id).sort()).toEqual(["e1", "e2"]);
  });

  it("R5: раскрытый ЛОКАЛ заменяется детьми, рамка в guestFrames, концы поднимаются к детям", async () => {
    // B раскрыт: вместо него — дети B1/B2; ребро A→(внук под B1... сам B1) идёт к B1;
    // ребро от G к B поднимается... G→A остаётся; внутреннее B1→B2 видно.
    const b1 = { ...appNode("B1"), parent_id: "B" } as AppNode;
    const b2 = { ...appNode("B2"), parent_id: "B" } as AppNode;
    const out = await computeViewLayout(levelInput({
      edges: [edge("eAB1", "A", "B1", "к ребёнку"), edge("eB1B2", "B1", "B2", "внутри")],
      endpoints: [
        // реестр не-локальных концов: B1/B2 глубокие внутри поддерева уровня
        { ...ghost("B1", [a("P"), a("B")]), is_external: false },
        { ...ghost("B2", [a("P"), a("B")]), is_external: false },
      ],
      expanded: new Set(["B"]),
      localChildren: { B: [b1, b2] },
    }));
    // B замещён детьми
    expect(out.layout.nodes.map((n) => n.id).sort()).toEqual(["A", "B1", "B2"]);
    // рамка раскрытого локала B — compound с обоими детьми
    const bf = out.layout.guestFrames.find((f) => f.id === "B");
    expect(bf).toBeTruthy();
    expect([...bf!.memberIds].sort()).toEqual(["B1", "B2"]);
    // рёбра: A→B1 (конец-ребёнок локален) и внутреннее B1→B2 видны
    expect(out.layout.groupArr.map((g) => g.id).sort()).toEqual(["eAB1", "eB1B2"]);
    // дети засеяны интентом (own-on-first-render сетки первого показа)
    const seeds = out.intents.filter((i) => i.kind === "seed-positions").flatMap((i) => i.seeds);
    expect(seeds.map((s) => s.id).sort()).toEqual(expect.arrayContaining(["B1", "B2"]));
  });

  it("R5-инвариант: чужой узел не остаётся внутри рамки раскрытого локала", async () => {
    // A владеет позицией ровно там, где раскроется B (сетка детей от позиции B=400,0) —
    // конвейер обязан вытолкнуть A за rect рамки.
    const b1 = { ...appNode("B1"), parent_id: "B" } as AppNode;
    const b2 = { ...appNode("B2"), parent_id: "B" } as AppNode;
    const out = await computeViewLayout(levelInput({
      edges: [edge("eAB1", "A", "B1", "к ребёнку")],
      endpoints: [{ ...ghost("B1", [a("P"), a("B")]), is_external: false }],
      viewLayout: { A: { x: 420, y: 20 }, B: { x: 400, y: 0 } },
      expanded: new Set(["B"]),
      localChildren: { B: [b1, b2] },
    }));
    const bf = out.layout.guestFrames.find((f) => f.id === "B")!;
    const pa = out.layout.positions.get("A")!;
    const overlapsFrame =
      pa.x < bf.rect.x + bf.rect.w && pa.x + 180 > bf.rect.x &&
      pa.y < bf.rect.y + bf.rect.h && pa.y + 70 > bf.rect.y;
    expect(overlapsFrame).toBe(false);
    // члены рамки на местах сетки (рамка пиннится, уступает чужак)
    for (const id of ["B1", "B2"]) {
      const p = out.layout.positions.get(id)!;
      expect(
        p.x >= bf.content.minX - 1 && p.y >= bf.content.minY - 1,
      ).toBe(true);
    }
  });

  it("инвариант наложений: два владеемых узла, сохранённых друг на друге, разведены и персистятся", async () => {
    const out = await computeViewLayout(levelInput({
      edges: [edge("eAB", "A", "B", "зов")],
      endpoints: [],
      viewLayout: { A: { x: 0, y: 0 }, B: { x: 30, y: 10 } }, // наложены в БД
    }));
    const pa = out.layout.positions.get("A")!;
    const pb = out.layout.positions.get("B")!;
    const overlap = pa.x < pb.x + 180 && pa.x + 180 > pb.x && pa.y < pb.y + 70 && pa.y + 70 > pb.y;
    expect(overlap).toBe(false);
    // сдвинутые владеемые персистятся интентом — следующий прогон no-op
    const seeded = out.intents.filter((i) => i.kind === "seed-positions").flatMap((i) => i.seeds);
    expect(seeded.length).toBeGreaterThan(0);
    const seededLayout = Object.fromEntries(seeded.map((s) => [s.id, { x: s.x, y: s.y }]));
    const second = await computeViewLayout(levelInput({
      edges: [edge("eAB", "A", "B", "зов")],
      endpoints: [],
      viewLayout: { A: { x: 0, y: 0 }, B: { x: 30, y: 10 }, ...seededLayout },
    }));
    expect(second.intents).toEqual([]);
  });

  it("R5: дети раскрытого локала не догружены → контейнер остаётся свёрнутым узлом", async () => {
    const out = await computeViewLayout(levelInput({
      edges: [edge("eAB", "A", "B", "зов")],
      endpoints: [],
      expanded: new Set(["B"]),
      localChildren: {}, // фетч ещё в полёте
    }));
    expect(out.layout.nodes.map((n) => n.id).sort()).toEqual(["A", "B"]);
    expect(out.layout.guestFrames).toEqual([]);
  });

  it("контекст-режим: раскладка есть, интентов нет (эфемерная звезда)", async () => {
    const out = await computeViewLayout({
      nodes: [appNode("F")],
      endpoints: [ghost("N", [])],
      edges: [edge("eNF", "N", "F")], // контекст: концы уже спроецированы сервером
      containerId: "P",
      viewLayout: {}, // контекст-схема раскладку не хранит
      ancestorIds: ["P"],
      expanded: new Set(),
      localChildren: {},
      isContext: true,
    });
    expect(out.intents).toEqual([]);
    expect(out.layout.positions.get("F")).toBeTruthy();
    expect(out.layout.positions.get("N")).toBeTruthy();
    // маршруты глобального роутера в контексте не считаются
    expect(out.layout.autoRoutes).toBeUndefined();
  });
});
