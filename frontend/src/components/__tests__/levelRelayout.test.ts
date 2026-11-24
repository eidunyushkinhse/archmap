// Патчи команды «Переразложить уровень» (graph/interaction/useLevelRelayout, history.md U26).
// Сброс — как reset_view_layout сервера (V31) и холст «Развёртывание» (D16, D25): позиции
// уходят, флаг раскрытия (true и false) остаётся. Откат — позиции до сброса поверх
// текущей раскладки, раскрытость текущая (принцип задания П2: отмена возвращает позиции,
// а не раскрытость).
import { describe, it, expect } from "vitest";
import { relayoutPatch, restorePatch } from "../graph/interaction/useLevelRelayout";

describe("relayoutPatch", () => {
  it("строка без флага удаляется, с флагом раскрытия теряет только координаты", () => {
    expect(relayoutPatch({
      a: { x: 10, y: 20 },
      box: { x: 5, y: 6, expanded: true },
      "deploy:site:s1": { x: 0, y: 0, expanded: false },
    })).toEqual({ a: null, box: { x: null, y: null }, "deploy:site:s1": { x: null, y: null } });
  });

  it("строка без позиции не трогается: сбрасывать нечего", () => {
    expect(relayoutPatch({ box: { expanded: true }, site: { expanded: false } })).toEqual({});
    expect(relayoutPatch({})).toEqual({});
  });

  it("expanded: null — не флаг: строка удаляется целиком", () => {
    expect(relayoutPatch({ a: { x: 1, y: 2, expanded: null } })).toEqual({ a: null });
  });
});

describe("restorePatch", () => {
  const before = { a: { x: 10, y: 20 }, box: { x: 5, y: 6, expanded: true } };

  it("возвращает позиции до сброса, засеянное после сброса снимает", () => {
    const now = { a: { x: 1, y: 1 }, box: { expanded: true, x: 2, y: 2 }, g: { x: 3, y: 3 } };
    expect(restorePatch(before, now)).toEqual({ a: { x: 10, y: 20 }, box: { x: 5, y: 6 }, g: null });
  });

  it("раскрытость текущая: свёрнутая между делом рамка позицию получает, флаг не трогается", () => {
    // box свернули после сброса (expanded выкинут), g раскрыли и засеяли после сброса
    const now = { a: { x: 1, y: 1 }, box: { x: 2, y: 2 }, g: { x: 3, y: 3, expanded: true } };
    expect(restorePatch(before, now)).toEqual({ a: { x: 10, y: 20 }, box: { x: 5, y: 6 }, g: { x: null, y: null } });
  });

  it("строка, совпавшая с исходной, в патч не попадает", () => {
    expect(restorePatch(before, { a: { x: 10, y: 20 }, box: { expanded: true } })).toEqual({ box: { x: 5, y: 6 } });
    expect(restorePatch(before, before)).toEqual({});
  });

  it("строка без позиции до сброса и без строки сейчас — ничего", () => {
    expect(restorePatch({ box: { expanded: true } }, { box: { expanded: true } })).toEqual({});
  });
});
