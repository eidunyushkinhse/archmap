// Слой расстановки читателя (graph/interaction/readerLayer, view.md V25 v2, задание П2):
// действующая раскладка = серверная + слой; правка слоя берёт только позиции; засев до
// первой правки достаётся тем, у кого позиции нет.
import { describe, it, expect } from "vitest";
import { applyReaderLayer, EMPTY_LAYER, pendingSeeds, readerLayerPatch } from "../graph/interaction/readerLayer";

const SERVER = { a: { x: 10, y: 20 }, box: { x: 5, y: 6, expanded: true }, c: { x: 1, y: 1 } };

describe("applyReaderLayer", () => {
  it("пустой слой — та же ссылка", () => {
    expect(applyReaderLayer(SERVER, EMPTY_LAYER)).toBe(SERVER);
    expect(applyReaderLayer(SERVER, {})).toBe(SERVER);
  });

  it("позиция слоя поверх строки, null снимает позицию и оставляет флаг раскрытия", () => {
    expect(applyReaderLayer(SERVER, { a: { x: 30, y: 40 }, box: null, c: null, g: { x: 7, y: 8 } })).toEqual({
      a: { x: 30, y: 40 }, box: { expanded: true }, g: { x: 7, y: 8 },
    });
    // серверная раскладка не тронута
    expect(SERVER.a).toEqual({ x: 10, y: 20 });
  });
});

describe("readerLayerPatch", () => {
  it("перемещение — позиция, сброс — null, совпадающее с действующим — мимо", () => {
    expect(readerLayerPatch({ a: { x: 30, y: 40 }, c: null, box: { x: null, y: null }, g: null }, SERVER))
      .toEqual({ a: { x: 30, y: 40 }, c: null, box: null });
    expect(readerLayerPatch({ a: { x: 10, y: 20 } }, SERVER)).toEqual({});
  });

  it("строки раскрытия (раскрытие, сворачивание, own-on-expand) слой не берёт", () => {
    expect(readerLayerPatch({ box: { expanded: null }, g: { expanded: true, x: 1, y: 2 } }, SERVER)).toEqual({});
  });
});

describe("pendingSeeds", () => {
  it("засев — только ключам без позиции в действующей раскладке", () => {
    expect(pendingSeeds({ a: { x: 99, y: 99 }, g: { x: 3, y: 4 }, h: null }, SERVER)).toEqual({ g: { x: 3, y: 4 } });
  });
});
