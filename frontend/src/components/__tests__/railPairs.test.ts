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

  it("КООРДИНАЦИЯ ПАР (E12): две пары на одной грани узла не сажают вход в чужой выход", () => {
    // Репро «Ярмарки» (2026-08-19): пары A↔K и B↔K обе стыкуются на левой грани K.
    // Раздача «по id» внутри каждой пары сажала ВХОД одной пары и ВЫХОД другой на один
    // слот. Теперь на каждой грани роли согласованы: все выходы — один слот, входы — другой.
    const groups: G[] = [
      { id: "0-in", source: "A", target: "K" },  // вход в K
      { id: "1-out", source: "K", target: "A" }, // выход из K
      { id: "2-out", source: "K", target: "B" }, // выход из K
      { id: "3-in", source: "B", target: "K" },  // вход в K
    ];
    // A выше-левее K, B ниже-левее: обе пары горизонтальные, обе стыкуются в K.left
    const positions = pos([["A", 0, 100], ["K", 600, 300], ["B", 0, 500]]);
    const out = railAssignments(groups, new Set(groups.map((g) => g.id)), positions);
    expect(out.size).toBe(4);
    // слот конца на грани K: у входа — tIdx, у выхода — sIdx
    const slotAtK = (id: string): number =>
      id.endsWith("in") ? out.get(id)!.tIdx : out.get(id)!.sIdx;
    // роли согласованы: оба выхода на одном слоте, оба входа на другом
    expect(slotAtK("1-out")).toBe(slotAtK("2-out"));
    expect(slotAtK("0-in")).toBe(slotAtK("3-in"));
    expect(slotAtK("0-in")).not.toBe(slotAtK("1-out"));
    // внутри каждой пары рельсы по-прежнему развязаны
    expect(out.get("0-in")!.sIdx).not.toBe(out.get("1-out")!.sIdx);
    expect(out.get("2-out")!.sIdx).not.toBe(out.get("3-in")!.sIdx);
  });

  it("координация детерминирована и не зависит от порядка групп во входе", () => {
    const groups: G[] = [
      { id: "0-in", source: "A", target: "K" },
      { id: "1-out", source: "K", target: "A" },
      { id: "2-out", source: "K", target: "B" },
      { id: "3-in", source: "B", target: "K" },
    ];
    const positions = pos([["A", 0, 100], ["K", 600, 300], ["B", 0, 500]]);
    const ids = new Set(groups.map((g) => g.id));
    const a = railAssignments(groups, ids, positions);
    const b = railAssignments([...groups].reverse(), ids, positions);
    for (const g of groups) expect(a.get(g.id)).toEqual(b.get(g.id));
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
