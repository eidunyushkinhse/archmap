import { describe, it, expect } from "vitest";
import { placeGhostsOnRings, groupAnchor } from "../graph/layout/ringPlacement";
import { enforceFramesKeepOut } from "../graph/layout/keepGhostsOut";
import { NODE_W, NODE_H } from "../graph/constants";
import type { DisplayExternal } from "../graph/types";
import type { Edge as AppEdge, GhostNode, AncestorRef } from "../../types";

// Раскладка гостей на кольца запретных рамок (boundary labeling). Чистые данные: позиции
// заданы явно, ELK не нужен. Ключевой инвариант — после колец enforceFramesKeepOut no-op.

const a = (id: string): AncestorRef => ({ id, name: id, is_external: false });
function ghost(id: string, ancestors: AncestorRef[]): GhostNode {
  return {
    id, name: id, role: null, technology: null, is_external: true,
    shape: "service", status: "existing", node_depth: ancestors.length, has_children: false, child_count: 0, ancestors, is_ghost: true,
  };
}
function leaf(id: string, ancestors: AncestorRef[]): DisplayExternal {
  return { kind: "leaf", id, ghost: ghost(id, ancestors) };
}
function edge(id: string, source_id: string, target_id: string): AppEdge {
  return {
    id, label: null, technology: null, source_id, target_id,
    source_handle: null, target_handle: null, created_at: "2026-06-12T00:00:00Z",
  };
}
const node = (id: string) => ({ id });

describe("placeGhostsOnRings — сторона по потоку", () => {
  it("источник → слева от уровня, приёмник → справа", () => {
    const positions = new Map([["L", { x: 0, y: 0 }], ["Gs", { x: 5, y: 5 }], ["Gt", { x: 9, y: 9 }]]);
    const res = placeGhostsOnRings({
      nodes: [node("L")],
      entities: [leaf("Gs", [a("D")]), leaf("Gt", [a("E")])],
      ancestorIds: ["A"], levelPositions: {}, expanded: new Set(),
      layoutEdges: [edge("e1", "Gs", "L"), edge("e2", "L", "Gt")], positions,
    });
    expect(res).not.toBeNull();
    expect(positions.get("Gs")!.x).toBeLessThan(0);          // источник слева
    expect(positions.get("Gt")!.x).toBeGreaterThan(NODE_W);  // приёмник справа
    expect(res!.placedOutside.has("Gs")).toBe(true);
    expect(res!.placedOutside.has("Gt")).toBe(true);
  });

  it("связь к среднему узлу ряда: горизонталь сквозь соседей → гость уходит ВВЕРХ", () => {
    // La(0,0) Lb(300,0) Lc(600,0); гость связан со средним Lb. Лево/право увели бы стрелку
    // сквозь La/Lc; верх (вертикаль к Lb) чист → гость над рамкой, по центру над связью.
    const positions = new Map([
      ["La", { x: 0, y: 0 }], ["Lb", { x: 300, y: 0 }], ["Lc", { x: 600, y: 0 }], ["G", { x: 5, y: 5 }],
    ]);
    const res = placeGhostsOnRings({
      nodes: [node("La"), node("Lb"), node("Lc")],
      entities: [leaf("G", [a("D")])],
      ancestorIds: ["A"], levelPositions: {}, expanded: new Set(),
      layoutEdges: [edge("e", "G", "Lb")], positions,
    });
    expect(res).not.toBeNull();
    expect(positions.get("G")!.x).toBe(300);       // по центру над Lb (вертикаль, не сбоку)
    expect(positions.get("G")!.y).toBeLessThan(0); // над рамкой
  });
});

