// БЮДЖЕТ РАБОТ РОУТЕРА И СТУПЕНИ ДЕГРАДАЦИИ (Ф5 эпика «глубокая оптимизация роутера»,
// спека perf.md P12/P13).
//
// Что здесь доказывается:
//   (i)   ДЕТЕРМИНИЗМ — (вход, конфиг бюджета) → побитово те же маршруты и та же запись
//         budgetDegraded на двух прогонах. Это главное свойство: бюджет по СЧЁТЧИКУ
//         работ, а не по часам, ровно ради него (E17).
//   (ii)  ступень «пропуск T4» реально пропускает мини-проход (видно в трассе стадий);
//   (iii) гриди-фолбэк потолка вызова: с крошечным потолком routePorts возвращает
//         ВАЛИДНЫЙ маршрут (тела не резаны, стабы на месте), а счётчик растёт;
//   (iv)  СТРАХОВОЧНАЯ КАЛИБРОВКА — без форс-бюджета ступени не срабатывают ни на одной
//         фазз-сцене, а прогноз априорного контура оставляет эталонам кратный запас;
//   (v)   прогон со ступенью НЕ авторитетен (деградированная геометрия в кэш P11 не идёт).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { computeViewLayout, type PipelineInput } from "../graph/layout/pipeline";
import { buildAutoRoutes } from "../graph/layout/autoRoutes";
import { routePorts, __routeCounters, CALL_EXPANSION_CAP } from "../graph/layout/orthoRoute";
import { pathCrossesRects, type NodeRect } from "../graph/edgePath";
import {
  createRouteBudget, forecastExpansions, classifyScene, ROUTE_BUDGET_BY_CLASS,
  DEFAULT_ROUTE_BUDGET, type RouteBudgetConfig,
} from "../graph/layout/routeBudget";
import { generateScene } from "./routerFuzz";
import type { Node as AppNode, Edge as AppEdge, GhostNode, AncestorRef } from "../../types";

// ── сцена конвейера (та же форма, что в pipeline.test.ts) ───────────────────────

const a = (id: string): AncestorRef => ({ id, name: id, is_external: false });

function appNode(id: string): AppNode {
  return {
    id, name: id, description: null, role: null, technology: null,
    parent_id: "P", shape: "service", is_external: false, status: "existing",
    openapi_spec: null, docs: [], version: 1,
    created_at: "", updated_at: "", has_children: false, child_count: 0,
  } as AppNode;
}

function ghost(id: string, ancestors: AncestorRef[]): GhostNode {
  return {
    id, name: id, role: null, technology: null, is_external: true,
    shape: "service", status: "existing", node_depth: ancestors.length,
    has_children: false, child_count: 0, ancestors, is_ghost: true,
  } as GhostNode;
}

function edge(id: string, source_id: string, target_id: string, label: string | null = null): AppEdge {
  return {
    id, label, technology: null, source_id, target_id,
    created_at: "2026-07-07T00:00:00Z",
  } as AppEdge;
}

// Сцена с ПОЛНЫМИ замерами: без них авто-режим P10 роняет стадии качества (и вместе с
// ними бюджет), а гейт авторитетности (v) не проверить — он и так был бы false.
const SZ = { w: 220, h: 96 };
function budgetInput(overrides: Partial<PipelineInput> = {}): PipelineInput {
  return {
    nodes: [appNode("A"), appNode("B"), appNode("C")],
    endpoints: [ghost("G", []), ghost("H", [a("D")])],
    edges: [
      edge("eAB", "A", "B", "зов"), edge("eBC", "B", "C", "поток"),
      edge("eCA", "C", "A", "ответ"), edge("eGA", "G", "A", "вход"),
      edge("eHB", "H", "B", "выход"), edge("eGC", "G", "C", "метрики"),
    ],
    containerId: "P",
    viewLayout: {
      A: { x: 0, y: 0 }, B: { x: 400, y: 0 }, C: { x: 200, y: 300 },
      G: { x: -400, y: 0 }, D: { x: 800, y: 200 },
    },
    ancestorIds: ["P"],
    expanded: new Set(),
    localChildren: {},
    sizes: { A: SZ, B: SZ, C: SZ, G: SZ, D: SZ },
    edgeQuality: "full",
    ...overrides,
  };
}

