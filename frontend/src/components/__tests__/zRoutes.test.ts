import { describe, it, expect } from "vitest";
import { zRoutes, Z_CLEAR, LANE_GAP_MIN } from "../graph/layout/zRoutes";
import { assignPorts } from "../graph/layout/ports";
import { NUDGE_GAP } from "../graph/layout/channelNudge";
import { pathCrossesRects, type NodeRect } from "../graph/edgePath";
import type { EdgePoint } from "../../types";

// Z-маршруты с упорядочением дорожек (Ф2 эпика «стрелки без жёстких хэндлов», R5):
// стаб — дорожка в канале — стаб; дорожки одного канала разведены равным шагом и
// упорядочены по крестам (как OrthogonalRoutingGenerator ELK); грязный Z уступает A*.

const R = (x: number, y: number, w = 190, h = 100): NodeRect => ({ x, y, w, h });
const g = (id: string, source: string, target: string) => ({ id, source, target });

// сцена: прямоугольники + группы → порты (ports.ts) → Z
function run(rects: Map<string, NodeRect>, groups: Array<{ id: string; source: string; target: string }>, opts?: {
  obstacles?: NodeRect[]; hard?: NodeRect[];
}) {
  const { ports } = assignPorts({ groups, rects });
  const obstacles = opts?.obstacles ?? [...rects.values()];
  return zRoutes({
    groups, ports, obstacles,
    rectOf: (id) => rects.get(id),
    hardOf: opts?.hard ? () => opts.hard ?? [] : undefined,
  });
}
const laneY = (pts: EdgePoint[]): number => pts[1].y;      // дорожка Z при оси "v": y второй точки
const laneX = (pts: EdgePoint[]): number => pts[1].x;
const crosses = (a: EdgePoint[], b: EdgePoint[]): number => {
  let n = 0;
  for (let i = 1; i < a.length; i++) {
    for (let j = 1; j < b.length; j++) {
      const ah = Math.abs(a[i].y - a[i - 1].y) <= 0.5, bh = Math.abs(b[j].y - b[j - 1].y) <= 0.5;
      if (ah === bh) continue;
      const h = ah ? [a[i - 1], a[i]] : [b[j - 1], b[j]];
      const v = ah ? [b[j - 1], b[j]] : [a[i - 1], a[i]];
      const hx0 = Math.min(h[0].x, h[1].x), hx1 = Math.max(h[0].x, h[1].x);
      const vy0 = Math.min(v[0].y, v[1].y), vy1 = Math.max(v[0].y, v[1].y);
      if (v[0].x > hx0 + 0.5 && v[0].x < hx1 - 0.5 && h[0].y > vy0 + 0.5 && h[0].y < vy1 - 0.5) n++;
    }
  }
  return n;
};

