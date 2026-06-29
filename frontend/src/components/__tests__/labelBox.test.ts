import { describe, it, expect } from "vitest";
import {
  estimateTextWidth,
  labelBoxSize,
  LABEL_CHROME_X,
  LABEL_CHROME_Y,
} from "../graph/layout/labelBox";

// Оценка габаритов плашки подписи ДО рендера (A1, предусловие R2). Модель моноширинная,
// согласована с ctxLabelWidth контекст-схемы: chrome по ширине = 16.

describe("estimateTextWidth", () => {
  it("пустой текст → 0", () => {
    expect(estimateTextWidth("")).toBe(0);
  });

  it("ширина пропорциональна длине (≈6.3px на символ)", () => {
    expect(estimateTextWidth("abcde")).toBe(Math.round(5 * 6.3)); // 32
  });
});

describe("labelBoxSize", () => {
  it("ширина = текст + обвязка (chrome=16), одиночная строка", () => {
    const { w, h } = labelBoxSize("abcde");
    expect(w).toBe(Math.round(5 * 6.3) + LABEL_CHROME_X); // 32 + 16 = 48
    expect(h).toBe(16 + LABEL_CHROME_Y);                  // одна строка (16) + 6 = 22
  });

  it("chrome по ширине совпадает с моделью контекста (16)", () => {
    expect(LABEL_CHROME_X).toBe(16);
  });

  it("maxWidth зажимает ширину (перенос текста)", () => {
    const { w } = labelBoxSize("очень длинная подпись связи", { maxWidth: 100 });
    expect(w).toBe(100);
  });

  it("несколько строк увеличивают высоту", () => {
    const one = labelBoxSize("x", { lines: 1 }).h;
    const three = labelBoxSize("x", { lines: 3 }).h;
    expect(three).toBe(one + 2 * 16); // +2 строки по 16px
  });

  it("lines<1 трактуется как 1 строка", () => {
    expect(labelBoxSize("x", { lines: 0 }).h).toBe(labelBoxSize("x", { lines: 1 }).h);
  });
});
