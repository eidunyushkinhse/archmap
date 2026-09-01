// ИНКРЕМЕНТАЛЬНЫЙ СКОУП ПЕРЕСЧЁТА (Ф3 эпика router-opt, спека edge.md E84).
// Чистая функция computeIncrementalScope: дифф финальных позиций против снимка прошлого
// прогона → множество рёбер, которые обязаны перепроложиться. Здесь проверяются все
// пять оснований попадания в скоуп (изменившийся конец, отсутствие prev-маршрута, врез
// в грязную зону, замыкание по стволам, рамки), порог отказа и детерминизм.
import { describe, it, expect } from "vitest";
import {
  computeIncrementalScope, ROUTE_SCOPE_PAD, SCOPE_FULL_RECALC_SHARE,
  type IncrementalScopeParams,
} from "../graph/layout/incrementalScope";
import type { EdgeGroup } from "../graph/types";
import type { EdgePoint } from "../../types";
import { NODE_W, NODE_H } from "../graph/constants";

type Pos = Record<string, { x: number; y: number }>;
type Routes = Record<string, EdgePoint[]>;

const group = (id: string, source: string, target: string): EdgeGroup =>
  ({ id, source, target, members: [] });

const pt = (x: number, y: number): EdgePoint => ({ x, y });

// Сцена: узлы на фолбэк-габаритах (190×100), все рёбра — кандидаты роутинга.
function scene(opts: {
  now: Pos;
  was: Pos;
  groups: EdgeGroup[];
  prevRoutes: Routes;
  sizes?: Record<string, { w: number; h: number }>;
  prevSizes?: Record<string, { w: number; h: number }>;
  frames?: IncrementalScopeParams["frames"];
  candidates?: string[];
}): IncrementalScopeParams {
  return {
    positions: new Map(Object.entries(opts.now)),
    sizes: new Map(Object.entries(opts.sizes ?? {})),
    prevScene: {
      positions: new Map(Object.entries(opts.was)),
      sizes: new Map(Object.entries(opts.prevSizes ?? opts.sizes ?? {})),
    },
    groups: opts.groups,
    candidates: new Set(opts.candidates ?? opts.groups.map((g) => g.id)),
    prevRoutes: new Map(Object.entries(opts.prevRoutes)),
    frames: opts.frames ?? [],
  };
}

const ids = (s: Set<string> | null): string[] | null => (s ? [...s] : null);

// БАЛЛАСТ: пара десятков заведомо нетронутых рёбер далеко в стороне. Нужен, чтобы
// порог отказа (SCOPE_FULL_RECALC_SHARE от числа кандидатов) не срабатывал на
// микро-сценах теста: «в скоуп попало 3 ребра из 3» — законный повод считать всё.
function ballast(n: number): { pos: Pos; groups: EdgeGroup[]; routes: Routes } {
  const pos: Pos = {};
  const groups: EdgeGroup[] = [];
  const routes: Routes = {};
  for (let i = 0; i < n; i++) {
    pos[`P${i}`] = { x: -5000, y: i * 300 };
    pos[`Q${i}`] = { x: -4000, y: i * 300 };
    groups.push(group(`b${i}`, `P${i}`, `Q${i}`));
    routes[`b${i}`] = [pt(-4810, i * 300 + 50), pt(-4000, i * 300 + 50)];
  }
  return { pos, groups, routes };
}
const BAL = ballast(10);

// Базовая сцена: A/B сверху, C/D снизу, M — «переезжающий» узел посередине.
// Габариты фолбэковые: A = x0..190 × y0..100, M = x400..590 × y150..250.
const BASE_NOW: Pos = { A: { x: 0, y: 0 }, B: { x: 1000, y: 0 }, C: { x: 0, y: 400 }, D: { x: 1000, y: 400 }, M: { x: 400, y: 600 }, ...BAL.pos };
const BASE_WAS: Pos = { ...BASE_NOW, M: { x: 400, y: 150 } };
const BASE_GROUPS = [
  group("e1", "A", "B"), group("e2", "C", "D"),
  group("e3", "A", "D"), group("e4", "C", "B"), group("e5", "A", "M"),
  ...BAL.groups,
];
const BASE_ROUTES: Routes = {
  // e1 идёт выше старой зоны M (её верх — 150 − 40 = 110) и ниже не задевает новой
  e1: [pt(190, 30), pt(1000, 30)],
  // e2 — по горизонтали y=455, мимо обоих состояний M (и мимо портов e3: делили бы
  // порт — приехали бы в скоуп замыканием по стволам, а тест не про него)
  e2: [pt(190, 455), pt(1000, 455)],
  // e3 — вертикалью x=500 сверху вниз: режет СТАРОЕ тело M (x360..630, y110..290)
  e3: [pt(190, 50), pt(500, 50), pt(500, 450), pt(1000, 450)],
  // e4 — далеко снизу, мимо обеих зон
  e4: [pt(190, 470), pt(190, 800), pt(900, 800), pt(1000, 800)],
  // e5 — конец на самом M
  e5: [pt(190, 70), pt(400, 70), pt(400, 150)],
  ...BAL.routes,
};

