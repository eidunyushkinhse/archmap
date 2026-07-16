import { describe, it, expect } from "vitest";
import { routeAll, straightenJogs, type EdgeTerminal } from "../graph/layout/routeAll";
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

describe("routeAll — пересечение СТВОЛА = одна точка, один штраф (2026-07-09)", () => {
  it("ребро пересекает совпадающее плечо трёх стрелок напрямую, без обхода", () => {
    // Ствол: три ребра из одного хэндла (50,0) вниз — их вертикали совпадают.
    // По-сегментный счёт брал за пересечение 3×crossCost — «стена стоимости»
    // заставляла X наматывать обход через y=0 (жалоба: обёртка вокруг Zabbix Core).
    // Счёт по различным точкам: пересечение ствола = 1 штраф → прямой маршрут дешевле.
    const trunk = (id: string, endY: number): EdgeTerminal =>
      term(id, [50, 0], [50, endY]);
    const routes = routeAll([
      trunk("T1", 300), trunk("T2", 310), trunk("T3", 320),
      term("X", [0, 150], [100, 150]),
    ]);
    expect(routes.get("X")).toEqual([{ x: 0, y: 150 }, { x: 100, y: 150 }]);
  });
});

describe("routeAll — гистерезис маршрутов (2026-07-09)", () => {
  it("равноценный прежний маршрут УДЕРЖИВАЕТСЯ (нет перекладки на ничьей)", () => {
    // ступенька (0,0)→(100,100): вариантов равной стоимости несколько; prev — один из них
    const prev = [
      { x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 100 }, { x: 100, y: 100 },
    ];
    const e: EdgeTerminal = { ...term("X", [0, 0], [100, 100]), prev };
    const routes = routeAll([e]);
    expect(routes.get("X")).toEqual(prev);
  });

  it("прежний маршрут ХУЖЕ порога (большой крюк) → берётся свежий", () => {
    const prev = [
      { x: 0, y: 0 }, { x: 0, y: -300 }, { x: 100, y: -300 }, { x: 100, y: 100 },
    ];
    const e: EdgeTerminal = { ...term("X", [0, 0], [100, 100]), prev };
    const routes = routeAll([e]);
    expect(routes.get("X")).not.toEqual(prev);
  });

  it("прежний маршрут с НОВЫМ пересечением (200 > порога) → перекладывается", () => {
    // чужая стрелка длиннее → прокладывается первой; prev ребра X её пересекает,
    // свежий маршрут может обойти через конец стены
    const wall = term("W", [50, -200], [50, 200]);
    const prev = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    const e: EdgeTerminal = { ...term("X", [0, 0], [100, 0]), prev };
    const routes = routeAll([e, wall], { crossCost: 1000 });
    expect(routes.get("X")).not.toEqual(prev);
  });
});

describe("straightenJogs — пост-спрямление джогов (T3, 2026-07-13)", () => {
  const seg = (x1: number, y1: number, x2: number, y2: number) => ({
    seg: { index: 0, x1, y1, x2, y2, orient: (Math.abs(y2 - y1) <= Math.abs(x2 - x1) ? "h" : "v") as "h" | "v" },
    p0: { x: x1, y: y1 }, pN: { x: x2, y: y2 },
  });

  it("короткий перескок между сонаправленными сегментами схлопывается (без чужих линий)", () => {
    const pts = [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 8 }, { x: 300, y: 8 }, { x: 300, y: 100 },
    ];
    const out = straightenJogs(pts, [], [], 200, 40);
    expect(out).toEqual([{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 100 }]);
  });

  it("джог, уворачивающийся от езды по чужой линии, ОСТАЁТСЯ", () => {
    const pts = [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 8 }, { x: 300, y: 8 }, { x: 300, y: 100 },
    ];
    // чужой сегмент лежит ровно на линии y=0 в [150..600] — спрямление поехало бы по нему
    const others = [seg(150, 0, 600, 0)];
    const out = straightenJogs(pts, [], others, 200, 40);
    expect(out).toEqual(pts); // вариант «на линию y=8» недоступен (A — док), джог остаётся
  });

  it("схлоп в щель уже минимального канала ОТВЕРГАЕТСЯ (прижатость к чужой линии, E34)", () => {
    const pts = [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 8 }, { x: 300, y: 8 }, { x: 300, y: 100 },
    ];
    // чужая ПАРАЛЛЕЛЬНАЯ линия в 4px от линии схлопывания (y=4): оценщик езды её не
    // видит (|Δ| > EPS), но щель 4 < LINE_CLEAR=8 нечитаема — кандидат отвергается
    const near = [seg(150, 4, 600, 4)];
    expect(straightenJogs(pts, [], near, 200, 40)).toEqual(pts);
    // контроль: та же линия вдали (y=40) спрямлению не мешает
    const far = [seg(150, 40, 600, 40)];
    expect(straightenJogs(pts, [], far, 200, 40)).toEqual([
      { x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 100 },
    ]);
  });

  it("доки не двигаются: джог у самого конца остаётся", () => {
    const pts = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 8 }, { x: 220, y: 8 }];
    const out = straightenJogs(pts, [], [], 200, 40);
    expect(out).toEqual(pts);
  });

  it("спрямление не ПРИЖИМАЕТ линию к чужому телу (клиренс, жалоба 2026-07-13)", () => {
    const pts = [
      { x: 0, y: 20 }, { x: 100, y: 20 }, { x: 100, y: 0 }, { x: 300, y: 0 }, { x: 300, y: -100 },
    ];
    // тело в 6px под линией y=20: спрямление «всё на y=20» прижало бы линию к грани
    // (раздутие на JOG_CLEAR=8), а текущий маршрут (y=0) к телу не прижат → отказ
    const body: NodeRect = { x: 150, y: 26, w: 100, h: 40 };
    const out = straightenJogs(pts, [body], [], 200, 40);
    expect(out).toEqual(pts);
  });

  it("спрямление не режет тела: вариант через узел отвергается", () => {
    const pts = [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 20 }, { x: 300, y: 20 }, { x: 300, y: 100 },
    ];
    // тело узла закрывает линию y=0 в [150..250] — вперёд нельзя; назад нельзя (A — док)
    const body: NodeRect = { x: 150, y: -10, w: 100, h: 20 };
    const out = straightenJogs(pts, [body], [], 200, 40);
    expect(out).toEqual(pts);
  });
});