describe("placeGhostsOnRings — keep-out по построению", () => {
  it("после колец enforceFramesKeepOut НИЧЕГО не двигает (no-op → null)", () => {
    const positions = new Map([["L", { x: 0, y: 0 }], ["G", { x: 5, y: 5 }]]);
    const ents = [leaf("G", [a("D")])];
    placeGhostsOnRings({
      nodes: [node("L")], entities: ents, ancestorIds: ["A"], levelPositions: {}, expanded: new Set(),
      layoutEdges: [edge("e", "G", "L")], positions,
    });
    const enf = enforceFramesKeepOut({
      nodes: [node("L")], entities: ents, ancestorIds: ["A"], layoutEdges: [edge("e", "G", "L")], positions,
    });
    expect(enf).toBeNull(); // гость с рамкой посажен ровно на границу буфера → no-op
  });

  it("гости разной глубины: оба валидны по keep-out (разные запретные кольца)", () => {
    // breadcrumb [A,B]; локальный C. Gin (предок A, член A) — запретна B (внутреннее кольцо);
    // Gout (предок D, ничей) — запретна A (внешнее). Каскад изнутри наружу размещает обоих
    // так, что страховочный keep-out — no-op (точная сторона зависит от формы выросшей рамки).
    const positions = new Map([
      ["C", { x: 0, y: 0 }], ["Gin", { x: 5, y: 5 }], ["Gout", { x: 9, y: 9 }],
    ]);
    const res = placeGhostsOnRings({
      nodes: [node("C")],
      entities: [leaf("Gin", [a("A")]), leaf("Gout", [a("D")])],
      ancestorIds: ["A", "B"], levelPositions: {}, expanded: new Set(),
      layoutEdges: [edge("e1", "Gin", "C"), edge("e2", "Gout", "C")], positions,
    });
    expect(res).not.toBeNull();
    expect(res!.placedOutside.has("Gin")).toBe(true);
    expect(res!.placedOutside.has("Gout")).toBe(true);
    // ключевой инвариант: после колец keep-out ничего не двигает (оба вне своих запретных)
    const ents = [leaf("Gin", [a("A")]), leaf("Gout", [a("D")])];
    const enf = enforceFramesKeepOut({
      nodes: [node("C")], entities: ents, ancestorIds: ["A", "B"],
      layoutEdges: [edge("e1", "Gin", "C"), edge("e2", "Gout", "C")], positions,
    });
    expect(enf).toBeNull();
  });
});

describe("placeGhostsOnRings — внутренняя полка детей гостевой рамки (D1)", () => {
  // Вертикальный столбец локалов La/Lb/Lc; раскрытая гостевая рамка P с детьми g1/g2/g3,
  // каждый связан со своим локалом. Гость садится сбоку (горизонтальные связи не режут
  // соседей) → дети встают одной вертикальной полкой в ПОРЯДКЕ ЯКОРЕЙ (по проекции y
  // связанных локалов), независимо от входных ELK-позиций детей.
  const vertLocals = () => ({
    nodes: [node("La"), node("Lb"), node("Lc")],
    entities: [leaf("g1", [a("P")]), leaf("g2", [a("P")]), leaf("g3", [a("P")])],
    ancestorIds: ["A"], levelPositions: {} as Record<string, { pos_x: number; pos_y: number; anchor_rel: boolean }>,
    expanded: new Set(["P"]),
    layoutEdges: [edge("e1", "g1", "La"), edge("e2", "g2", "Lb"), edge("e3", "g3", "Lc")],
  });
  const localPos = (): [string, { x: number; y: number }][] => [
    ["La", { x: 0, y: 0 }], ["Lb", { x: 0, y: 260 }], ["Lc", { x: 0, y: 520 }],
  ];

  it("дети упорядочены по якорю и стоят одной колонкой", () => {
    // входные позиции детей НАМЕРЕННО перепутаны относительно их якорей
    const positions = new Map([
      ...localPos(),
      ["g1", { x: 5, y: 999 }], ["g2", { x: 5, y: 5 }], ["g3", { x: 5, y: 480 }],
    ]);
    const res = placeGhostsOnRings({ ...vertLocals(), positions });
    expect(res).not.toBeNull();
    const g1 = positions.get("g1")!, g2 = positions.get("g2")!, g3 = positions.get("g3")!;
    // порядок по якорю: La(y0) < Lb(y260) < Lc(y520) → g1 выше g2 выше g3
    expect(g1.y).toBeLessThan(g2.y);
    expect(g2.y).toBeLessThan(g3.y);
    // одна колонка — общий x
    expect(g1.x).toBe(g2.x);
    expect(g2.x).toBe(g3.x);
    // якоря разнесены > NODE_H+зазор → дети сидят РОВНО на проекциях якорей (Δ = Δлокалов)
    expect(g2.y - g1.y).toBeCloseTo(260);
    expect(g3.y - g2.y).toBeCloseTo(260);
  });

  it("раскладка не зависит от входных ELK-позиций детей", () => {
    const run = (childPos: [string, { x: number; y: number }][]) => {
      const positions = new Map([...localPos(), ...childPos]);
      placeGhostsOnRings({ ...vertLocals(), positions });
      return ["g1", "g2", "g3"].map((id) => positions.get(id)!);
    };
    const a1 = run([["g1", { x: 5, y: 999 }], ["g2", { x: 5, y: 5 }], ["g3", { x: 5, y: 480 }]]);
    const a2 = run([["g1", { x: 700, y: 12 }], ["g2", { x: 5, y: 700 }], ["g3", { x: 5, y: 50 }]]);
    expect(a2).toEqual(a1);
  });

  it("после внутренней полки enforceFramesKeepOut — no-op (рамка села на буфер)", () => {
    const positions = new Map([
      ...localPos(),
      ["g1", { x: 5, y: 999 }], ["g2", { x: 5, y: 5 }], ["g3", { x: 5, y: 480 }],
    ]);
    placeGhostsOnRings({ ...vertLocals(), positions });
    const v = vertLocals();
    const enf = enforceFramesKeepOut({
      nodes: v.nodes, entities: v.entities, ancestorIds: v.ancestorIds,
      layoutEdges: v.layoutEdges, positions,
    });
    expect(enf).toBeNull();
  });
});