describe("computeIncrementalScope — основания попадания в скоуп", () => {
  it("сдвиг одного узла: его рёбра + рёбра, чей prev-маршрут режет грязную зону", () => {
    const out = computeIncrementalScope(scene({
      now: BASE_NOW, was: BASE_WAS, groups: BASE_GROUPS, prevRoutes: BASE_ROUTES,
    }));
    // e5 — конец переехал; e3 — прошлый маршрут шёл сквозь старое тело M
    expect(ids(out)).toEqual(["e3", "e5"]);
  });

  it("зона строится в ОБОИХ состояниях: маршрут через НОВОЕ место узла тоже в скоупе", () => {
    // маршрут, который старого места M не касался, но лёг там, куда M приехал (y=600)
    const out = computeIncrementalScope(scene({
      now: BASE_NOW, was: BASE_WAS, groups: BASE_GROUPS,
      prevRoutes: { ...BASE_ROUTES, e2: [pt(190, 650), pt(1000, 650)] },
    }));
    expect(ids(out)).toEqual(["e2", "e3", "e5"]);
  });

  it("клиренс ROUTE_SCOPE_PAD: маршрут ближе PAD к телу — в скоупе, дальше — нет", () => {
    // тело M (новое) — y600..700; линия сверху вплотную к зоне
    const near = 600 - (ROUTE_SCOPE_PAD - 5);
    const far = 600 - (ROUTE_SCOPE_PAD + 5);
    const withY = (y: number) => computeIncrementalScope(scene({
      now: BASE_NOW, was: BASE_WAS, groups: BASE_GROUPS,
      prevRoutes: { ...BASE_ROUTES, e2: [pt(190, y), pt(1000, y)] },
    }));
    expect(ids(withY(near))).toContain("e2");
    expect(ids(withY(far))).not.toContain("e2");
  });

  it("ребро БЕЗ prev-маршрута всегда в скоупе (замораживать нечего)", () => {
    const routes = { ...BASE_ROUTES };
    delete routes.e4;
    const out = computeIncrementalScope(scene({
      now: BASE_NOW, was: BASE_WAS, groups: BASE_GROUPS, prevRoutes: routes,
    }));
    expect(ids(out)).toEqual(["e3", "e4", "e5"]);
  });

  it("НОВЫЙ узел: его рёбра в скоупе, чужой маршрут рядом с ним — тоже", () => {
    const now: Pos = { ...BASE_NOW, N: { x: 700, y: 250 } };   // N появился
    const was: Pos = { ...BASE_NOW };                           // ... и в прошлом его не было
    const groups = [...BASE_GROUPS, group("e6", "N", "B")];
    const out = computeIncrementalScope(scene({
      now, was, groups,
      prevRoutes: {
        ...BASE_ROUTES,
        // маршрут, лежащий там, где теперь тело N (x700..890, y250..350)
        e2: [pt(190, 300), pt(1000, 300)],
        e6: [pt(890, 300), pt(1000, 300)],
      },
    }));
    // M в этой сцене не двигался (was = now), «изменившийся» только N
    expect(ids(out)).toEqual(["e2", "e6"]);
  });

  it("ИСЧЕЗНУВШИЙ узел: маршруты через его бывшее тело — в скоупе", () => {
    const now: Pos = { ...BASE_WAS };
    delete now.M;                       // M пропал (свернули контейнер)
    const groups = BASE_GROUPS.filter((g) => g.id !== "e5"); // его рёбра ушли со сцены
    const out = computeIncrementalScope(scene({
      now, was: BASE_WAS, groups, prevRoutes: BASE_ROUTES,
    }));
    expect(ids(out)).toEqual(["e3"]);
  });

  it("габарит узла вырос (замер приехал): это тоже изменение", () => {
    const out = computeIncrementalScope(scene({
      now: BASE_WAS, was: BASE_WAS, groups: BASE_GROUPS, prevRoutes: BASE_ROUTES,
      sizes: { M: { w: NODE_W + 60, h: NODE_H + 60 } },
      prevSizes: { M: { w: NODE_W, h: NODE_H } },
    }));
    expect(ids(out)).toContain("e5");
  });

  it("сцена не изменилась (сдвиги в пределах 0.5px) → null: инкремент не нужен", () => {
    const now: Pos = { ...BASE_WAS, A: { x: 0.4, y: -0.4 } };
    expect(computeIncrementalScope(scene({
      now, was: BASE_WAS, groups: BASE_GROUPS, prevRoutes: BASE_ROUTES,
    }))).toBeNull();
  });
});

