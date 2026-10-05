// Поиск цели в DOM: видимая цель даёт вырез, цель за краем холста или ниже сгиба
// страницы подводится в вид («вписать схему» React Flow или прокрутка).
import { describe, it, expect, vi, afterEach } from "vitest";
import { hiddenTarget, resolveTarget, revealTarget, type TargetCtx } from "../tourTargets";

const CTX: TargetCtx = {
  yarProjectId: "aaaa-0001",
  yarObjects: new Map([["Продавец", "c0de-01"], ["Сервис заказов", "c0de-03"]]),
  vars: {},
};

function el(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}
function withRect(node: Element, r: { x: number; y: number; w: number; h: number }) {
  node.getBoundingClientRect = () => ({
    x: r.x, y: r.y, left: r.x, top: r.y, width: r.w, height: r.h, right: r.x + r.w, bottom: r.y + r.h, toJSON: () => ({}),
  });
}

afterEach(() => { document.body.innerHTML = ""; });

describe("цель шага в DOM", () => {
  it("видимая секция — вырез с полями; невидимой нет", () => {
    const host = el('<div data-tour="node-logic"></div>');
    const sec = host.firstElementChild!;
    expect(resolveTarget({ kind: "tour", key: "node-logic" }, CTX)).toBeNull();
    withRect(sec, { x: 100, y: 200, w: 300, h: 100 });
    const res = resolveTarget({ kind: "tour", key: "node-logic" }, CTX)!;
    expect(res.holes).toEqual([{ x: 94, y: 194, w: 312, h: 112, shape: "rect" }]);
    expect(res.elements).toEqual([sec]);
  });

  it("секция ниже сгиба — прокрутка к ней", () => {
    const host = el('<div data-tour="node-logic"></div>');
    const sec = host.firstElementChild as HTMLElement;
    withRect(sec, { x: 100, y: 5000, w: 300, h: 100 });
    expect(hiddenTarget({ kind: "tour", key: "node-logic" }, CTX)).toBe(sec);
    const spy = vi.fn();
    sec.scrollIntoView = spy;
    revealTarget(sec);
    expect(spy).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
  });

  it("узел холста за краем пана — «вписать схему» этого холста", () => {
    const host = el(
      '<div class="react-flow"><div class="react-flow__node" data-id="c0de-01"></div>'
      + '<button class="react-flow__controls-fitview"></button></div>',
    );
    const node = host.querySelector(".react-flow__node")!;
    withRect(node, { x: 4000, y: 4000, w: 160, h: 80 });
    const fit = vi.fn();
    host.querySelector("button")!.addEventListener("click", fit);
    const hidden = hiddenTarget({ kind: "yar-node", name: "Продавец" }, CTX);
    expect(hidden).toBe(node);
    revealTarget(hidden!);
    expect(fit).toHaveBeenCalledOnce();
  });

  it("видимую цель подводить не нужно", () => {
    const host = el('<div class="react-flow__node" data-id="c0de-01"></div>');
    withRect(host.firstElementChild!, { x: 10, y: 10, w: 160, h: 80 });
    expect(hiddenTarget({ kind: "yar-node", name: "Продавец" }, CTX)).toBeNull();
  });
});

