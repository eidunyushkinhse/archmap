// Место всплывающей панели у кнопки (легенда схемы): вверх, как раньше; не помещается —
// вниз; не помещается нигде — слева от кнопки, целиком в окне; длиннее окна — maxHeight.
import { describe, expect, it } from "vitest";
import { placeAboveButton } from "../popoverPlace";

const окно = { width: 1280, height: 720 };
const панель = { width: 234, height: 600 };
const кнопка = (top: number, right = 1205) => ({ top, bottom: top + 26, left: right - 98, right });

describe("placeAboveButton", () => {
  it("над кнопкой, правый край по кнопке, зазор 8", () => {
    expect(placeAboveButton(кнопка(694), панель, окно)).toEqual({
      top: 694 - 8 - 600, right: 1280 - 1205, maxHeight: 720 - 16, origin: "bottom right",
    });
  });

  it("сверху не помещается — под кнопкой", () => {
    const p = placeAboveButton(кнопка(59), панель, окно);
    expect(p.top).toBe(59 + 26 + 8);
    expect(p.origin).toBe("top right");
  });

  it("не помещается ни сверху, ни снизу — слева от кнопки, целиком в окне", () => {
    const p = placeAboveButton(кнопка(390), { width: 234, height: 667 }, окно);
    expect(p.top).toBe(8);
    expect(p.top + 667).toBeLessThanOrEqual(720 - 8);
    // правый край панели — левее кнопки на зазор: кнопку панель не закрывает
    expect(1280 - p.right).toBe(1205 - 98 - 8);
    expect(p.origin).toBe("right");
  });

  it("сбоку низ панели — по низу кнопки, если окно позволяет", () => {
    const p = placeAboveButton(кнопка(300), { width: 234, height: 300 }, { width: 1280, height: 560 });
    expect(p.origin).toBe("right");
    expect(p.top).toBe(326 - 300);
  });

  it("панель длиннее окна — от верхнего поля, дальше прокрутка", () => {
    const p = placeAboveButton(кнопка(300), { width: 234, height: 900 }, окно);
    expect(p.top).toBe(8);
    expect(p.maxHeight).toBe(704);
  });

  it("кнопка у левого края узкого окна — панель не уходит за край", () => {
    const p = placeAboveButton({ top: 500, bottom: 526, left: 22, right: 120 }, панель, { width: 320, height: 720 });
    expect(320 - p.right - 234).toBeGreaterThanOrEqual(8);
  });
});