describe("computeIncrementalScope — замыкание по стволам (ревью 4.2)", () => {
  // Веер из общего порта A: три ребра стартуют в одной точке (190,50) — сварка E78
  // сшила их в общий ствол. Двинута цель ОДНОГО follower-а.
  const FAN_NOW: Pos = { A: { x: 0, y: 0 }, B: { x: 900, y: 0 }, C: { x: 900, y: 300 }, D: { x: 900, y: 900 }, ...BAL.pos };
  const FAN_WAS: Pos = { ...FAN_NOW, D: { x: 900, y: 600 } };
  const FAN_GROUPS = [group("f1", "A", "B"), group("f2", "A", "C"), group("f3", "A", "D"), ...BAL.groups];
  const FAN_ROUTES: Routes = {
    f1: [pt(190, 50), pt(700, 50), pt(900, 50)],
    f2: [pt(190, 50), pt(700, 50), pt(700, 350), pt(900, 350)],
    f3: [pt(190, 50), pt(700, 50), pt(700, 650), pt(900, 650)],
    ...BAL.routes,
  };

  it("двинута цель одного follower-а → в скоупе ВЕСЬ веер по общему prev-p0", () => {
    const out = computeIncrementalScope(scene({
      now: FAN_NOW, was: FAN_WAS, groups: FAN_GROUPS, prevRoutes: FAN_ROUTES,
    }));
    expect(ids(out)).toEqual(["f1", "f2", "f3"]);
  });

  it("замыкание транзитивно: общий вход (prev-pN) тянет дальше по цепочке", () => {
    // g1 делит с f3 стартовый порт, g2 делит с g1 порт-ЦЕЛЬ — оба обязаны приехать
    const now: Pos = { ...FAN_NOW, E: { x: 1500, y: 900 } };
    const was: Pos = { ...FAN_WAS, E: { x: 1500, y: 900 } };
    const groups = [...FAN_GROUPS, group("g1", "A", "E"), group("g2", "B", "E")];
    const routes: Routes = {
      ...FAN_ROUTES,
      g1: [pt(190, 50), pt(1500, 50), pt(1500, 950)],
      g2: [pt(1090, 50), pt(1300, 50), pt(1300, 950), pt(1500, 950)],
    };
    const out = computeIncrementalScope(scene({ now, was, groups, prevRoutes: routes }));
    expect(ids(out)).toEqual(["f1", "f2", "f3", "g1", "g2"]);
  });

  it("порты сравниваются с квантом 0.5px (как portKey сварки)", () => {
    const routes: Routes = {
      ...FAN_ROUTES,
      // f1 стартует на 0.2px в стороне — сварка считает это ТЕМ ЖЕ портом
      f1: [pt(190.2, 50.1), pt(700, 50), pt(900, 50)],
    };
    const out = computeIncrementalScope(scene({
      now: FAN_NOW, was: FAN_WAS, groups: FAN_GROUPS, prevRoutes: routes,
    }));
    expect(ids(out)).toEqual(["f1", "f2", "f3"]);
  });
});

