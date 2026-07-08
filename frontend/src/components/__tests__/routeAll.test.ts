import { describe, it, expect } from "vitest";
import { routeAll, type EdgeTerminal } from "../graph/layout/routeAll";
import { countEdgeCrossings } from "../graph/layout/arrowMetrics";
import { pathCrossesRects, type NodeRect } from "../graph/edgePath";

// Глобальный роутер набора (A3a, R3): пересечения между стрелками минимизируются штрафом.
// Проверяем, что при высоком crossCost взаимное пересечение исчезает (есть куда свернуть),
// при нулевом — маршруты прямые и пересекаются; обход узлов остаётся жёстким; детерминизм.

const term = (id: string, s: [number, number], e: [number, number], obstacles: NodeRect[] = []): EdgeTerminal => ({
  id, start: { x: s[0], y: s[1] }, end: { x: e[0], y: e[1] }, obstacles,
});

describe("routeAll — минимизация пересечений (R3)", () => {
  // X — длинная горизонталь y=0; Y — вертикаль x=100, пересекающая её посередине.
  // Объехать можно через концы X (x=0 / x=200): там пересечение приходится на конец X
  // (строго-внутри не считается) → крестик исчезает.
  const edges = (): EdgeTerminal[] => [
    term("X", [0, 0], [200, 0]),
    term("Y", [100, -50], [100, 50]),
  ];

  it("высокий crossCost → стрелки разведены, 0 пересечений", () => {
    const routes = routeAll(edges(), { crossCost: 1000 });
    expect(countEdgeCrossings(routes)).toBe(0);
  });

  it("нулевой crossCost → прямые маршруты, есть пересечение", () => {
    const routes = routeAll(edges(), { crossCost: 0 });
    expect(countEdgeCrossings(routes)).toBe(1);
  });

  it("детерминизм и независимость от порядка входа", () => {
    const a = routeAll(edges(), { crossCost: 1000 });
    const reversed = [...edges()].reverse();
    const b = routeAll(reversed, { crossCost: 1000 });
    expect([...b.entries()].sort()).toEqual([...a.entries()].sort());
  });
});

describe("routeAll — выбор порта внутри поиска (V2.2)", () => {
  it("из портов-кандидатов берёт пару с лучшим маршрутом", () => {
    const e: EdgeTerminal = {
      id: "X", start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, obstacles: [],
      startPorts: [{ point: { x: 0, y: 0 } }],
      endPorts: [
        { point: { x: 100, y: 50 } }, // потребует излом
        { point: { x: 100, y: 0 } },  // прямой ход, 0 изломов
      ],
    };
    const routes = routeAll([e], { crossCost: 0 });
    const r = routes.get("X")!;
    expect(r[r.length - 1]).toEqual({ x: 100, y: 0 }); // выбран прямой вариант
  });

  it("сторона выбирается С УЧЁТОМ пересечений (не отдельной пробой)", () => {
    // Чужая стрелка перегораживает прямой путь к ближнему порту; при высоком crossCost
    // роутер предпочитает дальний порт без пересечения.
    const wall: EdgeTerminal = term("W", [50, -200], [50, 200]);
    const e: EdgeTerminal = {
      id: "X", start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, obstacles: [],
      startPorts: [{ point: { x: 0, y: 0 } }],
      endPorts: [
        { point: { x: 100, y: 0 } },  // ближний, но за «стеной» W
        { point: { x: 0, y: 300 } },  // дальний, чистый
      ],
    };
    const withPenalty = routeAll([wall, e], { crossCost: 100000 });
    const r = withPenalty.get("X")!;
    expect(r[r.length - 1]).toEqual({ x: 0, y: 300 }); // пересечение перевесило длину
  });
});

describe("routeAll — обход узлов жёсткий", () => {
  it("штраф за пересечение не загоняет маршрут в чужой узел", () => {
    const blocker: NodeRect = { x: 80, y: -50, w: 100, h: 100 }; // x∈[80,180], y∈[-50,50]
    const edges: EdgeTerminal[] = [
      term("X", [0, 0], [300, 0], [blocker]),
      term("Y", [40, -80], [40, 80]),
    ];
    const routes = routeAll(edges, { crossCost: 1000 });
    // X обязан обогнуть blocker (его собственное препятствие) при любом штрафе
    expect(pathCrossesRects(routes.get("X")!, [blocker])).toBe(false);
  });
});