// Стволы v2 (E25 v2, Ф1 плана arrow-trunks): оценка ГОТОВЫХ ломаных знает точную
// легальность общих плеч — общий префикс/суффикс от общего порта одной роли бесплатен
// (и премируется бонусом слияния), повторное схождение после расхождения платит.
describe("routeAll — легальные стволы в оценке готовых ломаных (E25 v2)", () => {
  // Лидер A пришпилен prev-ом: (0,0)→(200,0)→(200,140)→(300,140).
  const prevA = [
    { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 140 }, { x: 300, y: 140 },
  ];
  const A = (): EdgeTerminal => ({ ...term("A", [0, 0], [300, 140]), prev: prevA });

  it("prev с легальным стволом ЧЕРЕЗ излом лидера удерживается гистерезисом", () => {
    // B повторяет префикс A через излом (200 по y=0 + 100 по x=200) и отходит у (200,100).
    // Старое правило (бесплатен только крайний сегмент) насчитало бы prev-у 100px езды
    // по СРЕДНЕМУ сегменту A (+100) — и prev отбрасывался; точная оценка видит общий
    // префикс длиной 300 (+бонус слияния) — prev выигрывает у свежего Г-маршрута.
    const prevB = [
      { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 240, y: 100 },
    ];
    const routes = routeAll([A(), { ...term("B", [0, 0], [240, 100]), prev: prevB }]);
    expect(routes.get("A")).toEqual(prevA);
    expect(routes.get("B")).toEqual(prevB);
  });

  it("повторное схождение ПОСЛЕ расхождения не льготится — такой prev отбрасывается", () => {
    // B разошёлся с A прямо в порту (ушёл вверх), а затем сел на средний сегмент A
    // (x=200, y 30..100): наложение вне общего префикса → честный штраф, свежий
    // маршрут выигрывает с запасом больше гистерезиса.
    const prevB = [
      { x: 0, y: 0 }, { x: 0, y: 30 }, { x: 200, y: 30 }, { x: 200, y: 100 }, { x: 240, y: 100 },
    ];
    const routes = routeAll([A(), { ...term("B", [0, 0], [240, 100]), prev: prevB }]);
    expect(routes.get("B")).not.toEqual(prevB);
    expect(routes.get("B")).toEqual([{ x: 0, y: 0 }, { x: 240, y: 0 }, { x: 240, y: 100 }]);
  });
});

