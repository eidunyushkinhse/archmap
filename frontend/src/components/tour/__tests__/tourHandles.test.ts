// Шаги «Проведите связь» и «Перевесьте связь»: сторона считается тем же роутером
// стрелок, что и настоящие связи (buildAutoRoutes), по позициям и габаритам узлов
// уровня; откуда тянуть — стрелка-глиф или ручка конца, куда класть — сам объект-цель,
// ладонь-демо кладёт конец на его границу.
import { describe, it, expect, afterEach } from "vitest";
import { buildAutoRoutes } from "../../graph/layout/autoRoutes";
import { pickHandlePair, resolveHandlePair, resolveRehang, type Box } from "../tourHandles";
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

/** Хэндл стороны React Flow (невидимая точка на границе) со стрелкой-глифом внутри. */
function handleWithGlyph(id: string, at: Box, glyphAt: Box): HTMLElement {
  const handle = document.createElement("div");
  handle.className = "react-flow__handle";
  handle.setAttribute("data-handleid", id);
  setRect(handle, at);
  const glyph = document.createElement("button");
  glyph.className = "lg-side-arrow";
  setRect(glyph, glyphAt);
  handle.append(glyph);
  return handle;
}

describe("resolveHandlePair", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("стрелка-глиф у источника (круглый вырез), весь объект-цель (зона) и демонстрация до его границы", () => {
    // «Покупатель» p1 слева, система s1 справа: роутер поведёт связь вправо → влево.
    const flow = document.createElement("div");
    flow.className = "react-flow";
    const peer = rfNode("p1", "block", { x: 0, y: 100, w: 161, h: 84 });
    const sys = rfNode("s1", "block", { x: 400, y: 100, w: 161, h: 84 });
    // хэндл — 8px на границе в центре стороны; глиф — хитбокс 26×20 снаружи
    const srcHandle = handleWithGlyph("p1--right--1", { x: 157, y: 138, w: 8, h: 8 }, { x: 161, y: 132, w: 26, h: 20 });
    const tgtHandle = handleWithGlyph("s1--left--1", { x: 396, y: 138, w: 8, h: 8 }, { x: 374, y: 132, w: 26, h: 20 });
    peer.append(srcHandle);
    sys.append(tgtHandle);
    flow.append(peer, sys);
    document.body.append(flow);

    const res = resolveHandlePair("p1", "s1")!;
    const glyph = srcHandle.querySelector(".lg-side-arrow")!;
    expect(res.elements).toEqual([glyph, sys]);
    // круг вокруг стрелки (центр 174,142; диаметр 26 + поля 4) и весь объект-цель без пульса
    expect(res.holes[0]).toEqual({ x: 157, y: 125, w: 34, h: 34, shape: "dot" });
    expect(res.holes[1]).toEqual({ x: 394, y: 94, w: 173, h: 96, shape: "rect", quiet: true });
    // ладонь берёт стрелку, копия связи тянется от центра правой стороны «Покупателя» и
    // ложится на границу системы — центр её левой стороны, где конец защёлкнется
    expect(res.demo).toEqual({
      grab: { x: 174, y: 142 }, drop: { x: 400, y: 142 }, dropSide: "left",
      fixed: { x: 161, y: 142 }, fixedSide: "right", headAtFixed: false, zoom: 1,
    });
    // без объекта-цели на холсте цели нет
    sys.remove();
    expect(resolveHandlePair("p1", "s1")).toBeNull();
  });
});

describe("resolveRehang", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("конец стрелки на рамке и весь сервис; ладонь кладёт конец на его границу — туда, куда роутер проведёт связь", () => {
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
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", "react-flow__edge-path");
    path.setAttribute("d", "M 161,142 L 300,142");
    const updater = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    updater.setAttribute("class", "react-flow__edgeupdater");
    setRect(updater, { x: 294, y: 136, w: 12, h: 12 });
    edge.append(path, updater);
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
    expect(res.elements).toEqual([updater, child]);
    expect(res.holes).toHaveLength(2);
    expect(res.holes[0]).toMatchObject({ shape: "rect", x: 284, y: 126 });
    // зона — весь сервис, без пульса (холст принимает конец на его теле)
    expect(res.holes[1]).toEqual({ x: 414, y: 94, w: 173, h: 96, shape: "rect", quiet: true });
    // демонстрация: ладонь берёт конец на рамке и кладёт на границу сервиса — центр его
    // левой стороны (невидимый хэндл, куда конец защёлкнется), а не на стрелку-глиф
    // снаружи; копия стрелки тянется от правого края «Банка» — начала пути ребра
    expect(res.demo).toEqual({
      grab: { x: 300, y: 142 }, drop: { x: 420, y: 142 }, dropSide: "left",
      fixed: { x: 161, y: 142 }, fixedSide: "right", headAtFixed: false, zoom: 1,
    });
    // путь ребра не прочитать — цель та же, просто без демонстрации
    path.removeAttribute("d");
    expect(resolveRehang("s1", "c1")!.demo).toBeUndefined();
    // без сервиса на холсте цели нет
    child.remove();
    expect(resolveRehang("s1", "c1")).toBeNull();
  });
});