describe("zRoutes — форма маршрута", () => {
  it("две связи хаба к детям слева-снизу: Z из четырёх точек, дорожки в канале с шагом NUDGE_GAP", () => {
    const rects = new Map([["H", R(1000, 0)], ["A", R(0, 300)], ["B", R(500, 300)]]);
    const { routes } = run(rects, [g("a", "H", "A"), g("b", "H", "B")]);
    const a = routes.get("a")!, b = routes.get("b")!;
    expect(a).toHaveLength(4);
    expect(b).toHaveLength(4);
    // стабы вдоль нормали: первый сегмент вертикальный из нижней грани хаба (y=100)
    expect(a[0].y).toBe(100);
    expect(a[1].x).toBe(a[0].x);
    expect(a[3].y).toBe(300);
    expect(a[2].x).toBe(a[3].x);
    // дорожки лежат в канале (100 + клиренс … 300 − клиренс) и разведены на шаг
    for (const pts of [a, b]) {
      expect(laneY(pts)).toBeGreaterThanOrEqual(100 + Z_CLEAR);
      expect(laneY(pts)).toBeLessThanOrEqual(300 - Z_CLEAR);
    }
    expect(Math.abs(laneY(a) - laneY(b))).toBeCloseTo(NUDGE_GAP, 5);
    // стопка центрирована в канале; дальняя связь — выше (её спуск не режет ближнюю)
    expect((laneY(a) + laneY(b)) / 2).toBeCloseTo(200, 0);
    expect(laneY(a)).toBeLessThan(laneY(b));
    expect(crosses(a, b)).toBe(0);
  });

  it("дорожки без общего пробега делят одну линию канала (как у ELK)", () => {
    const rects = new Map([["H", R(500, 0)], ["A", R(0, 300)], ["B", R(1000, 300)]]);
    const { routes } = run(rects, [g("a", "H", "A"), g("b", "H", "B")]);
    expect(laneY(routes.get("a")!)).toBe(200);
    expect(laneY(routes.get("b")!)).toBe(200);
  });

  it("порты в одной колонне — прямая из двух точек", () => {
    const rects = new Map([["A", R(0, 0)], ["B", R(0, 300)]]);
    const { routes } = run(rects, [g("e", "A", "B")]);
    expect(routes.get("e")).toEqual([{ x: 95, y: 100 }, { x: 95, y: 300 }]);
  });

  it("ось слева направо: дорожка вертикальная", () => {
    // B и C правее A в одной колонне, по вертикали вровень/внахлёст с A — ось "h";
    // пробеги их дорожек (по y) перекрываются — две дорожки в одном канале
    const rects = new Map([["A", R(0, 0)], ["B", R(800, 20)], ["C", R(800, 110)]]);
    const { routes } = run(rects, [g("b", "A", "B"), g("c", "A", "C")]);
    const b = routes.get("b")!, c = routes.get("c")!;
    expect(b[0].x).toBe(190);                 // правая грань A
    expect(b[1].y).toBe(b[0].y);              // стаб горизонтальный
    expect(laneX(b)).toBeGreaterThanOrEqual(190 + Z_CLEAR);
    expect(laneX(b)).toBeLessThanOrEqual(800 - Z_CLEAR);
    expect(Math.abs(laneX(b) - laneX(c))).toBeCloseTo(NUDGE_GAP, 5);
  });

  it("обратная связь (цель выше источника): стаб вверх, дорожка в том же канале", () => {
    const rects = new Map([["T", R(500, 0)], ["S", R(0, 300)]]);
    const { routes } = run(rects, [g("up", "S", "T")]);
    const up = routes.get("up")!;
    expect(up[0].y).toBe(300);                // верхняя грань S
    expect(up[up.length - 1].y).toBe(100);    // нижняя грань T
    expect(laneY(up)).toBeGreaterThan(100);
    expect(laneY(up)).toBeLessThan(300);
  });
});

describe("zRoutes — порядок дорожек (кресты, как у ELK)", () => {
  it("две параллельные диагонали: порядок дорожек снимает оба креста", () => {
    // A → C и B → D идут вниз-вправо, пробеги перекрываются: при «AC над BD» спуск AC
    // режет дорожку BD, а подъём BD — дорожку AC (два креста); при «BD над AC» — ноль.
    const rects = new Map([["A", R(0, 0)], ["B", R(400, 0)], ["C", R(600, 300)], ["D", R(1000, 300)]]);
    const { routes } = run(rects, [g("ac", "A", "C"), g("bd", "B", "D")]);
    const ac = routes.get("ac")!, bd = routes.get("bd")!;
    expect(crosses(ac, bd)).toBe(0);
    expect(laneY(bd)).toBeLessThan(laneY(ac));
  });

  it("симметричный перекрёст в общих колоннах: один из двух Z уступает A* (слитые стабы)", () => {
    // A → D и B → C: спуски и подъёмы пар стоят в одних колоннах (x=95 и x=1095) — при
    // любом порядке вертикали двух дорожек наложились бы между дорожками (ELK здесь
    // режет сегмент надвое); мы отдаём проигравшего A*.
    const rects = new Map([["A", R(0, 0)], ["B", R(1000, 0)], ["C", R(0, 300)], ["D", R(1000, 300)]]);
    const { routes } = run(rects, [g("ad", "A", "D"), g("bc", "B", "C")]);
    expect(routes.size).toBe(1);
  });

  it("веер хаба к трём детям: дорожки не пересекаются между собой", () => {
    const rects = new Map([["H", R(600, 0)], ["A", R(0, 300)], ["B", R(600, 300)], ["C", R(1200, 300)]]);
    const { routes } = run(rects, [g("a", "H", "A"), g("b", "H", "B"), g("c", "H", "C")]);
    const pts = ["a", "b", "c"].map((id) => routes.get(id)!);
    expect(pts.every((p) => p.length >= 2)).toBe(true);
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expect(crosses(pts[i], pts[j])).toBe(0);
  });

  it("почти слитые вертикали (конфликт ELK) уступают порядку без наложения", () => {
    // A → D и B → C: спуск A к D и подъём B от U_B стоят в одной колонне x ≈ 1095.
    // Порядок «A над B» склеил бы вертикали между дорожками; «B над A» чист.
    const rects = new Map([["A", R(0, 0)], ["B", R(1000, 0)], ["C", R(400, 300)], ["D", R(1000, 300)]]);
    const { routes } = run(rects, [g("ad", "A", "D"), g("bc", "B", "C")]);
    const ad = routes.get("ad")!, bc = routes.get("bc")!;
    expect(ad).toBeDefined();
    expect(bc).toBeDefined();
    expect(laneY(bc)).toBeLessThan(laneY(ad));
  });

  it("детерминизм: результат не зависит от порядка групп", () => {
    const rects = new Map([["H", R(600, 0)], ["A", R(0, 300)], ["B", R(600, 300)], ["C", R(1200, 300)], ["X", R(1200, 0)]]);
    const groups = [g("a", "H", "A"), g("b", "H", "B"), g("c", "H", "C"), g("x", "X", "A"), g("y", "X", "B")];
    const r1 = run(rects, groups).routes;
    const r2 = run(rects, [...groups].reverse()).routes;
    expect([...r2.entries()].sort()).toEqual([...r1.entries()].sort());
  });
});