describe("placeGhostsOnRings — перелив детей в колонки (D6/D7)", () => {
  // Два близких локала La(y0)/Lb(y150) → пролёт кольца мал, 6 детей не влезают в одну
  // колонку по высоте → перелив в несколько колонок. Все рёбра ghost→local → сторона
  // left, ось полки y, колонки растут поперёк (по x). g1 связан с ОБОИМИ локалами
  // (2 связи) → самый «тяготеющий к контенту» → ВНУТРЕННЯЯ колонка (у кольца).
  const COL_GAP = 24, SHELF_GAP = 28; // = одноимённые константы в ringPlacement.ts (не экспортируются)
  const step = NODE_W + COL_GAP;
  const pitch = NODE_H + SHELF_GAP;
  const run = () => {
    const positions = new Map<string, { x: number; y: number }>([
      ["La", { x: 0, y: 0 }], ["Lb", { x: 0, y: 150 }],
      ["g1", { x: 0, y: 0 }], ["g2", { x: 0, y: 0 }], ["g3", { x: 0, y: 0 }],
      ["g4", { x: 0, y: 0 }], ["g5", { x: 0, y: 0 }], ["g6", { x: 0, y: 0 }],
    ]);
    const res = placeGhostsOnRings({
      nodes: [node("La"), node("Lb")],
      entities: ["g1", "g2", "g3", "g4", "g5", "g6"].map((id) => leaf(id, [a("P")])),
      ancestorIds: ["A"], levelPositions: {}, expanded: new Set(["P"]),
      layoutEdges: [
        edge("e1a", "g1", "La"), edge("e1b", "g1", "Lb"), // g1 — 2 связи
        edge("e2", "g2", "La"), edge("e3", "g3", "Lb"),
        edge("e4", "g4", "La"), edge("e5", "g5", "Lb"), edge("e6", "g6", "La"),
      ],
      positions,
    });
    const kids = ["g1", "g2", "g3", "g4", "g5", "g6"].map((id) => ({ id, ...positions.get(id)! }));
    return { res, kids };
  };

  it("дети переливаются минимум в 2 колонки, разнесённые на NODE_W+COL_GAP", () => {
    const { res, kids } = run();
    expect(res).not.toBeNull();
    const xs = [...new Set(kids.map((k) => Math.round(k.x)))].sort((p, q) => p - q);
    expect(xs.length).toBeGreaterThanOrEqual(2); // перелив случился
    // соседние колонки разнесены ровно на шаг колонки
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeCloseTo(step);
  });

  it("самый связный ребёнок — во внутренней колонке (крайняя к кольцу)", () => {
    const { kids } = run();
    const g1x = kids.find((k) => k.id === "g1")!.x;
    const allX = kids.map((k) => k.x);
    // внутренняя колонка (cross=0) после посадки на сторону = крайняя x; g1 на её краю
    expect(g1x === Math.max(...allX) || g1x === Math.min(...allX)).toBe(true);
  });

  it("внутри колонки порядок по якорю, плотная стопка с шагом NODE_H+SHELF_GAP", () => {
    const { kids } = run();
    const byCol = new Map<number, { id: string; x: number; y: number }[]>();
    for (const k of kids) {
      const key = Math.round(k.x);
      (byCol.get(key) ?? byCol.set(key, []).get(key)!).push(k);
    }
    for (const col of byCol.values()) {
      if (col.length < 2) continue;
      const sorted = [...col].sort((p, q) => p.y - q.y);
      for (let i = 1; i < sorted.length; i++) expect(sorted[i].y - sorted[i - 1].y).toBeCloseTo(pitch);
    }
  });
});

