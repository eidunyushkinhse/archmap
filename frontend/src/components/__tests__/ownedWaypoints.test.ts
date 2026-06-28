import { describe, it, expect } from "vitest";
import { reconstructOwnedWaypoints } from "../graph/layout/ownedWaypoints";
import type { Edge as AppEdge, LevelWaypoints } from "../../types";

// Реконструкция изломов гостевых стрелок к детям раскрытых рамок (ТЗ D8, рев. B).
// Базис — СОБСТВЕННАЯ позиция гостевого конца: абсолют = офсет_излома + позиция_конца.
// Привязка не зависит от владения узлом — только от того, что конец на экране и его предок
// раскрыт (expandedChildIds).

const edge = (id: string, source_id: string, target_id: string): AppEdge => ({
  id, label: null, technology: null, source_id, target_id,
  source_handle: null, target_handle: null, created_at: "2026-06-16T00:00:00Z",
});
const wp = (waypoints: { x: number; y: number }[], anchor_rel: boolean): LevelWaypoints => ({ waypoints, anchor_rel });

describe("reconstructOwnedWaypoints (D8 рев. B)", () => {
  // g1 — гостевой ребёнок раскрытой рамки на позиции (200,100); излом привязан к ней.
  const base = {
    edges: [edge("e1", "g1", "La")],
    pos: (id: string) => (id === "g1" ? { x: 200, y: 100 } : id === "La" ? { x: 0, y: 0 } : undefined),
    expandedChildIds: new Set(["g1"]),
  };

  it("офсетный путь → абсолют = офсет + позиция гостевого конца", () => {
    const { effective, migrations } = reconstructOwnedWaypoints({
      ...base, levelEdgeWaypoints: { e1: wp([{ x: 10, y: 20 }], true) },
    });
    // позиция g1 = (200,100); абсолют = (210,120)
    expect(effective.e1).toEqual([{ x: 210, y: 120 }]);
    expect(migrations.length).toBe(0);
  });

  it("излом едет ровно с ребёнком: сдвиг позиции на (+60,+5) сдвигает излом так же", () => {
    const a = reconstructOwnedWaypoints({ ...base, levelEdgeWaypoints: { e1: wp([{ x: 10, y: 20 }], true) } });
    const moved = reconstructOwnedWaypoints({
      edges: base.edges, expandedChildIds: base.expandedChildIds,
      pos: (id) => (id === "g1" ? { x: 260, y: 105 } : id === "La" ? { x: 0, y: 0 } : undefined),
      levelEdgeWaypoints: { e1: wp([{ x: 10, y: 20 }], true) },
    });
    expect(moved.effective.e1[0].x - a.effective.e1[0].x).toBeCloseTo(60);
    expect(moved.effective.e1[0].y - a.effective.e1[0].y).toBeCloseTo(5);
  });

  it("свежий/легаси абсолют к ребёнку раскрытой рамки → миграция в офсет, на экране без сдвига", () => {
    const { effective, migrations } = reconstructOwnedWaypoints({
      ...base, levelEdgeWaypoints: { e1: wp([{ x: 210, y: 120 }], false) },
    });
    // абсолют на экране не двигаем (это и чинит баг «по отпусканию встаёт назад»)
    expect(effective.e1).toEqual([{ x: 210, y: 120 }]);
    // офсет = абсолют − позиция g1 = (210−200, 120−100) = (10,20)
    expect(migrations).toEqual([{ edge_id: "e1", waypoints: [{ x: 10, y: 20 }] }]);
  });

  it("работает для АВТО-ребёнка (нет ghost_position) — привязка не зависит от владения", () => {
    // g1 в expandedChildIds, но никакой levelPositions не передаём вообще — раньше так
    // излом не сохранялся; теперь привязка идёт к позиции, а не к владению.
    const { effective, migrations } = reconstructOwnedWaypoints({
      ...base, levelEdgeWaypoints: { e1: wp([{ x: 300, y: 90 }], false) },
    });
    expect(effective.e1).toEqual([{ x: 300, y: 90 }]);
    expect(migrations).toEqual([{ edge_id: "e1", waypoints: [{ x: 100, y: -10 }] }]); // (300−200, 90−100)
  });

  it("офсетный путь, но гостевой конец не на экране (свёрнуто) → авто-маршрут (пусто)", () => {
    const { effective, migrations } = reconstructOwnedWaypoints({
      edges: [edge("e1", "g1", "La")],
      expandedChildIds: new Set<string>(), // g1 не среди потомков раскрытых рамок
      pos: () => ({ x: 0, y: 0 }),
      levelEdgeWaypoints: { e1: wp([{ x: 10, y: 20 }], true) },
    });
    expect(effective.e1).toEqual([]);
    expect(migrations.length).toBe(0);
  });

  it("обычная гостевая стрелка (конец не в раскрытой рамке) → абсолютный путь как пришёл", () => {
    const { effective, migrations } = reconstructOwnedWaypoints({
      edges: [edge("e1", "G", "La")],
      expandedChildIds: new Set<string>(),
      pos: () => ({ x: 0, y: 0 }),
      levelEdgeWaypoints: { e1: wp([{ x: 5, y: 5 }], false) },
    });
    expect(effective.e1).toEqual([{ x: 5, y: 5 }]);
    expect(migrations.length).toBe(0);
  });

  it("стрелка между двумя детьми раскрытых рамок едет за source", () => {
    const { effective } = reconstructOwnedWaypoints({
      edges: [edge("e1", "g1", "g2")],
      expandedChildIds: new Set(["g1", "g2"]),
      pos: (id) => (id === "g1" ? { x: 200, y: 100 } : id === "g2" ? { x: 500, y: 400 } : undefined),
      levelEdgeWaypoints: { e1: wp([{ x: 10, y: 20 }], true) },
    });
    // база = source g1 (200,100) → (210,120), а не target g2
    expect(effective.e1).toEqual([{ x: 210, y: 120 }]);
  });
});
