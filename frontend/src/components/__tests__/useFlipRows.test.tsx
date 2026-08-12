// Анимация перестройки списка: карточки едут FLIP-ом, высота контейнера — вместе с
// ними. Оба поведения проверяются на инлайн-стилях (в jsdom нет layout: rect всегда
// нулевой, поэтому геометрию подменяем), суть теста — ЧТО именно и в каком порядке
// хук выставляет на элементах.
import { render } from "@testing-library/react";
import { useRef } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useFlipRows } from "../useFlipRows";

// jsdom не считает layout — подставляем предсказуемые прямоугольники.
function stubRects(get: (el: HTMLElement) => { top: number; left: number; height: number }) {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const r = get(this as HTMLElement);
    return { x: r.left, y: r.top, top: r.top, left: r.left, right: r.left, bottom: r.top + r.height,
      width: 100, height: r.height, toJSON: () => ({}) } as DOMRect;
  };
}

function Harness({ ids, sig }: { ids: string[]; sig: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useFlipRows(ref, sig);
  return (
    <div ref={ref} data-testid="list">
      {ids.map((id) => <div key={id} data-flip-id={id}>{id}</div>)}
    </div>
  );
}

const realRect = Element.prototype.getBoundingClientRect;

describe("useFlipRows", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // rAF в jsdom есть, но нам важен ДЕТЕРМИНИЗМ: гоняем колбэк вручную.
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });
  afterEach(() => {
    Element.prototype.getBoundingClientRect = realRect;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("сдвинувшаяся карточка получает обратный сдвиг и едет к нулю", () => {
    const tops: Record<string, number> = { a: 0, b: 50 };
    stubRects((el) => ({ top: tops[el.dataset.flipId ?? ""] ?? 0, left: 0, height: 100 }));
    const { rerender, getByText } = render(<Harness ids={["a", "b"]} sig="1" />);

    tops.b = 10; // карточка «b» переехала выше
    rerender(<Harness ids={["a", "b"]} sig="2" />);

    // rAF отработал синхронно, поэтому обратный сдвиг уже снят, но переход назначен.
    const b = getByText("b");
    expect(b.style.transition).toContain("transform");
    expect(b.style.transform).toBe("");
  });

  it("высота контейнера едет от прежней к новой и фиксация потом снимается", () => {
    let height = 300;
    stubRects((el) => (el.dataset.testid === "list" || el.tagName === "DIV" && !el.dataset.flipId
      ? { top: 0, left: 0, height }
      : { top: 0, left: 0, height: 100 }));
    const { rerender, getByTestId } = render(<Harness ids={["a"]} sig="1" />);
    const list = getByTestId("list");

    height = 120; // раскрывашку свернули
    rerender(<Harness ids={["a"]} sig="2" />);

    // Стартовали от прежней высоты и поехали к новой — а не схлопнулись мгновенно.
    expect(list.style.height).toBe("120px");
    expect(list.style.transition).toContain("height");
    expect(list.style.overflow).toBe("hidden");

    // propertyName обязателен: слушатель отсекает чужие transitionend (их шлют
    // едущие карточки), и без него событие было бы проигнорировано.
    const ev = new Event("transitionend");
    Object.defineProperty(ev, "propertyName", { value: "height" });
    list.dispatchEvent(ev);
    // Без снятия фиксации список обрезал бы контент при следующей правке.
    expect(list.style.height).toBe("");
    expect(list.style.overflow).toBe("");
  });

  it("prefers-reduced-motion выключает и сдвиг, и анимацию высоты", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    let height = 300;
    stubRects((el) => (el.dataset.flipId ? { top: 0, left: 0, height: 100 } : { top: 0, left: 0, height }));
    const { rerender, getByTestId } = render(<Harness ids={["a"]} sig="1" />);
    height = 120;
    rerender(<Harness ids={["a"]} sig="2" />);
    expect(getByTestId("list").style.height).toBe("");
  });
});