describe("placeGhostsOnRings — ручные позиции", () => {

  it("гость с ручной позицией не двигается; один такой → null", () => {
    const positions = new Map([["L", { x: 0, y: 0 }], ["G", { x: 5, y: 5 }]]);
    const res = placeGhostsOnRings({
      nodes: [node("L")], entities: [leaf("G", [a("D")])], ancestorIds: ["A"],
      levelPositions: { G: { pos_x: 999, pos_y: 999, anchor_rel: false } }, expanded: new Set(),
      layoutEdges: [edge("e", "G", "L")], positions,
    });
    expect(res).toBeNull();
    expect(positions.get("G")).toEqual({ x: 5, y: 5 });
  });

  it("frame (для обводов) = bbox локальных узлов, без вынесенных гостей", () => {
    const positions = new Map([["L", { x: 0, y: 0 }], ["G", { x: 5, y: 5 }]]);
    const res = placeGhostsOnRings({
      nodes: [node("L")], entities: [leaf("G", [a("D")])], ancestorIds: ["A"], levelPositions: {}, expanded: new Set(),
      layoutEdges: [edge("e", "G", "L")], positions,
    });
    expect(res).not.toBeNull();
    expect(res!.frame).toEqual({ minX: 0, minY: 0, maxX: NODE_W, maxY: 100 });
  });
});

describe("placeGhostsOnRings — живой якорь и офсеты владеемой группы (D2/D3)", () => {
  // Раскрытая гостевая рамка P (expanded) с детьми g1/g2, у каждого СОХРАНЁННЫЙ офсет
  // (anchor_rel=true). Абсолют = anchorG + офсет, где anchorG — центроид связанных локалов.
  const owned = (localX: number) => {
    const positions = new Map([
      ["La", { x: localX, y: 0 }], ["Lb", { x: localX, y: 200 }],
      ["g1", { x: 0, y: 0 }], ["g2", { x: 0, y: 0 }], // savedPos не важен — owned-проход перезапишет
    ]);
    const res = placeGhostsOnRings({
      nodes: [node("La"), node("Lb")],
      entities: [leaf("g1", [a("P")]), leaf("g2", [a("P")])],
      ancestorIds: ["A"],
      levelPositions: {
        g1: { pos_x: 50, pos_y: -30, anchor_rel: true },
        g2: { pos_x: 50, pos_y: 80, anchor_rel: true },
      },
      expanded: new Set(["P"]),
      layoutEdges: [edge("e1", "g1", "La"), edge("e2", "g2", "Lb")],
      positions,
    });
    return { positions, res };
  };

  it("восстановление = anchorG + офсет", () => {
    const { positions, res } = owned(0);
    expect(res).not.toBeNull();
    // anchorG = центроид центров La(95,50) и Lb(95,250) = (95,150); g1 = anchorG + (50,-30)
    const g1 = positions.get("g1")!;
    expect(g1.x).toBeCloseTo(NODE_W / 2 + 50);
    expect(g1.y).toBeCloseTo(150 - 30);
    expect(res!.placedOutside.has("g1")).toBe(true);
  });

  it("сдвиг локалов двигает рамку за якорем, относительная расстановка стабильна", () => {
    const a0 = owned(0).positions;
    const a1 = owned(300).positions;
    const g1a = a0.get("g1")!, g2a = a0.get("g2")!;
    const g1b = a1.get("g1")!, g2b = a1.get("g2")!;
    // локалы уехали на +300 по x → anchorG тоже → оба ребёнка сдвинулись на +300
    expect(g1b.x - g1a.x).toBeCloseTo(300);
    expect(g2b.x - g2a.x).toBeCloseTo(300);
    expect(g1b.y).toBeCloseTo(g1a.y);
    // взаимное расположение детей не изменилось
    expect(g2b.x - g1b.x).toBeCloseTo(g2a.x - g1a.x);
    expect(g2b.y - g1b.y).toBeCloseTo(g2a.y - g1a.y);
  });

  it("легаси-абсолют ребёнка раскрытой рамки мигрирует в офсет, не двигаясь", () => {
    const positions = new Map([
      ["La", { x: 0, y: 0 }], ["Lb", { x: 0, y: 200 }],
      ["g1", { x: NODE_W / 2 + 50, y: NODE_H / 2 + 70 }], // savedPos = абсолют
    ]);
    const res = placeGhostsOnRings({
      nodes: [node("La"), node("Lb")],
      entities: [leaf("g1", [a("P")])],
      ancestorIds: ["A"],
      levelPositions: { g1: { pos_x: NODE_W / 2 + 50, pos_y: NODE_H / 2 + 70, anchor_rel: false } },
      expanded: new Set(["P"]),
      layoutEdges: [edge("e1", "g1", "La")],
      positions,
    });
    expect(res).not.toBeNull();
    // g1 связан только с La → anchorG = центр La (95,50); на экране узел НЕ двинулся
    expect(positions.get("g1")).toEqual({ x: NODE_W / 2 + 50, y: NODE_H / 2 + 70 });
    // миграция вернула офсет = абсолют − anchorG = (50, 70)
    const mig = res!.migrations.find((m) => m.id === "g1")!;
    expect(mig.pos_x).toBeCloseTo(50);
    expect(mig.pos_y).toBeCloseTo(70);
  });
});

