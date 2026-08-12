// Раскрывашка с анимацией высоты.
//
// Главное свойство, ради которого хук вообще нужен: при сворачивании содержимое
// ОСТАЁТСЯ в DOM, пока едет анимация — иначе схлопывать было бы нечего, и блок
// пропадал бы рывком. Проверяется на инлайн-стилях: в jsdom нет layout.
import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useCollapse } from "../useCollapse";

const realRect = Element.prototype.getBoundingClientRect;

function stubHeight(h: () => number) {
  Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: h(), width: 100, height: h(),
      toJSON: () => ({}) } as DOMRect;
  };
}

function Harness({ open }: { open: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const shown = useCollapse(ref, open);
  return <div>{shown && <div ref={ref} data-testid="box">колонки</div>}</div>;
}

function endTransition(el: Element) {
  const ev = new Event("transitionend");
  Object.defineProperty(ev, "propertyName", { value: "height" });
  // act: по окончании анимации хук снимает состояние «ещё сворачиваемся», а это
  // обычный setState — вне act React не применил бы его к дереву теста.
  act(() => { el.dispatchEvent(ev); });
}

describe("useCollapse", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
    stubHeight(() => 200);
  });
  afterEach(() => {
    Element.prototype.getBoundingClientRect = realRect;
    vi.unstubAllGlobals();
  });

  it("раскрытие едет к натуральной высоте", () => {
    const { rerender, getByTestId } = render(<Harness open={false} />);
    rerender(<Harness open />);
    const box = getByTestId("box");
    expect(box.style.height).toBe("200px");
    expect(box.style.transition).toContain("height");
    endTransition(box);
    // Фиксацию снимаем: дальше блок живёт с auto и не обрежет разросшийся контент.
    expect(box.style.height).toBe("");
  });

  it("при сворачивании содержимое живёт до конца анимации, а потом уходит", () => {
    const { rerender, getByTestId, queryByTestId } = render(<Harness open />);
    rerender(<Harness open={false} />);
    const box = getByTestId("box");
    // Ещё в DOM и едет к нулю — иначе схлопывать было бы нечего.
    expect(box.style.height).toBe("0px");
    endTransition(box);
    expect(queryByTestId("box")).toBeNull();
  });

  it("prefers-reduced-motion: без анимации, содержимое уходит сразу", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const { rerender, queryByTestId } = render(<Harness open />);
    rerender(<Harness open={false} />);
    expect(queryByTestId("box")?.style.height ?? "").toBe("");
  });
});