describe("zRoutes — чистота и отказ", () => {
  it("тело в колонне порта цели: Z нет (связь уходит A*)", () => {
    // между H и A, ровно над портом A и вплотную к нему, стоит узел O
    const rects = new Map([["H", R(500, 0)], ["A", R(0, 600)], ["O", R(0, 480)]]);
    const { routes } = run(rects, [g("a", "H", "A")]);
    expect(routes.has("a")).toBe(false);
  });

  it("тело на пробеге дорожки: дорожка уходит в свободный интервал канала", () => {
    // O перегораживает полосу y 230..330 между H (низ 100) и A (верх 600) на пути дорожки
    const rects = new Map([["H", R(500, 0)], ["A", R(0, 600)], ["O", R(200, 230, 190, 100)]]);
    const { routes } = run(rects, [g("a", "H", "A")]);
    const a = routes.get("a")!;
    expect(a).toBeDefined();
    expect(pathCrossesRects(a, [rects.get("O")!])).toBe(false);
    expect(laneY(a) < 230 - Z_CLEAR || laneY(a) > 330 + Z_CLEAR).toBe(true);
  });

  it("граница чужой рамки — жёсткая: сквозь неё не ходит ни Z, ни ZZ (обход вокруг)", () => {
    const rects = new Map([["H", R(500, 0)], ["A", R(0, 600)]]);
    const frame = R(-100, 150, 2000, 300); // перегораживает весь канал
    const { routes } = run(rects, [g("a", "H", "A")], { hard: [frame] });
    const a = routes.get("a")!;
    expect(a).toHaveLength(6);                               // ZZ вокруг рамки
    expect(pathCrossesRects(a, [frame])).toBe(false);
    expect(a[2].x).toBeLessThan(-100);                       // колонна слева от рамки
  });

  it("тесный канал: шаг сжимается до LANE_GAP_MIN, дальше — отказ лишних", () => {
    // канал высотой 60 (100..160) минус клиренсы = 36 px; хаб справа, все дети слева —
    // пробеги всех дорожек перекрываются: пять дорожек влезают с шагом 9, шесть — нет
    // (шаг упёрся бы в дно 8, крайние зажаты полосой и уступают A*)
    const scene = (n: number) => {
      const kids = ["A", "B", "C", "D", "E", "F"].slice(0, n);
      const rects = new Map<string, NodeRect>([["H", R(3000, 0)]]);
      kids.forEach((id, i) => rects.set(id, R(i * 500, 160)));
      const { routes } = run(rects, kids.map((id) => g(id.toLowerCase(), "H", id)));
      return kids.map((id) => routes.get(id.toLowerCase())).filter((p): p is EdgePoint[] => !!p).map(laneY).sort((p, q) => p - q);
    };
    const five = scene(5);
    expect(five).toHaveLength(5);
    for (let i = 1; i < five.length; i++) expect(five[i] - five[i - 1]).toBeCloseTo(9, 5);
    const six = scene(6);
    expect(six.length).toBeLessThan(6);
    for (let i = 1; i < six.length; i++) expect(six[i] - six[i - 1]).toBeGreaterThanOrEqual(LANE_GAP_MIN - 0.5);
  });

  it("узлы вплотную по оси потока: Z невозможен", () => {
    const rects = new Map([["A", R(0, 0)], ["B", R(40, 110)]]);
    const { routes } = run(rects, [g("e", "A", "B")]);
    expect(routes.has("e")).toBe(false);
  });

  it("подсказки A*: свободные дорожки по обе стороны стопки канала", () => {
    const rects = new Map([["H", R(1000, 0)], ["A", R(0, 300)], ["B", R(500, 300)]]);
    const { routes, gridHints } = run(rects, [g("a", "H", "A"), g("b", "H", "B")]);
    const lanes = [laneY(routes.get("a")!), laneY(routes.get("b")!)].sort((p, q) => p - q);
    expect(gridHints.ys).toEqual([lanes[0] - NUDGE_GAP, lanes[1] + NUDGE_GAP]);
    expect(gridHints.xs).toEqual([]);
  });
});