describe("placeGhostsOnRings — пин владеемой группы (D4)", () => {
  // Round-trip: первый драг ОДНОГО ребёнка пинит офсеты ВСЕХ детей от живого якоря (как
  // useSnapAlignment), а placeGhostsOnRings восстанавливает их один-в-один. Якорь считает
  // groupAnchor — ОДНА функция в пине и восстановлении, поэтому anchorG + (pos − anchorG) === pos.
  it("офсеты пина восстанавливаются в исходные позиции (drag одного ребёнка пинит обоих)", () => {
    const locals = new Map([["La", { x: 0, y: 0 }], ["Lb", { x: 0, y: 200 }]]);
    const edges = [edge("e1", "g1", "La"), edge("e2", "g2", "Lb")];
    // позиции членов на момент драга: g1 пользователь утащил, g2 остался на авто-полке
    const memberPos = new Map([["g1", { x: 300, y: 40 }], ["g2", { x: 120, y: 150 }]]);
    const posOf = (id: string) => locals.get(id) ?? memberPos.get(id);
    const anchorG = groupAnchor(["g1", "g2"], ["La", "Lb"], edges, posOf);
    expect(anchorG).not.toBeNull();
    // пин: офсет каждого члена = его позиция − якорь (anchor_rel=true)
    const off = (id: string) => ({
      pos_x: memberPos.get(id)!.x - anchorG!.x,
      pos_y: memberPos.get(id)!.y - anchorG!.y,
      anchor_rel: true,
    });
    const positions = new Map([...locals, ["g1", { x: 0, y: 0 }], ["g2", { x: 0, y: 0 }]]);
    const res = placeGhostsOnRings({
      nodes: [node("La"), node("Lb")],
      entities: [leaf("g1", [a("P")]), leaf("g2", [a("P")])],
      ancestorIds: ["A"],
      levelPositions: { g1: off("g1"), g2: off("g2") },
      expanded: new Set(["P"]),
      layoutEdges: edges,
      positions,
    });
    expect(res).not.toBeNull();
    // восстановление вернуло обоих ровно туда, где они были на момент пина
    expect(positions.get("g1")!.x).toBeCloseTo(300);
    expect(positions.get("g1")!.y).toBeCloseTo(40);
    expect(positions.get("g2")!.x).toBeCloseTo(120);
    expect(positions.get("g2")!.y).toBeCloseTo(150);
    // офсеты уже anchor_rel → ленивой миграции нет
    expect(res!.migrations.length).toBe(0);
  });
});

