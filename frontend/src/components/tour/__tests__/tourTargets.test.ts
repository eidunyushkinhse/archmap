// Поиск цели в DOM: видимая цель даёт вырез, цель за краем холста или ниже сгиба
// страницы подводится в вид («вписать схему» React Flow или прокрутка).
import { describe, it, expect, vi, afterEach } from "vitest";
import { hiddenTarget, resolveTarget, revealTarget, type TargetCtx } from "../tourTargets";

const CTX: TargetCtx = { yarProjectId: "aaaa-0001", yarObjects: new Map([["Продавец", "c0de-01"]]), vars: {} };

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
