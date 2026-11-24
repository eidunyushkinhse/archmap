// Прокрутка к блоку-цели шага «Не только схема» (раунд 5 обучения): блок встаёт верхом
// под шапку, когда раскладка страницы улеглась; прокрутку человека не перебивает.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCROLL_GAP, SectionScroll, scrollParent, scrollTopFor } from "../tourScroll";

/** Страница: окно прокрутки с верхом на 59 px (под шапкой), высотой 841 px, и блок в
 *  содержимом на offset px от его начала. Геометрию jsdom не считает — задаём её сами. */
function page(offset: number, content = 2114) {
  const box = document.createElement("div");
  box.style.overflowY = "auto";
  const block = document.createElement("div");
  box.appendChild(block);
  document.body.appendChild(box);
  const geo = { offset, content, scrollTop: 0 };
  Object.defineProperty(box, "scrollHeight", { get: () => geo.content });
  Object.defineProperty(box, "clientHeight", { get: () => 841 });
  Object.defineProperty(box, "scrollTop", { get: () => geo.scrollTop, set: (v: number) => { geo.scrollTop = v; } });
  const rect = (top: number) => ({ x: 0, y: top, left: 0, top, width: 800, height: 600, right: 800, bottom: top + 600, toJSON: () => ({}) });
  box.getBoundingClientRect = () => rect(59);
  block.getBoundingClientRect = () => rect(59 + geo.offset - geo.scrollTop);
  const scrollTo = vi.fn((opts: ScrollToOptions) => { geo.scrollTop = opts.top ?? geo.scrollTop; });
  box.scrollTo = scrollTo as unknown as typeof box.scrollTo;
  return { box, block, geo, scrollTo };
}

afterEach(() => { document.body.innerHTML = ""; });

describe("tourScroll", () => {
  it("окно прокрутки — ближайший прокручиваемый предок; нужная прокрутка — верх блока под шапкой с зазором", () => {
    const { box, block, geo } = page(972);
    expect(scrollParent(block)).toBe(box);
    expect(scrollTopFor(block, box)).toBe(972 - SCROLL_GAP);
    // дальше конца содержимого не прокрутить
    geo.content = 1200;
    expect(scrollTopFor(block, box)).toBe(1200 - 841);
    // прокручивать нечего — корень документа
    geo.content = 841;
    expect(scrollParent(block)).toBe(document.scrollingElement ?? document.documentElement);
  });

  it("раскладка ещё идёт — ждём; улеглась — одна прокрутка, страница встала", () => {
    const { block, geo, scrollTo } = page(400);
    const s = new SectionScroll(true);
    expect(s.frame(0, block)).toBe(false);
    geo.offset = 700; // дорисовалась схема выше блока
    expect(s.frame(100, block)).toBe(false);
    geo.offset = 972;
    expect(s.frame(200, block)).toBe(false);
    expect(s.frame(450, block)).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(s.frame(520, block)).toBe(false); // 320 мс без сдвига — прокрутка
    expect(s.frame(540, block)).toBe(true); // доехала — страница встала
    expect(scrollTo).toHaveBeenCalledOnce();
    expect(scrollTo).toHaveBeenCalledWith({ top: 972 - SCROLL_GAP, behavior: "smooth" });
    expect(geo.scrollTop).toBe(960);
  });

  it("плавная прокрутка в пути — не перезапускается и страница ещё не встала", () => {
    const { block, scrollTo, box } = page(972);
    box.scrollTo = scrollTo.mockImplementation(() => {}) as unknown as typeof box.scrollTo;
    const s = new SectionScroll(false);
    s.frame(0, block);
    expect(s.frame(350, block)).toBe(false);
    expect(s.frame(400, block)).toBe(false);
    expect(scrollTo).toHaveBeenCalledOnce();
    expect(scrollTo).toHaveBeenCalledWith({ top: 960, behavior: "auto" });
  });

  it("встала — прокрутку человека не перебивает; сдвиг раскладки догоняет", () => {
    const { block, geo, scrollTo } = page(972);
    const s = new SectionScroll(true);
    s.frame(0, block);
    expect(s.frame(400, block)).toBe(false);
    expect(s.frame(420, block)).toBe(true);
    geo.scrollTop = 200; // человек прокрутил сам
    expect(s.frame(800, block)).toBe(true);
    expect(s.frame(1200, block)).toBe(true);
    expect(scrollTo).toHaveBeenCalledOnce();
    geo.offset = 1100; // раздел выше дорисовался — блок уехал вниз
    s.frame(1300, block);
    expect(s.frame(1700, block)).toBe(true);
    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect(geo.scrollTop).toBe(1100 - SCROLL_GAP);
  });

  it("раскладка так и не улеглась — через 2,5 с страница считается вставшей", () => {
    const { block, geo, scrollTo } = page(400);
    const s = new SectionScroll(true);
    for (let t = 0; t < 2500; t += 100) {
      geo.offset += 10;
      expect(s.frame(t, block)).toBe(false);
    }
    expect(s.frame(2600, block)).toBe(true);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
