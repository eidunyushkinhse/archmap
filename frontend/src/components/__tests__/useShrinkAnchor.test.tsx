// Удержание скролла при сжатии содержимого.
//
// Сценарий: страница внизу, пользователь свернул раскрывашку — страница стала короче,
// браузер упёр скролл в новый конец, и всё уехало из-под курсора. Хук добавляет снизу
// ровно недостающую пустоту и возвращает позицию, а пустота тает при прокрутке вверх.
// В jsdom нет layout, поэтому геометрию контейнера задаём вручную.
import { act, render } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useShrinkAnchor } from "../useShrinkAnchor";

// Контейнер прокрутки с управляемой геометрией.
function makeScroller(): { el: HTMLDivElement; setContent: (h: number) => void } {
  const el = document.createElement("div");
  let content = 0;
  Object.defineProperty(el, "clientHeight", { get: () => 400 });
  Object.defineProperty(el, "scrollHeight", {
    get: () => content + (parseFloat(el.style.paddingBottom) || 0),
  });
  let top = 0;
  Object.defineProperty(el, "scrollTop", {
    get: () => top,
    // Браузер зажимает скролл концом содержимого — воспроизводим это, иначе тест
    // проверял бы не ту механику.
    set: (v: number) => { top = Math.max(0, Math.min(v, el.scrollHeight - el.clientHeight)); },
  });
  return { el, setContent: (h) => { content = h; el.scrollTop = top; } };
}

function Harness({ onReady }: { onReady: (hold: (el: HTMLElement | null) => void) => void }) {
  const hold = useShrinkAnchor();
  onReady(hold);
  return null;
}

describe("useShrinkAnchor", () => {
  let rafs: FrameRequestCallback[] = [];
  beforeEach(() => {
    rafs = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { rafs.push(cb); return 0; });
    vi.stubGlobal("getComputedStyle", (el: Element) => ({
      overflowY: el === scroller?.el ? "auto" : "visible",
      paddingBottom: (el as HTMLElement).style.paddingBottom || "0px",
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  let scroller: ReturnType<typeof makeScroller> | null = null;

  function setup() {
    scroller = makeScroller();
    document.body.appendChild(scroller.el);
    const inner = document.createElement("button");
    scroller.el.appendChild(inner);
    let hold: (el: HTMLElement | null) => void = () => undefined;
    render(<Harness onReady={(h) => { hold = h; }} />);
    return { sc: scroller, inner, hold: (el: HTMLElement) => hold(el) };
  }

  it("добавляет ровно недостающую пустоту и возвращает позицию", () => {
    const { sc, inner, hold } = setup();
    sc.setContent(1000);
    sc.el.scrollTop = 600; // в самом низу: 1000 − 400
    hold(inner);
    sc.setContent(800); // раскрывашку свернули — страница короче на 200

    expect(sc.el.scrollTop).toBe(400); // браузер уже подтянул скролл вверх
    act(() => { rafs.forEach((cb) => cb(0)); });
    expect(sc.el.style.paddingBottom).toBe("200px");
    expect(sc.el.scrollTop).toBe(600); // позиция вернулась — ничего не уехало
  });

  it("пустота тает при прокрутке вверх и исчезает совсем", () => {
    const { sc, inner, hold } = setup();
    sc.setContent(1000);
    sc.el.scrollTop = 600;
    hold(inner);
    sc.setContent(800);
    act(() => { rafs.forEach((cb) => cb(0)); });

    sc.el.scrollTop = 500;
    sc.el.dispatchEvent(new Event("scroll"));
    expect(sc.el.style.paddingBottom).toBe("100px");

    sc.el.scrollTop = 350;
    sc.el.dispatchEvent(new Event("scroll"));
    // Пустоты больше нет — вернуться вниз и увидеть её невозможно.
    expect(sc.el.style.paddingBottom).toBe("");
  });

  it("если места внизу хватает, ничего не добавляется", () => {
    const { sc, inner, hold } = setup();
    const listen = vi.spyOn(sc.el, "addEventListener");
    sc.setContent(1000);
    sc.el.scrollTop = 100; // до конца далеко
    hold(inner);
    sc.setContent(900);
    act(() => { rafs.forEach((cb) => cb(0)); });
    expect(sc.el.style.paddingBottom).toBe("");
    // И слушателя нет: отрицательная пустота стилем всё равно не применится, так что
    // проверка одного paddingBottom не отличила бы «не понадобилось» от «посчитали
    // мусор» (поймано фальсификацией).
    expect(listen.mock.calls.some(([type]) => type === "scroll")).toBe(false);
  });
});
