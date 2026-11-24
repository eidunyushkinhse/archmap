// Вид схемы для чтения и колесо (components/usePanZoom.ts; редизайн, фаза 7а). Схему
// открывают, чтобы прочитать: при открытии текст не мельче 0,9 от натурального, высокая
// схема стоит верхом у поля; колесо прокручивает, а не масштабирует, и не уводит схему за
// края; Ctrl или ⌘ с колесом масштабирует к курсору. Правило одно для всех потребителей
// хука: чтение схемы, превью при правке, ER-диаграмма, документ в вопросах слияния.
import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";
import { readingView, usePanZoom, wheelAxis, wheelPan } from "../usePanZoom";

// Сцена 1000×800, поля 24: место под схему 952×752.
const stage = { cw: 1000, ch: 800 };

describe("readingView: вид при открытии для чтения", () => {
  it("схема помещается целиком: по центру, не крупнее 100%", () => {
    expect(readingView({ ...stage, bw: 200, bh: 100 })).toEqual({ x: 400, y: 350, scale: 1 });
  });

  it("помещается в масштабе от 0,9 до 1: этот масштаб, по центру", () => {
    // Высота решает: 752 / 800 = 0,94.
    const v = readingView({ ...stage, bw: 400, bh: 800 });
    expect(v.scale).toBeCloseTo(0.94);
    expect(v.x).toBeCloseTo((1000 - 400 * 0.94) / 2);
    expect(v.y).toBeCloseTo(24);
  });

  it("высокая схема: масштаб 1, по центру по горизонтали, верх у поля", () => {
    expect(readingView({ ...stage, bw: 500, bh: 3000 })).toEqual({ x: 250, y: 24, scale: 1 });
  });

  it("широкая схема: масштаб 0,9, левый край и верх у полей", () => {
    expect(readingView({ ...stage, bw: 3000, bh: 100 })).toEqual({ x: 24, y: 24, scale: 0.9 });
  });

  it("высокая и широкая, по ширине уже от 0,9: масштаб по ширине, верх у поля", () => {
    // 952 / 1000 = 0,952: по ширине влезает ровно в место с полями.
    const v = readingView({ ...stage, bw: 1000, bh: 3000 });
    expect(v.scale).toBeCloseTo(0.952);
    expect(v.x).toBeCloseTo(24);
    expect(v.y).toBe(24);
  });

  it("ровно 0,9 по ширине — ещё не меньше 0,9", () => {
    const v = readingView({ ...stage, bw: 952 / 0.9, bh: 3000 });
    expect(v.scale).toBeCloseTo(0.9);
    expect(v.x).toBeCloseTo(24);
  });
});

describe("wheelAxis: колесо по одной оси", () => {
  it("схема помещается в сцену: колесо её не двигает", () => {
    expect(wheelAxis(350, 300, 100, 800)).toBe(350);
    expect(wheelAxis(350, -300, 100, 800)).toBe(350);
  });

  it("высокая схема: вниз двигает, в начале вверх не двигает", () => {
    // Схема 3000 в сцене 800: верх у поля (24).
    expect(wheelAxis(24, 300, 3000, 800)).toBe(-276);
    expect(wheelAxis(24, -300, 3000, 800)).toBe(24);
  });

  it("край схемы не отходит от края сцены дальше поля", () => {
    // Низ схемы может подняться только до 800 − 24: pos ≥ 800 − 24 − 3000 = −2224.
    expect(wheelAxis(-2100, 300, 3000, 800)).toBe(-2224);
    expect(wheelAxis(-2224, 300, 3000, 800)).toBe(-2224);
    expect(wheelAxis(-100, -300, 3000, 800)).toBe(24);
  });

  it("схему, уведённую за поле перетаскиванием, колесо назад не дёргает", () => {
    expect(wheelAxis(200, -50, 3000, 800)).toBe(200);
    expect(wheelAxis(200, 50, 3000, 800)).toBe(150);
  });

  it("wheelPan считает размер схемы в текущем масштабе", () => {
    const size = { cw: 1000, ch: 800, bw: 500, bh: 1000 };
    // В масштабе 0,5 схема 250×500 помещается: не двигается.
    expect(wheelPan({ x: 375, y: 150, scale: 0.5 }, 0, 300, size)).toEqual({ x: 375, y: 150, scale: 0.5 });
    // В масштабе 1 высота 1000 не помещается: прокрутка вниз.
    expect(wheelPan({ x: 250, y: 24, scale: 1 }, 0, 100, size)).toEqual({ x: 250, y: -76, scale: 1 });
  });
});