// Портовый штраф (2026-07-15, Т4): вход не паркуется в порт, занятый чужим ВЫХОДОМ,
// пока есть свободные слоты; при единственном общем порте — мягкая деградация.
// Репро регрессии: встречные стрелки сливались концевыми плечами в общем хэндле,
// нуджинг бессилен (оба конца пришпилены) — разводить обязан сам роутер.
describe("routeAll — портовый штраф (вход не в чужой выход)", () => {
  // L и R на одной оси: A идёт L→R прямой по слоту y=45. B приходит в L сверху от T;
  // без штрафа его вход сел бы в тот же слот 45 (подход на 15px короче соседнего),
  // штраф уводит на свободный слот.
  const L: NodeRect = { x: 0, y: 0, w: 100, h: 60 };
  const R: NodeRect = { x: 600, y: 15, w: 100, h: 60 };
  const T: NodeRect = { x: 400, y: 150, w: 100, h: 60 };
  const rSlots = (n: NodeRect): Array<{ point: { x: number; y: number }; side: "right" }> =>
    [15, 30, 45].map((dy) => ({ point: { x: n.x + n.w, y: n.y + dy }, side: "right" }));
  const edges = (): EdgeTerminal[] => [
    {
      id: "A",
      start: { x: 100, y: 45 }, end: { x: 600, y: 45 },
      obstacles: [T],
      startPorts: rSlots(L),
      endPorts: [30, 45, 60].map((dy) => ({ point: { x: 600, y: 15 + dy }, side: "left" as const })),
    },
    {
      id: "B",
      start: { x: 450, y: 150 }, end: { x: 100, y: 30 },
      obstacles: [R],
      startPorts: [25, 50, 75].map((dx) => ({ point: { x: 400 + dx, y: 150 }, side: "top" as const })),
      endPorts: rSlots(L),
    },
  ];
  // встречное коллинеарное наложение сегментов двух ломаных (>1px)
  const hasCounterOverlap = (a: { x: number; y: number }[], b: { x: number; y: number }[]): boolean => {
    for (let i = 0; i + 1 < a.length; i++) {
      for (let j = 0; j + 1 < b.length; j++) {
        const ah = Math.abs(a[i + 1].y - a[i].y) <= Math.abs(a[i + 1].x - a[i].x);
        const bh = Math.abs(b[j + 1].y - b[j].y) <= Math.abs(b[j + 1].x - b[j].x);
        if (ah !== bh) continue;
        if (ah) {
          if (Math.abs(a[i].y - b[j].y) > 0.25) continue;
          const lo = Math.max(Math.min(a[i].x, a[i + 1].x), Math.min(b[j].x, b[j + 1].x));
          const hi = Math.min(Math.max(a[i].x, a[i + 1].x), Math.max(b[j].x, b[j + 1].x));
          if (hi - lo > 1 && Math.sign(a[i + 1].x - a[i].x) !== Math.sign(b[j + 1].x - b[j].x)) return true;
        } else {
          if (Math.abs(a[i].x - b[j].x) > 0.25) continue;
          const lo = Math.max(Math.min(a[i].y, a[i + 1].y), Math.min(b[j].y, b[j + 1].y));
          const hi = Math.min(Math.max(a[i].y, a[i + 1].y), Math.max(b[j].y, b[j + 1].y));
          if (hi - lo > 1 && Math.sign(a[i + 1].y - a[i].y) !== Math.sign(b[j + 1].y - b[j].y)) return true;
        }
      }
    }
    return false;
  };

  it("вход B уходит со слота, занятого выходом A; встречных наложений нет", () => {
    const routes = routeAll(edges());
    const a = routes.get("A")!, b = routes.get("B")!;
    const aStart = a[0];
    const bEnd = b[b.length - 1];
    // порт выхода A и порт входа B различаются
    expect(Math.abs(bEnd.x - aStart.x) < 0.5 && Math.abs(bEnd.y - aStart.y) < 0.5).toBe(false);
    expect(hasCounterOverlap(a, b)).toBe(false);
    // тела узлов не режутся
    expect(pathCrossesRects(a, [T])).toBe(false);
    expect(pathCrossesRects(b, [R])).toBe(false);
  });

  it("единственный общий порт → мягкая деградация (маршрут существует)", () => {
    const only = { point: { x: 100, y: 45 }, side: "right" as const };
    const es: EdgeTerminal[] = [
      { id: "A", start: { x: 100, y: 45 }, end: { x: 600, y: 60 }, obstacles: [T], startPorts: [only], endPorts: [{ point: { x: 600, y: 60 }, side: "left" }] },
      { id: "B", start: { x: 450, y: 150 }, end: { x: 100, y: 45 }, obstacles: [R], startPorts: [{ point: { x: 450, y: 150 }, side: "top" }], endPorts: [only] },
    ];
    const routes = routeAll(es);
    const b = routes.get("B")!;
    expect(b.length).toBeGreaterThanOrEqual(2);
    // вынужденно паркуется в общий порт — нарушение допущено, но маршрут есть
    expect(b[b.length - 1]).toEqual({ x: 100, y: 45 });
  });
});
