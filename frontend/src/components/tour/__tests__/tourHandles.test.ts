// Пара хэндлов шага «Проведите связь»: считается тем же роутером стрелок, что и
// настоящие связи (buildAutoRoutes), по позициям и габаритам узлов уровня.
import { describe, it, expect } from "vitest";
import { buildAutoRoutes } from "../../graph/layout/autoRoutes";
import { pickHandlePair, type Box } from "../tourHandles";
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
