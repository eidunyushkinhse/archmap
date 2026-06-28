import { describe, it, expect } from "vitest";
import { reconstructOwnedWaypoints } from "../graph/layout/ownedWaypoints";
import type { Edge as AppEdge, LevelPos, LevelWaypoints } from "../../types";

// Реконструкция изломов владеемых групп (ТЗ D8). Чистая арифметика:
// anchorЭфф = позиция_ребёнка − офсет_позиции; абсолют = офсет_излома + anchorЭфф.

const edge = (id: string, source_id: string, target_id: string): AppEdge => ({
  id, label: null, technology: null, source_id, target_id,
  source_handle: null, target_handle: null, created_at: "2026-06-16T00:00:00Z",
});
const wp = (waypoints: { x: number; y: number }[], anchor_rel: boolean): LevelWaypoints => ({ waypoints, anchor_rel });
const owned = (pos_x: number, pos_y: number): LevelPos => ({ pos_x, pos_y, anchor_rel: true });

describe("reconstructOwnedWaypoints (D8)", () => {
  // g1 — владеемый ребёнок: позиция (200,100), офсет позиции (50,-30) → anchorЭфф (150,130)
  const base = {
    edges: [edge("e1", "g1", "La")],
    levelPositions: { g1: owned(50, -30) } as Record<string, LevelPos>,
    pos: (id: string) => (id === "g1" ? { x: 200, y: 100 } : id === "La" ? { x: 0, y: 0 } : undefined),
    expandedChildIds: new Set<string>(),
  };

  it("офсетный путь → абсолют = офсет + anchorЭфф", () => {
    const { effective, migrations } = reconstructOwnedWaypoints({
      ...base, levelEdgeWaypoints: { e1: wp([{ x: 10, y: 20 }], true) },
    });
    // anchorЭфф = (200−50, 100−(−30)) = (150,130); абсолют = (160,150)
    expect(effective.e1).toEqual([{ x: 160, y: 150 }]);
    expect(migrations.length).toBe(0);
  });

  it("излом едет ровно с ребёнком: сдвиг позиции на (+60,+5) сдвигает излом так же", () => {
    const a = reconstructOwnedWaypoints({ ...base, levelEdgeWaypoints: { e1: wp([{ x: 10, y: 20 }], true) } });
    const moved = reconstructOwnedWaypoints({
      edges: base.edges, levelPositions: base.levelPositions,
      pos: (id) => (id === "g1" ? { x: 260, y: 105 } : id === "La" ? { x: 0, y: 0 } : undefined),
      levelEdgeWaypoints: { e1: wp([{ x: 10, y: 20 }], true) }, expandedChildIds: new Set<string>(),
    });
    expect(moved.effective.e1[0].x - a.effective.e1[0].x).toBeCloseTo(60);
    expect(moved.effective.e1[0].y - a.effective.e1[0].y).toBeCloseTo(5);
  });

  it("легаси-абсолют владеемого ребёнка → миграция в офсет, на экране без сдвига", () => {
    const { effective, migrations } = reconstructOwnedWaypoints({
      ...base, levelEdgeWaypoints: { e1: wp([{ x: 160, y: 150 }], false) },
    });
    // абсолют на экране не двигаем
    expect(effective.e1).toEqual([{ x: 160, y: 150 }]);
    // офсет = абсолют − anchorЭфф = (160−150, 150−130) = (10,20)
    expect(migrations).toEqual([{ edge_id: "e1", waypoints: [{ x: 10, y: 20 }] }]);
  });

  it("офсетный путь без живого якоря (свёрнуто/не владеемо) → авто-маршрут (пусто)", () => {
    const { effective, migrations } = reconstructOwnedWaypoints({
      edges: [edge("e1", "g1", "La")],
      levelPositions: {}, // нет anchor_rel-позиции → якоря нет
      pos: () => ({ x: 0, y: 0 }),
      levelEdgeWaypoints: { e1: wp([{ x: 10, y: 20 }], true) }, expandedChildIds: new Set<string>(),
    });
    expect(effective.e1).toEqual([]);
    expect(migrations.length).toBe(0);
  });

  it("обычная гостевая стрелка (нет владеемого конца) → путь как пришёл", () => {
    const { effective, migrations } = reconstructOwnedWaypoints({
      edges: [edge("e1", "G", "La")],
      levelPositions: {},
      pos: () => ({ x: 0, y: 0 }),
      levelEdgeWaypoints: { e1: wp([{ x: 5, y: 5 }], false) }, expandedChildIds: new Set<string>(),
    });
    expect(effective.e1).toEqual([{ x: 5, y: 5 }]);
    expect(migrations.length).toBe(0);
  });

  // Фикс A (кейс DB Proxy → Базы данных на ObsCore): абсолютный гостевой излом, чей конец —
  // АВТО-потомок раскрытой рамки, рисовался в свёрнутой проекции; после раскрытия ребёнок
  // переехал раскладкой → старый путь коряв. Сбрасываем его на авто-маршрут.
  it("абсолютный излом к авто-ребёнку РАСКРЫТОЙ рамки → сброс на авто-маршрут (пусто)", () => {
    const { effective, migrations } = reconstructOwnedWaypoints({
      edges: [edge("e1", "DBProxy", "BasesData")],   // BasesData — авто-ребёнок раскрытой рамки
      levelPositions: {},                            // нет ghost_position → не владеемый
      pos: () => ({ x: 0, y: 0 }),
      levelEdgeWaypoints: { e1: wp([{ x: 1582, y: 573 }, { x: 1582, y: 331 }], false) },
      expandedChildIds: new Set(["BasesData"]),
    });
    expect(effective.e1).toEqual([]);
    expect(migrations.length).toBe(0);            // сброс, не миграция — ручной путь не пинится
  });

  it("абсолютный излом к обычному гостю (НЕ в раскрытой рамке) → путь сохраняется", () => {
    const { effective } = reconstructOwnedWaypoints({
      edges: [edge("e1", "DBProxy", "G")],
      levelPositions: {},
      pos: () => ({ x: 0, y: 0 }),
      levelEdgeWaypoints: { e1: wp([{ x: 5, y: 5 }], false) },
      expandedChildIds: new Set(["SomeOtherChild"]),  // G не среди потомков раскрытых рамок
    });
    expect(effective.e1).toEqual([{ x: 5, y: 5 }]);
  });
});