describe("zRoutes — ребро через слой (ZZ) и ключи портов", () => {
  // Слоистая сцена «корня»: M сверху, под ним слой из L (слева) и P (по центру), ниже —
  // K под P. Обратная связь K → M: колонна порта M перегорожена L, колонна порта K —
  // P; прямого Z нет, ZZ идёт свободной колонной между L и P.
  const rects = new Map([
    ["M", R(87, 408)], ["L", R(30, 786)], ["P", R(332, 786)], ["K", R(332, 1180)],
  ]);
  const groups = [g("mp", "M", "P"), g("ml", "M", "L"), g("lk", "L", "K"), g("pk", "P", "K"), g("km", "K", "M")];

  it("ZZ: две дорожки в каналах у концов и вертикаль в свободной колонне, крестов нет", () => {
    const { routes } = run(rects, groups);
    const km = routes.get("km")!;
    expect(km).toHaveLength(6);
    // колонна между L (правый край 220) и P (левый край 332) с клиренсом
    const col = km[2].x;
    expect(km[3].x).toBe(col);
    expect(col).toBeGreaterThanOrEqual(220 + Z_CLEAR);
    expect(col).toBeLessThanOrEqual(332 - Z_CLEAR);
    // нижняя дорожка — в канале L/P ↔ K, верхняя — в канале M ↔ L/P
    expect(km[1].y).toBeGreaterThan(886 + Z_CLEAR - 0.5);
    expect(km[1].y).toBeLessThan(1180);
    expect(km[4].y).toBeGreaterThan(508);
    expect(km[4].y).toBeLessThan(786);
    for (const id of ["mp", "ml", "lk", "pk"]) expect(crosses(km, routes.get(id)!)).toBe(0);
  });

  it("ключи портов: концы ZZ сортируются по колонне, нижний конец длинного Z — по центру своего узла", () => {
    const { portKeys } = run(rects, groups);
    const km = portKeys.get("km")!;
    expect(km.s).toBeDefined();
    expect(km.t).toBe(km.s);
    // длинный Z: колонны портов свободны, но пробег дорожки пересекает слой (Mid) —
    // дорожка в канале у H (ранний излом), до B — длинная вертикаль сквозь нижний канал;
    // ключ у B — центр B (895), у H — обычный (дальний центр)
    const rects2 = new Map([["H", R(0, 0)], ["Mid", R(400, 300)], ["B", R(800, 700)], ["C", R(400, 700)]]);
    const { portKeys: pk2, routes: r2 } = run(rects2, [g("hb", "H", "B"), g("mc", "Mid", "C")]);
    const hb = r2.get("hb")!;
    expect(hb).toHaveLength(4);
    expect(hb[1].y).toBeLessThan(300);                       // дорожка в верхнем канале
    expect(pk2.get("hb")).toEqual({ t: 895 });
    expect(pk2.has("mc")).toBe(false);
  });
});
