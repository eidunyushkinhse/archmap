// Пара хэндлов шага «Проведите связь» и точка шага «Перевесьте связь»: считаются тем
// же роутером стрелок, что и настоящие связи (buildAutoRoutes), по позициям и
// габаритам узлов уровня.
import { describe, it, expect, afterEach } from "vitest";
import { buildAutoRoutes } from "../../graph/layout/autoRoutes";
import { pickHandlePair, resolveRehang, type Box } from "../tourHandles";
import type { Edge } from "../../../types";

const side = (h: string) => h.split("--")[1];
const owner = (h: string) => h.split("--")[0];

describe("pickHandlePair", () => {
  it("объекты рядом по горизонтали — стороны смотрят друг на друга", () => {
    const boxes = new Map<string, Box>([
      ["p1", { x: 0, y: 0, w: 161, h: 84 }],
      ["s1", { x: 400, y: 0, w: 161, h: 84 }],
    ]);
    const pair = pickHandlePair("p1", "s1", boxes);
    expect(owner(pair.sourceHandle)).toBe("p1");
    expect(owner(pair.targetHandle)).toBe("s1");
    expect(side(pair.sourceHandle)).toBe("right");
    expect(side(pair.targetHandle)).toBe("left");
  });

  it("ровно то, что выбирает роутер для настоящей связи (стопка с узким зазором)", () => {
    // Сцена прототипа: «Покупатель» под системой, зазор меньше двух стабов.
    const boxes = new Map<string, Box>([
      ["s1", { x: 0, y: 0, w: 161, h: 84 }],
      ["p1", { x: 0, y: 102, w: 161, h: 84 }],
    ]);
    const pair = pickHandlePair("p1", "s1", boxes);
    const edge: Edge = { id: "e", label: null, technology: null, source_id: "p1", target_id: "s1", version: 1, created_at: "" };
    const real = buildAutoRoutes({
      groups: [{ id: "e", source: "p1", target: "s1", members: [edge] }],
      routableIds: new Set(["e"]),
      positions: new Map([...boxes].map(([id, b]) => [id, { x: b.x, y: b.y }])),
      displayIds: [...boxes.keys()],
      sizes: new Map([...boxes].map(([id, b]) => [id, { w: b.w, h: b.h }])),
    }).handles.get("e");
    expect(pair).toEqual(real);
  });
});

// Узел React Flow: абсолютная позиция в transform, габариты — offsetWidth/Height,
// прямоугольник на экране — getBoundingClientRect (масштаб 1, пан 0).
function rfNode(id: string, type: string, b: Box): HTMLElement {
  const el = document.createElement("div");
  el.className = `react-flow__node react-flow__node-${type}`;
  el.setAttribute("data-id", id);
  el.style.transform = `translate(${b.x}px, ${b.y}px)`;
  Object.defineProperty(el, "offsetWidth", { value: b.w });
  Object.defineProperty(el, "offsetHeight", { value: b.h });
  setRect(el, b);
  return el;
}
function setRect(el: Element, b: Box) {
  el.getBoundingClientRect = () => ({
    x: b.x, y: b.y, left: b.x, top: b.y, width: b.w, height: b.h, right: b.x + b.w, bottom: b.y + b.h, toJSON: () => ({}),
  });
}

describe("resolveRehang", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("конец стрелки на рамке и ОДНА точка на сервисе — та, куда роутер проведёт связь", () => {
    // Слой системы s1: гость «Банк» (p1) слева, сервис «Касса» (c1) в рамке справа,
    // связь p1 → рамка s1 упирается в её левый край.
    const flow = document.createElement("div");
    flow.className = "react-flow";
    const frame = rfNode("s1", "framedock", { x: 300, y: 0, w: 400, h: 300 });
    const peer = rfNode("p1", "ghost", { x: 0, y: 100, w: 161, h: 84 });
    const child = rfNode("c1", "block", { x: 420, y: 100, w: 161, h: 84 });
    flow.append(frame, peer, child);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const edge = document.createElementNS("http://www.w3.org/2000/svg", "g");
    edge.setAttribute("class", "react-flow__edge");
    edge.setAttribute("aria-label", "Edge from p1 to s1");
    const updater = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    updater.setAttribute("class", "react-flow__edgeupdater");
    setRect(updater, { x: 294, y: 136, w: 12, h: 12 });
    edge.append(updater);
    svg.append(edge);
    flow.append(svg);
    const boxes = new Map<string, Box>([
      ["p1", { x: 0, y: 100, w: 161, h: 84 }],
      ["c1", { x: 420, y: 100, w: 161, h: 84 }],
    ]);
    const { targetHandle } = pickHandlePair("p1", "c1", boxes);
    expect(side(targetHandle)).toBe("left");
    for (const h of ["c1--left--1", "c1--top--1", "c1--right--1"]) {
      const handle = document.createElement("div");
      handle.className = "react-flow__handle";
      handle.setAttribute("data-handleid", h);
      setRect(handle, h === targetHandle ? { x: 416, y: 138, w: 8, h: 8 } : { x: 600, y: 600, w: 8, h: 8 });
      child.append(handle);
    }
    document.body.append(flow);

    const res = resolveRehang("s1", "c1")!;
    expect(res.elements).toEqual([updater, child.querySelector(`[data-handleid="${targetHandle}"]`)]);
    expect(res.holes).toHaveLength(2);
    expect(res.holes[0]).toMatchObject({ shape: "rect", x: 284, y: 126 });
    expect(res.holes[1]).toMatchObject({ shape: "dot" });
    // без сервиса на холсте цели нет
    child.remove();
    expect(resolveRehang("s1", "c1")).toBeNull();
  });
});