// Стабильная сериализация маршрутов и хэндлов — сравнение прогонов побитово.
type Pt = { x: number; y: number };
function routesSig(l: { autoRoutes?: Map<string, Pt[]>; edgeHandles: Map<string, unknown> }): string {
  const routes = [...(l.autoRoutes ?? new Map<string, Pt[]>())]
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([id, pts]) => `${id}=${pts.map((p) => `${p.x},${p.y}`).join(";")}`);
  const handles = [...l.edgeHandles].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([id, h]) => `${id}=${JSON.stringify(h)}`);
  return `${routes.join("\n")}\n--\n${handles.join("\n")}`;
}

// Форс-бюджет: лимит настолько мал, что ЛЮБОЙ прогон стадий его перебирает, и все три
// реактивные ступени включаются на своих границах.
const FORCE_ALL: RouteBudgetConfig = { ...DEFAULT_ROUTE_BUDGET, byClass: { typical: 1, limit: 1, overload: 1 } };
// Форс-бюджет ТОЛЬКО на T4: доли ripup/weld подняты выше единицы (не срабатывают
// никогда), доля T4 — ноль (срабатывает сразу, как только потрачена хоть одна экспансия).
const FORCE_T4_ONLY: RouteBudgetConfig = {
  ...DEFAULT_ROUTE_BUDGET, skipRipupShare: 10, skipWeldShare: 10, skipT4Share: 0,
};

// Трасса стадий конвейера: тот же хук, которым живёт scripts/replay-prof.ts.
type TraceG = { __ARCHMAP_TRACE?: (stage: string, ms: number) => void };
const traceG = globalThis as unknown as TraceG;
let marks: string[] = [];
beforeEach(() => { marks = []; traceG.__ARCHMAP_TRACE = (stage) => { marks.push(stage); }; });
afterEach(() => { delete traceG.__ARCHMAP_TRACE; });

describe("бюджет работ роутера — реактивный контур (P13)", () => {
  it("(i) детерминизм: два прогона с форс-бюджетом дают те же маршруты и ту же запись ступеней", async () => {
    const one = await computeViewLayout(budgetInput({ routeBudget: FORCE_ALL }));
    const two = await computeViewLayout(budgetInput({ routeBudget: FORCE_ALL }));
    expect(one.budgetDegraded, "ступени обязаны сработать при лимите в одну экспансию").not.toBeNull();
    expect(routesSig(two.layout)).toBe(routesSig(one.layout));
    expect(two.budgetDegraded).toEqual(one.budgetDegraded);
    // И сами ступени — те, что предписаны реактивным контуром на этих порогах.
    expect(one.budgetDegraded).toEqual({ ripup: true, weld: true, t4: true, greedyCalls: 0 });
  });

  it("(ii) ступень «пропуск T4» реально пропускает мини-проход (трасса стадий)", async () => {
    const full = await computeViewLayout(budgetInput());
    expect(full.budgetDegraded, "дефолтный бюджет на этой сцене не должен срабатывать").toBeNull();
    expect(marks).toContain("T4 мини-проход (плашки-препятствия)");
    const before = marks.length; // ДЛИНА, не ссылка: marks — тот же массив, что пишет хук

    const cut = await computeViewLayout(budgetInput({ routeBudget: FORCE_T4_ONLY }));
    expect(cut.budgetDegraded).toEqual({ ripup: false, weld: false, t4: true, greedyCalls: 0 });
    const after = marks.slice(before);
    expect(after).toContain("T4 мини-проход: ПРОПУЩЕН (ступень бюджета работ, P13)");
    expect(after).not.toContain("T4 мини-проход (плашки-препятствия)");
    // Ступень «пропуск T4» — ОДНА: rip-up и сварка на своих порогах не сработали,
    // значит их запись осталась ложной (таблица «точка × ступень» соблюдена).
    expect(cut.budgetDegraded?.ripup).toBe(false);
    expect(cut.budgetDegraded?.weld).toBe(false);
  });

  it("(v) прогон со ступенью НЕ авторитетен (в кэш маршрутов вида не идёт)", async () => {
    const clean = await computeViewLayout(budgetInput());
    expect(clean.budgetDegraded).toBeNull();
    expect(clean.authoritative, "полный прогон на полных замерах обязан быть авторитетным").toBe(true);

    const cut = await computeViewLayout(budgetInput({ routeBudget: FORCE_T4_ONLY }));
    expect(cut.budgetDegraded).not.toBeNull();
    expect(cut.authoritative, "деградированную геометрию консервировать нельзя").toBe(false);
  });
});

