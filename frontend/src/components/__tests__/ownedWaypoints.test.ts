import { describe, it, expect } from "vitest";
import { reconstructOwnedWaypoints } from "../graph/layout/ownedWaypoints";
import type { Edge as AppEdge, LevelWaypoints } from "../../types";

// Реконструкция изломов гостевых стрелок к детям раскрытых рамок (own-on-first-render, Ф3).
// Якорь излома — ЯВНАЯ идентичность узла (anchor_node_id): абсолют = офсет + позиция узла-якоря.
// Излом гаснет ровно при сворачивании СВОЕГО узла (его нет среди отображаемых), а не «любого
// показанного гостевого конца». Привязку приобретает абсолютный путь, чей конец — потомок
// раскрытой рамки (expandedChildIds).

const edge = (id: string, source_id: string, target_id: string): AppEdge => ({
  id, label: null, technology: null, source_id, target_id,
  source_handle: null, target_handle: null, created_at: "2026-06-16T00:00:00Z",
});
const wp = (waypoints: { x: number; y: number }[], anchor_node_id: string | null): LevelWaypoints =>
  ({ waypoints, anchor_node_id });

describe("reconstructOwnedWaypoints (Ф3, якорь по идентичности)", () => {
  // g1 — гостевой ребёнок раскрытой рамки на позиции (200,100); излом привязан к ней.
  const base = {
    edges: [edge("e1", "g1", "La")],
    pos: (id: string) => (id === "g1" ? { x: 200, y: 100 } : id === "La" ? { x: 0, y: 0 } : undefined),
    expandedChildIds: new Set(["g1"]),
  };

  it("офсетный путь → абсолют = офсет + позиция узла-якоря", () => {
    const { effective, migrations } = reconstructOwnedWaypoints({
      ...base, levelEdgeWaypoints: { e1: wp([{ x: 10, y: 20 }], "g1") },
    });
    // позиция g1 = (200,100); абсолют = (210,120)
    expect(effective.e1).toEqual([{ x: 210, y: 120 }]);
    expect(migrations.length).toBe(0);
  });

  it("излом едет ровно с узлом-якорем: сдвиг позиции на (+60,+5) сдвигает излом так же", () => {
    const a = reconstructOwnedWaypoints({ ...base, levelEdgeWaypoints: { e1: wp([{ x: 10, y: 20 }], "g1") } });
    const moved = reconstructOwnedWaypoints({
      edges: base.edges, expandedChildIds: base.expandedChildIds,
      pos: (id) => (id === "g1" ? { x: 260, y: 105 } : id === "La" ? { x: 0, y: 0 } : undefined),
      levelEdgeWaypoints: { e1: wp([{ x: 10, y: 20 }], "g1") },
    });
    expect(moved.effective.e1[0].x - a.effective.e1[0].x).toBeCloseTo(60);
    expect(moved.effective.e1[0].y - a.effective.e1[0].y).toBeCloseTo(5);
  });

  it("свежий/легаси абсолют к ребёнку раскрытой рамки → приобретает якорь, на экране без сдвига", () => {
    const { effective, migrations } = reconstructOwnedWaypoints({
      ...base, levelEdgeWaypoints: { e1: wp([{ x: 210, y: 120 }], null) },
    });
    // абсолют на экране не двигаем (это и чинит баг «по отпусканию встаёт назад»)
    expect(effective.e1).toEqual([{ x: 210, y: 120 }]);
    // приобретённый якорь = g1; офсет = абсолют − позиция g1 = (210−200, 120−100) = (10,20)
    expect(migrations).toEqual([{ edge_id: "e1", anchor_node_id: "g1", waypoints: [{ x: 10, y: 20 }] }]);
  });

  it("работает для АВТО-ребёнка (нет ghost_position) — приобретение по показу, не по владению", () => {
    // g1 в expandedChildIds, но никакой levelPositions не передаём вообще — раньше так
    // излом не сохранялся; теперь якорь приобретается по факту показа потомком раскрытой рамки.
    const { effective, migrations } = reconstructOwnedWaypoints({
      ...base, levelEdgeWaypoints: { e1: wp([{ x: 300, y: 90 }], null) },
    });
    expect(effective.e1).toEqual([{ x: 300, y: 90 }]);
    expect(migrations).toEqual([{ edge_id: "e1", anchor_node_id: "g1", waypoints: [{ x: 100, y: -10 }] }]); // (300−200, 90−100)
  });

  it("узел-якорь не отображается (свёрнут) → авто-маршрут (пусто)", () => {
    const { effective, migrations } = reconstructOwnedWaypoints({
      edges: [edge("e1", "g1", "La")],
      expandedChildIds: new Set<string>(),
      pos: (id) => (id === "g1" ? undefined : { x: 0, y: 0 }), // g1 свёрнут — позиции нет
      levelEdgeWaypoints: { e1: wp([{ x: 10, y: 20 }], "g1") },
    });
    expect(effective.e1).toEqual([]);
    expect(migrations.length).toBe(0);
  });

  it("баг 3: якорь свёрнут, но ДРУГОЙ конец — потомок раскрытой рамки → излом всё равно гаснет", () => {
    // Раньше якорь выводился из «любого показанного гостевого конца»: g1 (свой якорь) свёрнут,
    // но target g2 в раскрытой рамке → излом перепривязывался к g2 и зависал. Теперь привязка
    // по идентичности: anchor_node_id=g1 не отображается → авто-маршрут, на g2 НЕ перескакивает.
    const { effective, migrations } = reconstructOwnedWaypoints({
      edges: [edge("e1", "g1", "g2")],
      expandedChildIds: new Set(["g2"]),
      pos: (id) => (id === "g2" ? { x: 500, y: 400 } : undefined), // g1 свёрнут
      levelEdgeWaypoints: { e1: wp([{ x: 10, y: 20 }], "g1") },
    });
    expect(effective.e1).toEqual([]);
    expect(migrations.length).toBe(0);
  });

  it("обычная гостевая стрелка (конец не в раскрытой рамке) → абсолютный путь как пришёл", () => {
    const { effective, migrations } = reconstructOwnedWaypoints({
      edges: [edge("e1", "G", "La")],
      expandedChildIds: new Set<string>(),
      pos: () => ({ x: 0, y: 0 }),
      levelEdgeWaypoints: { e1: wp([{ x: 5, y: 5 }], null) },
    });
    expect(effective.e1).toEqual([{ x: 5, y: 5 }]);
    expect(migrations.length).toBe(0);
  });

  it("абсолют между двумя детьми раскрытых рамок приобретает source", () => {
    const { migrations } = reconstructOwnedWaypoints({
      edges: [edge("e1", "g1", "g2")],
      expandedChildIds: new Set(["g1", "g2"]),
      pos: (id) => (id === "g1" ? { x: 200, y: 100 } : id === "g2" ? { x: 500, y: 400 } : undefined),
      levelEdgeWaypoints: { e1: wp([{ x: 210, y: 120 }], null) },
    });
    // якорь = source g1 (200,100); офсет = (10,20), а не от target g2
    expect(migrations).toEqual([{ edge_id: "e1", anchor_node_id: "g1", waypoints: [{ x: 10, y: 20 }] }]);
  });
});
