// Вписывание диаграммы процесса (processes/useDiagramFit, правки приёмки фазы 3а):
// подписи переносятся под окно при масштабе 1, масштаб чтения не ниже 0,9 (текст шага
// на экране не мельче 10,8 px), в правке масштаба нет, а панель шага справа ни ширину
// вписывания, ни масштаб не меняет — она сужает только окно прокрутки.
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useDiagramFit } from "../processes/useDiagramFit";
import { revealDelta } from "../processes/reveal";

const GUTTER = 15;

// Тело экрана и окно прокрутки как их видит хук: ширины без раскладки jsdom.
function refs(bodyW: number, scrollW: number) {
  const body = { clientWidth: bodyW } as HTMLElement;
  const scroll = { offsetWidth: scrollW, clientWidth: scrollW - GUTTER } as HTMLElement;
  return { body: { current: body }, scroll: { current: scroll } };
}

function fit(width: number | null, scaled: boolean, scrollW = 1200, bodyW = 1200) {
  const r = refs(bodyW, scrollW);
  return renderHook(() => useDiagramFit(r.body, r.scroll, width, scaled)).result.current;
}

describe("вписывание диаграммы процесса", () => {
  // Окно 1200 без полосы прокрутки, без пикселя запаса и без полей обёртки (16).
  const FIT_W = 1200 - GUTTER - 1 - 16;

  it("ширина для раскладки — окно при масштабе 1; влезло — масштаба нет", () => {
    const f = fit(1000, true);
    expect(f.fitWidth).toBe(FIT_W);
    expect(f.scale).toBe(1);
  });

  it("не влезло и на нижнем пределе подписи — масштаб, но не ниже 0,9", () => {
    expect(fit(FIT_W + 40, true).scale).toBe(Math.floor(((FIT_W + 16) / (FIT_W + 56)) * 1000) / 1000);
    expect(fit(FIT_W * 3, true).scale).toBe(0.9);
  });

  it("в правке масштаб всегда 1, а ширина для раскладки та же, что в чтении", () => {
    const f = fit(FIT_W * 3, false);
    expect(f.scale).toBe(1);
    expect(f.fitWidth).toBe(FIT_W);
  });

  it("панель шага сужает окно прокрутки, но не вписывание", () => {
    const closed = fit(FIT_W + 40, true, 1200);
    const open = fit(FIT_W + 40, true, 1200 - 320);
    expect(open).toEqual(closed);
  });

  it("не разложено (ширины 0) — вписывания нет", () => {
    const f = fit(1000, true, 0, 0);
    expect(f.fitWidth).toBeUndefined();
    expect(f.scale).toBe(1);
  });
});

describe("выбранный шаг доводится до видимости кратчайшим путём", () => {
  const view = { left: 0, top: 60, right: 800, bottom: 600 };

  it("виден целиком — прокрутки нет", () => {
    expect(revealDelta(view, { left: 100, top: 100, right: 300, bottom: 140 })).toEqual({ dx: 0, dy: 0 });
  });

  it("ушёл вправо под панель — сдвиг ровно на недостачу", () => {
    expect(revealDelta(view, { left: 700, top: 100, right: 900, bottom: 140 })).toEqual({ dx: 100, dy: 0 });
  });

  it("левее, выше (под шапками) и ниже окна — к ближнему краю", () => {
    expect(revealDelta(view, { left: -50, top: 40, right: 100, bottom: 80 })).toEqual({ dx: -50, dy: -20 });
    expect(revealDelta(view, { left: 10, top: 620, right: 100, bottom: 660 })).toEqual({ dx: 0, dy: 60 });
  });

  it("шире окна — видно его начало", () => {
    expect(revealDelta(view, { left: 200, top: 100, right: 1400, bottom: 140 }).dx).toBe(200);
  });
});
