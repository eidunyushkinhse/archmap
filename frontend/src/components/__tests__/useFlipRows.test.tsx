// FLIP-переезд карточек. Высоту контейнера хук намеренно НЕ ведёт — её ведёт сам
// съезжающий блок (useCollapse); проверяется на инлайн-стилях, потому что в jsdom
// нет layout (rect всегда нулевой, геометрию подменяем).
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
    // rAF хук больше не использует (стартовое состояние применяется синхронно), но
    // заглушка оставлена: она ловила бы возврат к ненадёжному варианту.
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

    const b = getByText("b");
    expect(b.style.transition).toContain("transform");
    expect(b.style.transform).toBe("");

    // По окончании перехода инлайновые остатки снимаются: иначе следующая
    // перестройка ПОЕХАЛА БЫ к обратному сдвигу вместо мгновенной его постановки —
    // это и есть подёргивание на старте.
    const ev = new Event("transitionend");
    Object.defineProperty(ev, "propertyName", { value: "transform" });
    b.dispatchEvent(ev);
    expect(b.style.transition).toBe("");
  });

  it("prefers-reduced-motion выключает сдвиг", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const tops: Record<string, number> = { a: 0, b: 50 };
    stubRects((el) => ({ top: tops[el.dataset.flipId ?? ""] ?? 0, left: 0, height: 100 }));
    const { rerender, getByText } = render(<Harness ids={["a", "b"]} sig="1" />);
    tops.b = 10;
    rerender(<Harness ids={["a", "b"]} sig="2" />);
    expect(getByText("b").style.transition).toBe("");
  });
});