describe("бюджет работ роутера — априорный контур (P12)", () => {
  it("прогноз выше лимита класса включает ступени С САМОГО СТАРТА и ужимает потолок вызова", () => {
    // Сцена «типовая» по размеру, но прогноз задран конфигом: априорный контур обязан
    // сработать ДО первой экспансии — на нулевом расходе.
    const cfg: RouteBudgetConfig = { ...DEFAULT_ROUTE_BUDGET, expPerEdge: 1e9 };
    const b = createRouteBudget({ nodes: 10, edges: 20, config: cfg });
    expect(b.apriori).toBe(true);
    expect(b.spent()).toBe(0);
    expect(b.takeRipup()).toBe(true);
    expect(b.takeWeld()).toBe(true);
    expect(b.takeT4()).toBe(true);
    expect(b.callCap).toBe(Math.floor(CALL_EXPANSION_CAP / DEFAULT_ROUTE_BUDGET.aprioriCapDivisor));
    expect(b.result()).toEqual({ ripup: true, weld: true, t4: true, greedyCalls: 0 });
  });

  it("класс сцены и лимит берутся по P1", () => {
    expect(classifyScene(36, 85)).toBe("typical");
    expect(classifyScene(51, 128)).toBe("limit");
    expect(classifyScene(120, 400)).toBe("overload");
    const b = createRouteBudget({ nodes: 51, edges: 128 });
    expect(b.sceneClass).toBe("limit");
    expect(b.limit).toBe(ROUTE_BUDGET_BY_CLASS.limit);
    expect(b.apriori).toBe(false);
    expect(b.result()).toBeNull();
  });
});

describe("бюджет работ роутера — гриди-фолбэк потолка вызова (P13, ступень 1)", () => {
  it("(iii) с крошечным потолком routePorts возвращает валидный маршрут, счётчик растёт", () => {
    // Стена из трёх тел между стартом и целью: без объезда пути нет, поиск обязан
    // реально работать (а не находить цель первым же ходом).
    const obstacles: NodeRect[] = [
      { x: 0, y: 0, w: 120, h: 80 },      // тело старта
      { x: 600, y: 0, w: 120, h: 80 },    // тело цели
      { x: 280, y: -400, w: 60, h: 360 },
      { x: 280, y: -20, w: 60, h: 120 },
      { x: 280, y: 120, w: 60, h: 360 },
    ];
    const starts = [{ point: { x: 120, y: 40 }, side: "right" as const }];
    const ends = [{ point: { x: 600, y: 40 }, side: "left" as const }];

    const before = __routeCounters.budgetGreedyCalls;
    const full = routePorts(starts, ends, obstacles);
    expect(full, "контрольный полный поиск обязан найти маршрут").not.toBeNull();
    expect(__routeCounters.budgetGreedyCalls, "полный поиск в потолок не упирается").toBe(before);

    const greedy = routePorts(starts, ends, obstacles, { expansionCap: 1 });
    expect(__routeCounters.budgetGreedyCalls, "счётчик гриди-фолбэка обязан вырасти")
      .toBeGreaterThan(before);
    expect(greedy, "гриди-фолбэк обязан вернуть маршрут, а не null (E18)").not.toBeNull();
    const pts = greedy?.pts ?? [];
    // E19: маршрут не режет тела.
    expect(pathCrossesRects(pts, obstacles), "гриди-маршрут прорезал тело (E19)").toBe(false);
    // E9: стабы направленных портов на месте — ломаная начинается и кончается хэндлами.
    expect(pts[0]).toEqual(starts[0].point);
    expect(pts[pts.length - 1]).toEqual(ends[0].point);
    // E14: ортогональность — каждый сегмент осевой.
    for (let i = 1; i < pts.length; i++) {
      const dx = Math.abs(pts[i].x - pts[i - 1].x), dy = Math.abs(pts[i].y - pts[i - 1].y);
      expect(dx < 0.5 || dy < 0.5, `сегмент ${i} не осевой`).toBe(true);
    }
    // ДЕТЕРМИНИЗМ ступени: тот же вход и тот же потолок → тот же маршрут побитово.
    const again = routePorts(starts, ends, obstacles, { expansionCap: 1 });
    expect(JSON.stringify(again?.pts)).toBe(JSON.stringify(pts));
  });

  it("потолок по умолчанию (CALL_EXPANSION_CAP) на обычном поиске не срабатывает", () => {
    const obstacles: NodeRect[] = [
      { x: 0, y: 0, w: 120, h: 80 }, { x: 600, y: 0, w: 120, h: 80 },
      { x: 280, y: -20, w: 60, h: 120 },
    ];
    const before = __routeCounters.budgetGreedyCalls;
    routePorts(
      [{ point: { x: 120, y: 40 }, side: "right" }],
      [{ point: { x: 600, y: 40 }, side: "left" }],
      obstacles,
    );
    expect(__routeCounters.budgetGreedyCalls).toBe(before);
  });
});

