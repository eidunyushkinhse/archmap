import { describe, it, expect } from "vitest";
import { buildLabelPlacements, type LabelMeta } from "../graph/layout/labelLayout";
import { rectFromCenter, countLabelOverlaps } from "../graph/layout/arrowMetrics";
import { labelBoxSize } from "../graph/layout/labelBox";
import type { NodeRect } from "../graph/edgePath";
import type { EdgeGroup } from "../graph/types";
import type { LayoutEdge, EdgePoint } from "../../types";

// Мост раскладки плашек (A7.2): по авто-маршрутам строит размещение без наложений (R2),
// с выноской-leader там, где на линии не встаёт. Проверяем инварианты через метрики A0.

const edge = (id: string, label?: string): LayoutEdge => ({ id, source_id: "s", target_id: "t", label } as LayoutEdge);
const group = (id: string, members: LayoutEdge[]): EdgeGroup => ({ id, source: "s", target: "t", members });
const poly = (...pairs: [number, number][]): EdgePoint[] => pairs.map(([x, y]) => ({ x, y }));
const meta = (text: string): LabelMeta => ({ text, lines: 1 });

describe("buildLabelPlacements — базовое", () => {
  it("у группы без подписи плашки нет", () => {
    const routes = new Map([["g1", poly([0, 0], [200, 0])]]);
    const out = buildLabelPlacements({
      routes, groups: [group("g1", [edge("g1")])],
      labelMeta: () => null, preferredT: () => undefined, nodeRects: [],
    });
    expect(out.has("g1")).toBe(false);
  });

  it("чистый маршрут → online, плашка на линии (anchor == center)", () => {
    const routes = new Map([["g1", poly([0, 0], [200, 0])]]);
    const out = buildLabelPlacements({
      routes, groups: [group("g1", [edge("g1", "связь")])],
      labelMeta: () => meta("связь"), preferredT: () => undefined, nodeRects: [],
    });
    const p = out.get("g1")!;
    expect(p.mode).toBe("online");
    expect(p.center.y).toBeCloseTo(0, 0);
    expect(p.anchor).toEqual(p.center);
  });
});

describe("buildLabelPlacements — R2 без наложений", () => {
  it("две близкие параллельные стрелки → плашки не накладываются", () => {
    const routes = new Map([
      ["g1", poly([0, 0], [220, 0])],
      ["g2", poly([0, 12], [220, 12])],
    ]);
    const groups = [group("g1", [edge("g1", "alpha")]), group("g2", [edge("g2", "beta")])];
    const out = buildLabelPlacements({
      routes, groups,
      labelMeta: (g) => meta(g.id === "g1" ? "alpha" : "beta"),
      preferredT: () => undefined, nodeRects: [],
    });
    const rects: NodeRect[] = [...out.values()].map((p) =>
      rectFromCenter(p.center.x, p.center.y, labelBoxSize("alpha").w, labelBoxSize("alpha").h));
    expect(countLabelOverlaps(rects)).toBe(0);
  });
});

describe("buildLabelPlacements — выноска", () => {
  it("маршрут целиком под узлом → leader (плашка снесена с линии)", () => {
    // путь короткий и весь накрыт большим узлом-препятствием → на линии чисто не встаёт
    const routes = new Map([["g1", poly([0, 0], [40, 0])]]);
    const node: NodeRect = { x: -120, y: -80, w: 280, h: 160 };
    const out = buildLabelPlacements({
      routes, groups: [group("g1", [edge("g1", "под узлом")])],
      labelMeta: () => meta("под узлом"), preferredT: () => undefined, nodeRects: [node],
    });
    expect(out.get("g1")!.mode).toBe("leader");
  });
});

// РЕЖИМ ПОЧИНКИ (Б3б, E40 v2): мост обязан переразмещать ТОЛЬКО названные группы,
// сравнивать с ПРЕЖНИМ местом (keepRectOf) и возвращать ТОЛЬКО переехавших —
// вызывающий (T4) сливает их со своим размещением сам.
describe("buildLabelPlacements — починка (Б3б, E40 v2)", () => {
  const routes = new Map([
    ["g1", poly([0, 0], [220, 0])],        // подписанная жертва
    ["g2", poly([110, -120], [110, 120])], // чужая стрелка режет линию g1 посередине
  ]);
  const groups = [group("g1", [edge("g1", "жертва")]), group("g2", [edge("g2")])];
  const common = {
    routes, groups,
    labelMeta: (g: EdgeGroup): LabelMeta | null => (g.id === "g1" ? meta("жертва") : null),
    preferredT: (): number | undefined => undefined,
    nodeRects: [] as NodeRect[],
  };
  const box = labelBoxSize("жертва");
  // прежнее место — ровно на чужой стрелке (её и чинит Б3б)
  const cutKeep = new Map([["g1", rectFromCenter(110, 0, box.w, box.h)]]);

  it("жертву с чужой линии уводит прочь", () => {
    const out = buildLabelPlacements({
      ...common, repair: { only: new Set(["g1"]), keepRectOf: cutKeep },
    });
    const p = out.get("g1")!;
    expect(Math.abs(p.center.x - 110)).toBeGreaterThan(box.w / 2);
  });

  it("прежнее место не режется → переезда нет, результат пуст", () => {
    const clean = new Map([["g1", rectFromCenter(200, -300, box.w, box.h)]]);
    const out = buildLabelPlacements({
      ...common, repair: { only: new Set(["g1"]), keepRectOf: clean },
    });
    expect(out.size).toBe(0);
  });

  it("группы вне `only` не переразмещаются", () => {
    const out = buildLabelPlacements({
      ...common, repair: { only: new Set(["g2"]), keepRectOf: cutKeep },
    });
    expect(out.size).toBe(0); // у g2 подписи нет, а g1 в only не входит
  });
});