describe("составные цели", () => {
  it("два выреза: с чем работать — пульсирует, зона — без пульса, карточку к первому", () => {
    const host = el('<div data-tour="palette:service"></div><div class="react-flow"></div>');
    withRect(host.querySelector('[data-tour="palette:service"]')!, { x: 20, y: 600, w: 200, h: 40 });
    const target = { kind: "pair", main: { kind: "tour", key: "palette:service" }, zone: { kind: "canvas" } } as const;
    // холста ещё нет — только палитра
    expect(resolveTarget(target, CTX)!.holes).toHaveLength(1);
    // (окно jsdom — 1024×768: вырез не шире видимой части)
    withRect(host.querySelector(".react-flow")!, { x: 260, y: 60, w: 700, h: 600 });
    const res = resolveTarget(target, CTX)!;
    expect(res.holes).toEqual([
      { x: 14, y: 594, w: 212, h: 52, shape: "rect" },
      { x: 254, y: 54, w: 712, h: 612, shape: "rect", quiet: true },
    ]);
    expect(res.anchor).toEqual(res.holes[0]);
    expect(res.soft).toEqual([res.holes[1]]);
    // без палитры цели нет, даже если холст на месте
    host.querySelector('[data-tour="palette:service"]')!.remove();
    expect(resolveTarget(target, CTX)).toBeNull();
  });

  it("рамка системы — зона второго выреза", () => {
    const host = el('<div data-tour="palette:service"></div><div class="react-flow__node" data-id="s1"></div>');
    withRect(host.querySelector('[data-tour="palette:service"]')!, { x: 20, y: 600, w: 200, h: 40 });
    withRect(host.querySelector('[data-id="s1"]')!, { x: 400, y: 200, w: 500, h: 300 });
    const res = resolveTarget(
      { kind: "pair", main: { kind: "tour", key: "palette:service" }, zone: { kind: "system" } },
      { ...CTX, vars: { systemId: "s1" } },
    )!;
    expect(res.holes[1]).toMatchObject({ x: 394, y: 194, quiet: true });
  });

  it("строка дерева по имени объекта: шеврон и строка", () => {
    const host = el('<div data-tour="tree-row:c0de-03"><button data-tour="tree-chev:c0de-03"></button></div>');
    withRect(host.querySelector("button")!, { x: 10, y: 300, w: 26, h: 28 });
    withRect(host.firstElementChild!, { x: 10, y: 300, w: 240, h: 28 });
    const chev = resolveTarget({ kind: "yar-tree", name: "Сервис заказов", part: "chevron" }, CTX)!;
    expect(chev.elements).toEqual([host.querySelector("button")]);
    const row = resolveTarget({ kind: "yar-tree", name: "Сервис заказов", part: "row" }, CTX)!;
    expect(row.elements).toEqual([host.firstElementChild]);
    expect(resolveTarget({ kind: "yar-tree", name: "Продавец", part: "row" }, CTX)).toBeNull();
  });

  it("диаграмма контекста — один вырез вокруг обоих объектов и связи", () => {
    const host = el(
      '<div class="react-flow__node" data-id="s1"></div><div class="react-flow__node" data-id="p1"></div>'
      + '<svg><g class="react-flow__edge" data-id="e1" aria-label="Edge from p1 to s1"></g></svg>',
    );
    withRect(host.querySelector('[data-id="s1"]')!, { x: 400, y: 100, w: 160, h: 84 });
    withRect(host.querySelector('[data-id="p1"]')!, { x: 400, y: 400, w: 160, h: 84 });
    withRect(host.querySelector(".react-flow__edge")!, { x: 470, y: 184, w: 20, h: 216 });
    const ctx = { ...CTX, vars: { systemId: "s1", peerId: "p1" } };
    const res = resolveTarget({ kind: "context-diagram" }, ctx)!;
    expect(res.holes).toEqual([{ x: 394, y: 94, w: 172, h: 396, shape: "rect" }]);
    // связи ещё нет — цели нет
    host.querySelector(".react-flow__edge")!.remove();
    expect(resolveTarget({ kind: "context-diagram" }, ctx)).toBeNull();
  });

  it("после лупы — вырез вокруг связи и сервиса внутри системы", () => {
    const host = el(
      '<div class="react-flow__node" data-id="c1"></div>'
      + '<svg><g class="react-flow__edge" data-id="e1" aria-label="Edge from p1 to c1"></g></svg>',
    );
    withRect(host.querySelector('[data-id="c1"]')!, { x: 400, y: 100, w: 160, h: 84 });
    withRect(host.querySelector(".react-flow__edge")!, { x: 470, y: 184, w: 20, h: 216 });
    const res = resolveTarget({ kind: "inside" }, { ...CTX, vars: { systemId: "s1", peerId: "p1", childId: "c1" } })!;
    expect(res.holes).toEqual([{ x: 394, y: 94, w: 172, h: 312, shape: "rect" }]);
  });
});
