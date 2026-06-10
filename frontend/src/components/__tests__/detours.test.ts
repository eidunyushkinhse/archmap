import { describe, it, expect } from "vitest";
import { computeDetours } from "../graph/layout/detours";
import { NODE_W, NODE_H, hid } from "../graph/constants";
import type { EdgeGroup } from "../graph/types";
import type { Edge as AppEdge, EdgePoint } from "../../types";

// Юнит-тесты дефолтных обводов гостевых стрелок (R4, шаг 2). Чистая функция, без ELK.
// Значения DETOUR_MARGIN/DETOUR_STEP приватны для модуля — здесь зеркалим как
// ожидаемые наблюдаемые величины (clearY).
const DETOUR_MARGIN = 44;
const DETOUR_STEP = 30;

function edge(id: string, source_id: string, target_id: string, extra: Partial<AppEdge> = {}): AppEdge {
  return {
    id, label: null, technology: null, source_id, target_id,
    source_handle: null, target_handle: null, created_at: "2026-06-10T00:00:00Z",
    ...extra,
  };
}
function group(id: string, source: string, target: string, members: AppEdge[]): EdgeGroup {
  return { id, source, target, members };
}

// Базовая геометрия: локальный L(0,0), вынесенный гость G(1000,0) — прямой маршрут
// между ними по y=50 проходит сквозь препятствие M(400,0). Рамка {0,0,190,100}.
function obstacleSetup() {
  const positions = new Map([
    ["L", { x: 0, y: 0 }],
    ["G", { x: 1000, y: 0 }],
    ["M", { x: 400, y: 0 }],
  ]);
  return {
    groupArr: [group("g", "L", "G", [edge("g", "L", "G")])],
    placedOutside: new Set(["G"]),
    frame: { minX: 0, minY: 0, maxX: NODE_W, maxY: NODE_H },
    localIds: new Set(["L"]),
    displayIds: ["L", "G", "M"],
    positions,
    levelEdgeWaypoints: {} as Record<string, EdgePoint[]>,
    levelEdgeHandles: {} as Record<string, string[]>,
  };
}

describe("computeDetours — когда обвод НЕ нужен", () => {
  it("прямой маршрут чист (нет препятствий) → ребро не тронуто", () => {
    const s = obstacleSetup();
    s.displayIds = ["L", "G"]; // убрали препятствие M
    const { handles, detours } = computeDetours(s);
    expect(handles.size).toBe(0);
    expect(detours.size).toBe(0);
  });

  it("ребро гость↔гость (оба в placedOutside) → не тронуто", () => {
    const positions = new Map([
      ["G1", { x: 0, y: 0 }],
      ["G2", { x: 1000, y: 0 }],
      ["M", { x: 400, y: 0 }],
    ]);
    const { handles, detours } = computeDetours({
      groupArr: [group("g", "G1", "G2", [edge("g", "G1", "G2")])],
      placedOutside: new Set(["G1", "G2"]),
      frame: { minX: 0, minY: 0, maxX: NODE_W, maxY: NODE_H },
      localIds: new Set<string>(),
      displayIds: ["G1", "G2", "M"],
      positions,
      levelEdgeWaypoints: {}, levelEdgeHandles: {},
    });
    expect(handles.size).toBe(0);
    expect(detours.size).toBe(0);
  });
});

describe("computeDetours — обвод нужен", () => {
  it("маршрут пересекает чужой узел → обвод: хэндлы top, clearY = верх контента − DETOUR_MARGIN", () => {
    const s = obstacleSetup();
    const { handles, detours } = computeDetours(s);
    // локальный конец L: центр y=50 ≤ frameMid(50) → сторона top
    expect(handles.get("g")).toEqual({
      sourceHandle: hid("L", "top", 1),
      targetHandle: hid("G", "top", 1),
    });
    // topBase = oMinY(0) − DETOUR_MARGIN; первый обвод (кольцо 0)
    expect(detours.get("g")).toEqual({ clearY: 0 - DETOUR_MARGIN });
  });

  it("локальный конец ниже середины рамки → сторона bottom, clearY = низ контента + DETOUR_MARGIN", () => {
    // L ниже: центр y=250 > frameMid(200) → bottom
    const positions = new Map([
      ["L", { x: 0, y: 200 }],
      ["G", { x: 1000, y: 200 }],
      ["M", { x: 400, y: 200 }],
    ]);
    const { handles, detours } = computeDetours({
      groupArr: [group("g", "L", "G", [edge("g", "L", "G")])],
      placedOutside: new Set(["G"]),
      frame: { minX: 0, minY: 0, maxX: NODE_W, maxY: 400 },
      localIds: new Set(["L"]),
      displayIds: ["L", "G", "M"],
      positions,
      levelEdgeWaypoints: {}, levelEdgeHandles: {},
    });
    expect(handles.get("g")).toEqual({
      sourceHandle: hid("L", "bottom", 1),
      targetHandle: hid("G", "bottom", 1),
    });
    // oMaxY = max(frame.maxY=400, G.y+NODE_H=300) = 400; botBase = 400 + DETOUR_MARGIN
    expect(detours.get("g")).toEqual({ clearY: 400 + DETOUR_MARGIN });
  });

  it("два обвода одной стороны → второй дальше на DETOUR_STEP (кольца)", () => {
    const positions = new Map([
      ["L", { x: 0, y: 0 }],
      ["G1", { x: 1000, y: 0 }],
      ["G2", { x: 1000, y: 200 }],
      ["M", { x: 400, y: 0 }],
    ]);
    const { detours } = computeDetours({
      groupArr: [
        group("gA", "L", "G1", [edge("gA", "L", "G1")]),
        group("gB", "L", "G2", [edge("gB", "L", "G2")]),
      ],
      placedOutside: new Set(["G1", "G2"]),
      frame: { minX: 0, minY: 0, maxX: NODE_W, maxY: NODE_H },
      localIds: new Set(["L"]),
      displayIds: ["L", "G1", "G2", "M"],
      positions,
      levelEdgeWaypoints: {}, levelEdgeHandles: {},
    });
    // оба сверху (локальный конец L один и тот же); topBase = 0 − 44
    const a = detours.get("gA")!.clearY, b = detours.get("gB")!.clearY;
    expect(a).toBe(0 - DETOUR_MARGIN);
    expect(b).toBe(0 - DETOUR_MARGIN - DETOUR_STEP);
    expect(a - b).toBe(DETOUR_STEP);
  });
});

describe("computeDetours — ручные правки не трогаются", () => {
  it("waypoints у члена ребра → обвод не навязывается", () => {
    const s = obstacleSetup();
    s.groupArr = [group("g", "L", "G", [edge("g", "L", "G", { waypoints: [{ x: 1, y: 2 }] })])];
    const { handles, detours } = computeDetours(s);
    expect(handles.size).toBe(0);
    expect(detours.size).toBe(0);
  });

  it("levelEdgeWaypoints по id члена → не трогаем", () => {
    const s = obstacleSetup();
    s.levelEdgeWaypoints = { g: [{ x: 1, y: 2 }] };
    const { detours } = computeDetours(s);
    expect(detours.size).toBe(0);
  });

  it("levelEdgeHandles по id члена → не трогаем", () => {
    const s = obstacleSetup();
    s.levelEdgeHandles = { g: ["G--left--1"] };
    const { detours } = computeDetours(s);
    expect(detours.size).toBe(0);
  });
});
