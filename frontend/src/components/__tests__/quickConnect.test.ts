import { describe, it, expect } from "vitest";
import { findQuickConnectTarget, type QcNode } from "../graph/interaction/quickConnect";
import { NODE_W, NODE_H } from "../graph/constants";

// Источник стоит в (0,0); правый хэндл середины → якорь (NODE_W, NODE_H/2).
const SRC: QcNode = { id: "S", x: 0, y: 0 };

describe("findQuickConnectTarget", () => {
  it("узел справа в одном ряду — цель найдена, входит слева", () => {
    const right: QcNode = { id: "R", x: NODE_W + 120, y: 0 };
    const res = findQuickConnectTarget("S", "right", 0.5, SRC, [right]);
    expect(res?.targetId).toBe("R");
    expect(res?.targetSide).toBe("left");
    expect(res?.targetHandle.startsWith("R--left--")).toBe(true);
  });

  it("узел слишком далеко справа — не предлагаем (никаких километровых стрелок)", () => {
    const far: QcNode = { id: "F", x: NODE_W + NODE_W * 3, y: 0 };
    expect(findQuickConnectTarget("S", "right", 0.5, SRC, [far])).toBeNull();
  });

  it("узел сильно смещён по вертикали — вне коридора правого хэндла", () => {
    const offRow: QcNode = { id: "O", x: NODE_W + 120, y: NODE_H * 3 };
    expect(findQuickConnectTarget("S", "right", 0.5, SRC, [offRow])).toBeNull();
  });

  it("узел за спиной (слева от правого хэндла) — не цель", () => {
    const behind: QcNode = { id: "B", x: -NODE_W - 120, y: 0 };
    expect(findQuickConnectTarget("S", "right", 0.5, SRC, [behind])).toBeNull();
  });

  it("из нескольких кандидатов берём ближний и ровный", () => {
    const near: QcNode = { id: "N", x: NODE_W + 80, y: 0 };
    const farther: QcNode = { id: "Z", x: NODE_W + 300, y: 0 };
    const res = findQuickConnectTarget("S", "right", 0.5, SRC, [farther, near]);
    expect(res?.targetId).toBe("N");
  });

  it("нижний хэндл → ищем узел снизу, вход сверху", () => {
    const below: QcNode = { id: "D", x: 0, y: NODE_H + 120 };
    const res = findQuickConnectTarget("S", "bottom", 0.5, SRC, [below]);
    expect(res?.targetId).toBe("D");
    expect(res?.targetSide).toBe("top");
  });

  it("сам источник в кандидатах игнорируется", () => {
    expect(findQuickConnectTarget("S", "right", 0.5, SRC, [SRC])).toBeNull();
  });

  it("путь превью выходит из якоря источника и приходит в якорь цели", () => {
    const right: QcNode = { id: "R", x: NODE_W + 120, y: 0 };
    const res = findQuickConnectTarget("S", "right", 0.5, SRC, [right]);
    expect(res?.points[0]).toEqual(res?.sourcePoint);
    expect(res?.points[res.points.length - 1]).toEqual(res?.targetPoint);
  });
});