// ── хук на DOM ─────────────────────────────────────────────────────────────
// jsdom раскладку не считает: размеры сцены задаём свойствами элемента, а прямоугольник
// схемы считаем из текущего transform обёртки (как его видел бы браузер).
function Harness({ bw, bh, cw = 1000, ch = 800 }: { bw: number; bh: number; cw?: number; ch?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pz = usePanZoom(box, content);
  return (
    <div
      data-testid="stage"
      ref={(el) => {
        box.current = el;
        if (!el) return;
        Object.defineProperty(el, "clientWidth", { configurable: true, value: cw });
        Object.defineProperty(el, "clientHeight", { configurable: true, value: ch });
        el.getBoundingClientRect = () => ({ left: 0, top: 0, x: 0, y: 0, width: cw, height: ch, right: cw, bottom: ch, toJSON: () => null });
      }}
    >
      <div
        data-testid="content"
        style={pz.style}
        ref={(el) => {
          content.current = el;
          if (!el) return;
          el.getBoundingClientRect = () => {
            const s = Number(/scale\(([\d.]+)\)/.exec(el.style.transform)?.[1] ?? 1);
            return { left: 0, top: 0, x: 0, y: 0, width: bw * s, height: bh * s, right: bw * s, bottom: bh * s, toJSON: () => null };
          };
        }}
      />
      <button type="button" onClick={pz.fitInitial}>для чтения</button>
      <button type="button" onClick={pz.fit}>вписать</button>
    </div>
  );
}

const transform = () => (screen.getByTestId("content") as HTMLElement).style.transform;
const wheel = (init: WheelEventInit) => fireEvent.wheel(screen.getByTestId("stage"), init);

describe("usePanZoom: колесо прокручивает, Ctrl с колесом масштабирует", () => {
  it("высокая схема: открытие верхом у поля, колесо вниз сдвигает, масштаб тот же", () => {
    render(<Harness bw={500} bh={3000} />);
    fireEvent.click(screen.getByText("для чтения"));
    expect(transform()).toBe("translate(250px, 24px) scale(1)");
    // Вверх в исходном положении — ничего.
    wheel({ deltaY: -300 });
    expect(transform()).toBe("translate(250px, 24px) scale(1)");
    wheel({ deltaY: 300 });
    expect(transform()).toBe("translate(250px, -276px) scale(1)");
  });

  it("колесо над сценой гасится всегда, и у края тоже: страница под окном стоит", () => {
    render(<Harness bw={200} bh={100} />);
    fireEvent.click(screen.getByText("для чтения"));
    expect(wheel({ deltaY: 300 })).toBe(false);
    expect(transform()).toBe("translate(400px, 350px) scale(1)");
  });

  it("Ctrl и ⌘ с колесом масштабируют к курсору", () => {
    render(<Harness bw={500} bh={3000} />);
    fireEvent.click(screen.getByText("для чтения"));
    wheel({ deltaY: -100, ctrlKey: true, clientX: 250, clientY: 24 });
    expect(transform()).toBe("translate(250px, 24px) scale(1.15)");
    wheel({ deltaY: 100, metaKey: true, clientX: 250, clientY: 24 });
    expect(transform()).toMatch(/translate\(250px, 24px\) scale\(1(\.0+\d*)?\)/);
  });

  it("широкая схема: Shift с колесом двигает вбок и встаёт у правого края", () => {
    render(<Harness bw={3000} bh={100} />);
    fireEvent.click(screen.getByText("для чтения"));
    expect(transform()).toBe("translate(24px, 24px) scale(0.9)");
    wheel({ deltaY: 500, shiftKey: true });
    expect(transform()).toBe("translate(-476px, 24px) scale(0.9)");
    // Правый край у поля: x = 1000 − 24 − 2700 = −1724.
    for (let i = 0; i < 10; i++) wheel({ deltaY: 500, shiftKey: true });
    expect(transform()).toBe("translate(-1724px, 24px) scale(0.9)");
    // Тачпад присылает deltaX сам.
    wheel({ deltaX: -200 });
    expect(transform()).toBe("translate(-1524px, 24px) scale(0.9)");
  });

  it("строки колеса (deltaMode 1) переводятся в пиксели", () => {
    render(<Harness bw={500} bh={3000} />);
    fireEvent.click(screen.getByText("для чтения"));
    wheel({ deltaY: 3, deltaMode: 1 });
    expect(transform()).toBe("translate(250px, -24px) scale(1)");
  });

  it("«Вписать» показывает схему целиком", () => {
    render(<Harness bw={500} bh={3000} />);
    fireEvent.click(screen.getByText("для чтения"));
    fireEvent.click(screen.getByText("вписать"));
    // 752 / 3000 = 0,2507: целиком по высоте, по центру.
    expect(transform()).toMatch(/scale\(0\.25/);
  });
});
