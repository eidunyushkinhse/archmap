// Демонстрация перевеса на шаге «Перевесьте связь»: кадр цикла по времени и путь
// переносимой копии стрелки (как превью-линия холста при настоящем перевесе).
import { describe, it, expect } from "vitest";
import { DEMO_CYCLE_MS, GHOST_ALPHA, demoFrame, ghostPath, type RehangDemo } from "../tourDemo";

const DEMO: RehangDemo = {
  grab: { x: 100, y: 300 }, drop: { x: 140, y: 200 }, dropSide: "right",
  fixed: { x: 260, y: 240 }, fixedSide: "bottom", headAtFixed: false, zoom: 1,
};

describe("кадр демонстрации", () => {
  it("ладонь подлетает к концу стрелки на рамке и берёт его — копия стрелки появляется там же", () => {
    const start = demoFrame(0, DEMO);
    expect(start.hand.opacity).toBe(0);
    expect(start.ghost).toBeNull();
    const took = demoFrame(650, DEMO);
    expect(took.hand).toMatchObject({ x: 100, y: 300, closed: true, opacity: 1 });
    expect(took.ghost).toMatchObject({ x: 100, y: 300, snapped: false });
    expect(took.ripple).toMatchObject({ x: 100, y: 300 });
  });

  it("по дороге конец копии едет с ладонью, у точки защёлкивается на ней", () => {
    const mid = demoFrame(1400, DEMO);
    expect(mid.hand.closed).toBe(true);
    expect(mid.ghost).toMatchObject({ x: mid.hand.x, y: mid.hand.y, snapped: false, opacity: GHOST_ALPHA });
    expect(mid.hand.y).toBeLessThan(300);
    expect(mid.hand.y).toBeGreaterThan(200);
    const arrived = demoFrame(2200, DEMO);
    expect(arrived.hand).toMatchObject({ x: 140, y: 200, closed: true });
    expect(arrived.ghost).toMatchObject({ x: 140, y: 200, snapped: true });
  });

  it("ладонь отпускает и уходит, копия гаснет, дальше пауза и новый цикл", () => {
    const released = demoFrame(2700, DEMO);
    expect(released.hand.closed).toBe(false);
    expect(released.ghost).toMatchObject({ snapped: true, opacity: GHOST_ALPHA });
    const pause = demoFrame(4500, DEMO);
    expect(pause.hand.opacity).toBe(0);
    expect(pause.ghost).toBeNull();
    expect(pause.ripple).toBeNull();
    expect(demoFrame(DEMO_CYCLE_MS + 650, DEMO)).toEqual(demoFrame(650, DEMO));
  });

  it("копия полупрозрачна всегда", () => {
    for (let t = 0; t < DEMO_CYCLE_MS; t += 50) {
      const g = demoFrame(t, DEMO).ghost;
      if (g) expect(g.opacity).toBeLessThanOrEqual(GHOST_ALPHA);
    }
  });
});

describe("путь копии стрелки", () => {
  it("от неподвижного конца; свободный конец входит с противоположной ему стороны, защёлкнутый — со стороны точки", () => {
    const free = ghostPath(DEMO, { x: 120, y: 260 }, false);
    expect(free.startsWith("M260 240")).toBe(true);
    // неподвижный конец снизу — путь сначала идёт вниз
    expect(free).toMatch(/^M260 240L ?260,25\d/);
    // свободный конец входит сверху (как у React Flow без хэндла под курсором)
    expect(free).toMatch(/120,250L ?120 260$/);
    const snapped = ghostPath(DEMO, DEMO.drop, true);
    // точка справа на объекте — путь входит в неё справа налево
    expect(snapped).toMatch(/150,200L ?140 200$/);
  });
});