describe("placeGhostsOnRings — композиция якоря: сдвиг коробки-родителя", () => {
  // Раскрытая рамка P (expanded) с детьми g1/g2 (офсеты anchor_rel). Пользователь ДО этого
  // перетащил саму свёрнутую коробку → её сдвиг лежит в levelPositions["P"]. Композитный
  // якорь = живой якорь локалов + сдвиг коробки, поэтому весь блок детей едет вслед за
  // коробкой, сохраняя внутреннюю расстановку. anchorG = (NODE_W/2, 150) при La(0,0)/Lb(0,200).
  const base = () => ({
    nodes: [node("La"), node("Lb")],
    entities: [leaf("g1", [a("P")]), leaf("g2", [a("P")])],
    ancestorIds: ["A"],
    layoutEdges: [edge("e1", "g1", "La"), edge("e2", "g2", "Lb")],
    expanded: new Set(["P"]),
  });
  const childOffsets = {
    g1: { pos_x: 50, pos_y: -30, anchor_rel: true },
    g2: { pos_x: 50, pos_y: 80, anchor_rel: true },
  };

  it("офсет коробки (anchor_rel) сдвигает весь блок детей, расстановка стабильна", () => {
    const positions = new Map([
      ["La", { x: 0, y: 0 }], ["Lb", { x: 0, y: 200 }],
      ["g1", { x: 0, y: 0 }], ["g2", { x: 0, y: 0 }],
    ]);
    const res = placeGhostsOnRings({
      ...base(),
      levelPositions: { ...childOffsets, P: { pos_x: 40, pos_y: 100, anchor_rel: true } },
      positions,
    });
    expect(res).not.toBeNull();
    // anchor = anchorG(NODE_W/2,150) + boxOff(40,100); g1 = anchor + (50,-30)
    const g1 = positions.get("g1")!, g2 = positions.get("g2")!;
    expect(g1.x).toBeCloseTo(NODE_W / 2 + 40 + 50);
    expect(g1.y).toBeCloseTo(150 + 100 - 30);
    // взаимное расположение детей не изменилось (блок едет целиком)
    expect(g2.x).toBeCloseTo(g1.x);
    expect(g2.y - g1.y).toBeCloseTo(110);
    // коробка и дети уже anchor_rel → ленивой миграции нет
    expect(res!.migrations.length).toBe(0);
  });

  it("легаси-абсолют коробки = композитный якорь + мигрирует в офсет", () => {
    const positions = new Map([
      ["La", { x: 0, y: 0 }], ["Lb", { x: 0, y: 200 }],
      ["g1", { x: 0, y: 0 }], ["g2", { x: 0, y: 0 }],
    ]);
    const res = placeGhostsOnRings({
      ...base(),
      levelPositions: { ...childOffsets, P: { pos_x: 300, pos_y: 400, anchor_rel: false } },
      positions,
    });
    expect(res).not.toBeNull();
    // абсолют коробки (300,400) и есть композитный якорь; g1 = якорь + (50,-30)
    expect(positions.get("g1")!.x).toBeCloseTo(350);
    expect(positions.get("g1")!.y).toBeCloseTo(370);
    // миграция коробки: офсет = абсолют − anchorG = (300−NODE_W/2, 400−150)
    const mig = res!.migrations.find((m) => m.id === "P")!;
    expect(mig.pos_x).toBeCloseTo(300 - NODE_W / 2);
    expect(mig.pos_y).toBeCloseTo(250);
  });

  it("СВЁРНУТАЯ коробка с офсетом восстанавливается как groupAnchor + офсет (не улетает)", () => {
    // Сворачивание: коробка G отображается одиночным гостем, её позиция — офсет от якоря
    // (anchor_rel). seeding кладёт офсет как абсолют (баг) — owned-restore должен поправить.
    const positions = new Map([["L", { x: 0, y: 0 }], ["G", { x: 40, y: 100 }]]); // seed = офсет-как-абсолют
    placeGhostsOnRings({
      nodes: [node("L")],
      entities: [leaf("G", [a("P")])],
      ancestorIds: ["A"],
      levelPositions: { G: { pos_x: 40, pos_y: 100, anchor_rel: true } },
      expanded: new Set(), // СВЁРНУТО
      layoutEdges: [edge("e", "G", "L")],
      positions,
    });
    // groupAnchor = центр L (NODE_W/2, 50); коробка = якорь + офсет, а не сырой (40,100)
    expect(positions.get("G")!.x).toBeCloseTo(NODE_W / 2 + 40);
    expect(positions.get("G")!.y).toBeCloseTo(150);
  });
});

describe("placeGhostsOnRings — вырожденные входы", () => {
  it("нет локальных узлов → null", () => {
    expect(placeGhostsOnRings({
      nodes: [], entities: [leaf("G", [a("D")])], ancestorIds: ["A"], levelPositions: {}, expanded: new Set(),
      layoutEdges: [], positions: new Map(),
    })).toBeNull();
  });
  it("нет breadcrumb-предков (нет колец) → null", () => {
    expect(placeGhostsOnRings({
      nodes: [node("L")], entities: [leaf("G", [a("D")])], ancestorIds: [], levelPositions: {}, expanded: new Set(),
      layoutEdges: [], positions: new Map([["L", { x: 0, y: 0 }]]),
    })).toBeNull();
  });
});
