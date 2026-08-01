// Ф0 эпика «общие плечи v2» (docs/archive/plan-arrow-trunks.md): геометрия легальных стволов.
import { describe, expect, it } from "vitest";
import { commonPrefix, commonSuffix, pieceLen, trunkPieces } from "../graph/layout/trunks";
import type { EdgePoint } from "../../types";

const P = (x: number, y: number): EdgePoint => ({ x, y });

describe("commonPrefix", () => {
  it("продолжается через общий излом и заканчивается на углу расхождения", () => {
    const a = [P(0, 0), P(60, 0), P(60, 40), P(120, 40)];
    const b = [P(0, 0), P(60, 0), P(60, 40), P(60, 90)];
    const piece = commonPrefix(a, b);
    expect(piece).toEqual([P(0, 0), P(60, 0), P(60, 40)]);
    expect(pieceLen(piece)).toBe(100);
  });

  it("расхождение в середине чужого сегмента — кусок до угла свернувшего", () => {
    const a = [P(0, 0), P(100, 0), P(100, 50)];
    const b = [P(0, 0), P(60, 0), P(60, 50)];
    expect(commonPrefix(a, b)).toEqual([P(0, 0), P(60, 0)]);
  });

  it("немедленное расхождение из общего порта — куска нет", () => {
    expect(commonPrefix([P(0, 0), P(50, 0)], [P(0, 0), P(0, 50)])).toEqual([]);
  });

  it("разные стартовые точки — куска нет", () => {
    expect(commonPrefix([P(0, 0), P(50, 0)], [P(5, 5), P(50, 5)])).toEqual([]);
  });

  it("полное поглощение: один маршрут — префикс другого", () => {
    const a = [P(0, 0), P(60, 0)];
    const b = [P(0, 0), P(60, 0), P(60, 40)];
    expect(commonPrefix(a, b)).toEqual([P(0, 0), P(60, 0)]);
  });

  it("повторное схождение после расхождения в кусок НЕ входит", () => {
    // a уходит вверх и возвращается на линию b — геометрическое наложение на
    // [100..150]×{y:0} легальным префиксом не является
    const a = [P(0, 0), P(50, 0), P(50, 30), P(100, 30), P(100, 0), P(150, 0)];
    const b = [P(0, 0), P(150, 0)];
    const piece = commonPrefix(a, b);
    expect(piece).toEqual([P(0, 0), P(50, 0)]);
  });

  it("EPS-допуск: микрорасхождение угла (≤0.5) не рвёт ствол", () => {
    const a = [P(0, 0), P(60, 0), P(60, 40)];
    const b = [P(0, 0), P(60.4, 0), P(60.4, 40)];
    const piece = commonPrefix(a, b);
    expect(pieceLen(piece)).toBe(100); // оба сегмента пройдены совместно
  });

  it("диагональный fallback-сегмент ствол не продолжает", () => {
    const a = [P(0, 0), P(60, 0), P(100, 40)];
    const b = [P(0, 0), P(60, 0), P(60, 80)];
    expect(commonPrefix(a, b)).toEqual([P(0, 0), P(60, 0)]);
  });
});

describe("commonSuffix", () => {
  it("T-подход: слияние в середине сегмента, кусок в порядке хода пути", () => {
    const a = [P(0, 0), P(0, 50), P(100, 50)];
    const b = [P(30, -20), P(30, 50), P(100, 50)];
    const piece = commonSuffix(a, b);
    expect(piece).toEqual([P(30, 50), P(100, 50)]); // от точки слияния к общему порту
    expect(pieceLen(piece)).toBe(70);
  });

  it("суффикс через совместный излом", () => {
    const a = [P(0, 0), P(0, 60), P(40, 60), P(40, 100)];
    const b = [P(-30, 20), P(-30, 60), P(0, 60), P(40, 60), P(40, 100)];
    const piece = commonSuffix(a, b);
    expect(piece).toEqual([P(0, 60), P(40, 60), P(40, 100)]);
  });

  it("разные концы — куска нет", () => {
    expect(commonSuffix([P(0, 0), P(50, 0)], [P(0, 10), P(50, 10)])).toEqual([]);
  });
});

describe("trunkPieces", () => {
  it("веера по портам обеих ролей; непричастные рёбра в карте отсутствуют", () => {
    const routes = new Map<string, EdgePoint[]>([
      // out-веер из (0,0)
      ["e1", [P(0, 0), P(80, 0), P(80, 40)]],
      ["e2", [P(0, 0), P(80, 0), P(80, -40)]],
      ["e3", [P(0, 0), P(40, 0), P(40, 60)]],
      // in-веер в (120,100)
      ["e4", [P(200, 0), P(200, 100), P(120, 100)]],
      ["e5", [P(260, 40), P(260, 100), P(120, 100)]],
      // непричастное
      ["e9", [P(300, 300), P(400, 300)]],
    ]);
    const map = trunkPieces(routes);

    const e1 = map.get("e1")!;
    expect(e1.map((r) => [r.mateId, r.kind, r.len])).toEqual([
      ["e2", "out", 80],
      ["e3", "out", 40],
    ]);
    // симметрия записей
    expect(map.get("e2")!.find((r) => r.mateId === "e1")!.len).toBe(80);
    expect(map.get("e3")!.map((r) => r.len).sort()).toEqual([40, 40]);

    const e4 = map.get("e4")!;
    expect(e4).toHaveLength(1);
    expect(e4[0].mateId).toBe("e5");
    expect(e4[0].kind).toBe("in");
    expect(e4[0].len).toBe(80);
    // кусок в порядке хода пути: от слияния (200,100) к порту (120,100)
    expect(e4[0].pts).toEqual([P(200, 100), P(120, 100)]);
    expect(map.get("e5")!.find((r) => r.mateId === "e4")!.len).toBe(80);

    expect(map.has("e9")).toBe(false);
  });
});
