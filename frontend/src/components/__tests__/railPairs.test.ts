import { describe, it, expect } from "vitest";
import { railAssignments } from "../graph/layout/railPairs";

interface G { id: string; source: string; target: string; }
const pos = (entries: Array<[string, number, number]>): Map<string, { x: number; y: number }> =>
  new Map(entries.map(([id, x, y]) => [id, { x, y }]));

describe("railAssignments (рельсы встречных пар, A11)", () => {
  it("горизонтальная встречная пара → крайние слоты, обращённые стороны", () => {
    const groups: G[] = [
      { id: "g1", source: "A", target: "B" }, // A слева → B
      { id: "g2", source: "B", target: "A" }, // B → A (встречное)
    ];
    const positions = pos([["A", 164, 270], ["B", 588, 270]]); // одна высота, B правее
    const out = railAssignments(groups, new Set(["g1", "g2"]), positions);
    expect(out.size).toBe(2);
    // g1 (меньший id) → верхняя рельса (idx 0) на обоих концах; A.right, B.left
    expect(out.get("g1")).toEqual({ sSide: "right", sIdx: 0, tSide: "left", tIdx: 0 });
    // g2 → нижняя рельса (idx 2); source B смотрит влево (на A), target A смотрит вправо
    expect(out.get("g2")).toEqual({ sSide: "left", sIdx: 2, tSide: "right", tIdx: 2 });
  });

  it("разные слоты у двух направлений → плечи разъедутся", () => {
    const groups: G[] = [
      { id: "g1", source: "A", target: "B" },
      { id: "g2", source: "B", target: "A" },
    ];
    const out = railAssignments(groups, new Set(["g1", "g2"]), pos([["A", 0, 0], ["B", 400, 0]]));
    expect(out.get("g1")!.sIdx).not.toBe(out.get("g2")!.sIdx);
  });

  it("вертикальная встречная пара → стороны top/bottom", () => {
    const groups: G[] = [
      { id: "g1", source: "A", target: "B" }, // A сверху
      { id: "g2", source: "B", target: "A" },
    ];
    const out = railAssignments(groups, new Set(["g1", "g2"]), pos([["A", 0, 0], ["B", 0, 400]]));
    expect(out.get("g1")).toEqual({ sSide: "bottom", sIdx: 0, tSide: "top", tIdx: 0 });
    expect(out.get("g2")).toEqual({ sSide: "top", sIdx: 2, tSide: "bottom", tIdx: 2 });
  });

  it("одиночное ребро (нет встречного) → нет рельсов", () => {
    const groups: G[] = [{ id: "g1", source: "A", target: "B" }];
    const out = railAssignments(groups, new Set(["g1"]), pos([["A", 0, 0], ["B", 400, 0]]));
    expect(out.size).toBe(0);
  });

  it("два ребра ОДНОГО направления (не зеркальны) → не пара", () => {
    // мастеринг такого не даёт, но защищаемся: A→B дважды между той же парой узлов
    const groups: G[] = [
      { id: "g1", source: "A", target: "B" },
      { id: "g2", source: "A", target: "B" },
    ];
    const out = railAssignments(groups, new Set(["g1", "g2"]), pos([["A", 0, 0], ["B", 400, 0]]));
    expect(out.size).toBe(0);
  });

  it("встречная пара, но партнёр ВНЕ раскладки (detour/guest) → не рельсим", () => {
    const groups: G[] = [
      { id: "g1", source: "A", target: "B" },
      { id: "g2", source: "B", target: "A" },
    ];
    // g2 не в pairableIds (например, гостевой обвод) → пара в раскладке неполна
    const out = railAssignments(groups, new Set(["g1"]), pos([["A", 0, 0], ["B", 400, 0]]));
    expect(out.size).toBe(0);
  });

  it("стабильность A12.5: партнёр РУЧНОЙ (в pairableIds), но рельса соседа сохраняется", () => {
    // g2 потащили за изломы → он ручной (выпал из routableIds), НО остаётся в раскладке
    // (pairableIds). Пара по топологии цела → авто-ребро g1 НЕ теряет рельсу и не перескакивает.
    const groups: G[] = [
      { id: "g1", source: "A", target: "B" },
      { id: "g2", source: "B", target: "A" },
    ];
    const positions = pos([["A", 164, 270], ["B", 588, 270]]);
    const out = railAssignments(groups, new Set(["g1", "g2"]), positions); // оба в раскладке
    // g1 получает свою рельсу независимо от того, что g2 рисуется вручную
    expect(out.get("g1")).toEqual({ sSide: "right", sIdx: 0, tSide: "left", tIdx: 0 });
  });

  it("петля (source===target) игнорируется", () => {
    const groups: G[] = [{ id: "g1", source: "A", target: "A" }];
    const out = railAssignments(groups, new Set(["g1"]), pos([["A", 0, 0]]));
    expect(out.size).toBe(0);
  });

  it("три ребра на паре узлов → не точная пара, пропускаем", () => {
    const groups: G[] = [
      { id: "g1", source: "A", target: "B" },
      { id: "g2", source: "B", target: "A" },
      { id: "g3", source: "A", target: "B" },
    ];
    const out = railAssignments(groups, new Set(["g1", "g2", "g3"]), pos([["A", 0, 0], ["B", 400, 0]]));
    expect(out.size).toBe(0);
  });

  it("слот назначается детерминированно по id (меньший → верхняя), независимо от порядка входа", () => {
    const positions = pos([["A", 0, 0], ["B", 400, 0]]);
    const a = railAssignments(
      [{ id: "z", source: "A", target: "B" }, { id: "a", source: "B", target: "A" }],
      new Set(["z", "a"]), positions,
    );
    const b = railAssignments(
      [{ id: "a", source: "B", target: "A" }, { id: "z", source: "A", target: "B" }],
      new Set(["z", "a"]), positions,
    );
    // "a" < "z" → "a" всегда верхняя (idx 0), независимо от порядка во входе
    expect(a.get("a")!.sIdx).toBe(0);
    expect(b.get("a")!.sIdx).toBe(0);
    expect(a.get("z")!.sIdx).toBe(2);
    expect(b.get("z")!.sIdx).toBe(2);
  });
});