describe("бюджет работ роутера — страховочная калибровка дефолта (P12)", () => {
  it("(iv) на фазз-сценах с ДЕФОЛТНЫМ бюджетом ни одна ступень не срабатывает", () => {
    for (const seed of [1, 2, 3, 5, 8, 13, 21, 34]) {
      const scene = generateScene(seed);
      const budget = createRouteBudget({
        nodes: scene.displayIds.length, edges: scene.groups.length,
      });
      buildAutoRoutes({
        groups: scene.groups,
        routableIds: scene.routableIds,
        positions: scene.positions,
        displayIds: scene.displayIds,
        sizes: scene.sizes,
        frames: scene.frames,
        frameEndpoints: scene.frameEndpoints,
        budget,
      });
      expect(budget.apriori, `сид ${seed}: априорный контур сработал на фазз-сцене`).toBe(false);
      expect(budget.result(), `сид ${seed}: ступень бюджета сработала на фазз-сцене`).toBeNull();
    }
  }, 300_000);

  it("прогноз оставляет каждому эталону кратный запас до лимита его класса", () => {
    // Замер Ф5 (реплей, HEAD Ф4-II): фактические экспансии полного прогона стадий.
    const etalons: { name: string; nodes: number; edges: number; actual: number }[] = [
      { name: "zabbix-root", nodes: 36, edges: 85, actual: 13_530_000 },
      { name: "sentry-root", nodes: 51, edges: 128, actual: 15_790_000 },
      { name: "level-zabbix-server", nodes: 29, edges: 60, actual: 4_530_000 },
      { name: "level-sentry-level", nodes: 31, edges: 68, actual: 1_820_000 },
    ];
    for (const e of etalons) {
      const limit = ROUTE_BUDGET_BY_CLASS[classifyScene(e.nodes, e.edges)];
      // (1) факт кратно ниже лимита — реактивный контур на эталонах не включается;
      expect(e.actual * 2, `${e.name}: фактический расход слишком близок к лимиту`)
        .toBeLessThan(limit);
      // (2) прогноз — ВЕРХНЯЯ ОГИБАЮЩАЯ: не ниже факта, но и не выше 70% лимита —
      //     априорный контур включится только на сцене в ~1.5 раза крупнее эталона,
      //     а сам эталон он деградировать не может.
      const f = forecastExpansions(e.nodes, e.edges);
      expect(f, `${e.name}: прогноз ниже факта — огибающая не огибает`).toBeGreaterThan(e.actual);
      expect(f, `${e.name}: прогноз слишком близок к лимиту`).toBeLessThan(limit * 0.7);
    }
  });

  it("внутри «типовой» сцены априорный контур не срабатывает никогда", () => {
    // Худший угол класса (P1: ≤50 узлов И ≤100 рёбер) обязан остаться под лимитом:
    // класс, которому P2 обещает бюджет, ступеней с самого старта не получает.
    expect(forecastExpansions(50, 100)).toBeLessThan(ROUTE_BUDGET_BY_CLASS.typical);
    expect(createRouteBudget({ nodes: 50, edges: 100 }).apriori).toBe(false);
  });
});