describe("computeIncrementalScope — рамки", () => {
  const FR_NOW: Pos = { A: { x: 0, y: 0 }, B: { x: 1200, y: 0 }, K1: { x: 500, y: 500 }, K2: { x: 500, y: 700 }, ...BAL.pos };
  const FR_WAS: Pos = { ...FR_NOW, K2: { x: 500, y: 720 } };  // член рамки сдвинулся
  const FR_GROUPS = [group("h1", "A", "B"), group("h2", "A", "F"), ...BAL.groups];
  // рамка-область вокруг K1/K2 (bbox + паддинг), она же — тело стыковки для h2
  const FRAME_RECT = { x: 440, y: 440, w: 320, h: 420 };

  it("рамка-ОБЛАСТЬ с изменившимся членом: её прямоугольник — грязная зона", () => {
    const out = computeIncrementalScope(scene({
      now: FR_NOW, was: FR_WAS, groups: FR_GROUPS,
      prevRoutes: {
        // h1 пересекает рамку насквозь, но НИ ОДНОГО тела членов не задевает
        h1: [pt(190, 50), pt(600, 50), pt(600, 460), pt(1200, 460)],
        h2: [pt(190, 70), pt(300, 70), pt(300, 900)],
        ...BAL.routes,
      },
      frames: [{ id: "F", rect: FRAME_RECT, memberIds: new Set(["K1", "K2"]), region: true }],
    }));
    // h1 — сквозь область; h2 — состыкована в саму рамку (её конец уехал)
    expect(ids(out)).toEqual(["h1", "h2"]);
  });

  it("рамка-ТЕЛО СТЫКОВКИ (родная, region=false): в зону не идёт, но конец меняет", () => {
    const out = computeIncrementalScope(scene({
      now: FR_NOW, was: FR_WAS, groups: FR_GROUPS,
      prevRoutes: {
        h1: [pt(190, 50), pt(600, 50), pt(600, 460), pt(1200, 460)],
        h2: [pt(190, 70), pt(300, 70), pt(300, 900)],
        ...BAL.routes,
      },
      frames: [{ id: "F", rect: FRAME_RECT, memberIds: new Set(["K1", "K2"]), region: false }],
    }));
    // h1 остаётся замороженным: прямоугольник родной рамки охватывает всю сцену и в
    // грязную зону не идёт (иначе скоуп мгновенно вырождался бы в полный пересчёт)
    expect(ids(out)).toEqual(["h2"]);
  });
});

describe("computeIncrementalScope — порог отказа и детерминизм", () => {
  it("скоуп больше доли SCOPE_FULL_RECALC_SHARE → null (полный пересчёт дешевле)", () => {
    // 10 рёбер, 7 из них режут зону сдвинутого узла → 0.7 > 0.6
    const now: Pos = { M: { x: 0, y: 0 } };
    const was: Pos = { M: { x: 0, y: 400 } };
    const groups: EdgeGroup[] = [];
    const prevRoutes: Routes = {};
    for (let i = 0; i < 10; i++) {
      groups.push(group(`x${i}`, "M", `T${i}`));
      now[`T${i}`] = { x: 2000, y: i * 200 };
      was[`T${i}`] = { x: 2000, y: i * 200 };
      // первые 7 идут сквозь тело M (y0..100 сейчас), остальные — далеко внизу
      prevRoutes[`x${i}`] = i < 7 ? [pt(50, 50), pt(2000, 50)] : [pt(50, 3000), pt(2000, 3000)];
    }
    // без рёбер, инцидентных M, чтобы порог считался именно по врезу в зону
    const withoutM = groups.map((g, i) => group(g.id, `S${i}`, `T${i}`));
    for (let i = 0; i < 10; i++) { now[`S${i}`] = { x: -2000, y: i * 200 }; was[`S${i}`] = { x: -2000, y: i * 200 }; }
    expect(SCOPE_FULL_RECALC_SHARE).toBe(0.6);
    expect(computeIncrementalScope(scene({ now, was, groups: withoutM, prevRoutes }))).toBeNull();
    // ровно на границе (6 из 10 = 0.6) скоуп ещё применяется
    prevRoutes.x6 = [pt(50, 3000), pt(2000, 3000)];
    expect(ids(computeIncrementalScope(scene({ now, was, groups: withoutM, prevRoutes }))))
      .toEqual(["x0", "x1", "x2", "x3", "x4", "x5"]);
  });

  it("детерминизм: перемешанный порядок ключей Map даёт ТОТ ЖЕ Set (и тот же порядок)", () => {
    const shuffle = <T,>(a: T[], seed: number): T[] => {
      const out = [...a];
      for (let i = out.length - 1; i > 0; i--) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const j = seed % (i + 1);
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    };
    const build = (seed: number): IncrementalScopeParams => {
      const base = scene({
        now: BASE_NOW, was: BASE_WAS, groups: BASE_GROUPS, prevRoutes: BASE_ROUTES,
      });
      return {
        ...base,
        positions: new Map(shuffle([...base.positions], seed)),
        prevScene: {
          positions: new Map(shuffle([...base.prevScene.positions], seed + 1)),
          sizes: new Map(shuffle([...base.prevScene.sizes], seed + 2)),
        },
        prevRoutes: new Map(shuffle([...base.prevRoutes], seed + 3)),
      };
    };
    const a = ids(computeIncrementalScope(build(7)));
    const b = ids(computeIncrementalScope(build(99)));
    expect(a).toEqual(["e3", "e5"]);
    expect(b).toEqual(a);
  });
});
