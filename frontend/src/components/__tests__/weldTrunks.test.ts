// Ф2 эпика «общие плечи v2» (docs/archive/plan-arrow-trunks.md): сварка исходящих стволов.
import { describe, expect, it } from "vitest";
import { weldTrunks } from "../graph/layout/weldTrunks";
import type { EdgePoint } from "../../types";

const P = (x: number, y: number): EdgePoint => ({ x, y });

// Лидер веера: Г-маршрут с двумя изломами. Follower стартует из того же порта (0,0).
const leader = (): EdgePoint[] => [P(0, 0), P(150, 0), P(150, 100), P(300, 100)];
// Текущий маршрут follower-а: ушёл вверх своим путём (расхождение прямо в порту).
const followerCur = (): EdgePoint[] => [P(0, 0), P(0, 140), P(300, 140)];

const weldedShape = [P(0, 0), P(150, 0), P(150, 140), P(300, 140)];

describe("weldTrunks — сварка исходящих стволов (E78)", () => {
  // routableIds здесь и ниже сужен до follower-а: с кандидатами-проекциями (E79)
  // в этих сценах иначе честно сваривается сам лидер к стволу follower-а, а тесты
  // проверяют именно перенятие через излом.
  it("follower перенимает префикс лидера через излом при строгом выигрыше чернил", () => {
    const routes = new Map([["a", leader()], ["b", followerCur()]]);
    const welded = weldTrunks({
      routes,
      routableIds: new Set(["b"]),
      // чужая линия, которую текущий маршрут b пересекает крестом — сварной путь чище
      preplaced: [[P(80, 100), P(80, 200)]],
      obstacles: [],
    });
    expect([...welded]).toEqual(["b"]);
    // выигрывает более глубокое перенятие (до второго излома лидера): общий ствол 250px
    expect(routes.get("b")).toEqual(weldedShape);
    expect(routes.get("a")).toEqual(leader()); // лидер не тронут
  });

  it("сварка ради слияния: принимается и без выигрыша по грязи (чистая сцена)", () => {
    const routes = new Map([["a", leader()], ["b", followerCur()]]);
    const welded = weldTrunks({ routes, routableIds: new Set(["b"]), obstacles: [] });
    expect([...welded]).toEqual(["b"]);
    expect(routes.get("b")).toEqual(weldedShape);
  });

  it("дорогой обход не покупается бонусом: тело между стволом и доком — отказ", () => {
    // follower идёт низом (y=200) чисто; хвост от любого излома лидера к доку упирается
    // в тело и вынужден в большой обход — «чернила» кандидатов хуже, сварки нет
    const routes = new Map<string, EdgePoint[]>([
      ["a", leader()],
      ["b", [P(0, 0), P(0, 200), P(300, 200)]],
    ]);
    const before = JSON.parse(JSON.stringify([...routes]));
    const welded = weldTrunks({
      routes,
      routableIds: new Set(["b"]),
      obstacles: [{ x: 100, y: 120, w: 260, h: 40 }],
    });
    expect(welded.size).toBe(0);
    expect(JSON.parse(JSON.stringify([...routes]))).toEqual(before);
  });

  it("mid-segment: расставание проекцией дока посреди прямого ствола (E79)", () => {
    // у лидера-прямой изломов нет — изломные кандидаты пусты; проекция дока (250,60)
    // на ствол даёт расставание (250,0) с поворотом строго напротив дока
    const routes = new Map<string, EdgePoint[]>([
      ["a", [P(0, 0), P(400, 0)]],
      ["b", [P(0, 0), P(0, 60), P(250, 60)]],
    ]);
    const welded = weldTrunks({ routes, routableIds: new Set(["b"]), obstacles: [] });
    expect([...welded]).toEqual(["b"]);
    expect(routes.get("b")).toEqual([P(0, 0), P(250, 0), P(250, 60)]);
    expect(routes.get("a")).toEqual([P(0, 0), P(400, 0)]);
  });

  it("mid-segment зеркально: T-слияние сбоку во входящий ствол (E79)", () => {
    // вход: общий порт-цель (0,0); follower вливается в прямой ствол лидера посреди
    // сегмента и доходит до хэндла вместе (в реальном пространстве — T-подход сбоку)
    const routes = new Map<string, EdgePoint[]>([
      ["a", [P(400, 0), P(0, 0)]],
      ["b", [P(250, 60), P(0, 60), P(0, 0)]],
    ]);
    const welded = weldTrunks({ routes, routableIds: new Set(["b"]), obstacles: [] });
    expect([...welded]).toEqual(["b"]);
    expect(routes.get("b")).toEqual([P(250, 60), P(250, 0), P(0, 0)]);
    expect(routes.get("a")).toEqual([P(400, 0), P(0, 0)]);
  });

  it("ступень «грязь не хуже»: перенятый префикс с нелегальной ездой отвергается", () => {
    // Собрат m сам едет по чужой линии L (нелегально): перенятие его префикса
    // принесло бы follower-у 200px чужой езды — бонус слияния это не покупает.
    const routes = new Map<string, EdgePoint[]>([
      ["m", [P(0, 0), P(200, 0), P(200, 150)]],
      ["b", [P(0, 0), P(0, 100), P(300, 100)]],
    ]);
    const before = JSON.parse(JSON.stringify([...routes]));
    const welded = weldTrunks({
      routes,
      routableIds: new Set(["m", "b"]),
      preplaced: [[P(-50, 0), P(250, 0)]], // чужая линия L под префиксом m
      obstacles: [],
    });
    expect(welded.has("b")).toBe(false);
    expect(routes.get("b")).toEqual(JSON.parse(JSON.stringify(before))[1][1]);
  });

  it("идемпотентность: повторный прогон на сваренном — no-op", () => {
    const routes = new Map([["a", leader()], ["b", followerCur()]]);
    weldTrunks({ routes, routableIds: new Set(["a", "b"]), obstacles: [] });
    const snapshot = JSON.parse(JSON.stringify([...routes]));
    const again = weldTrunks({ routes, routableIds: new Set(["a", "b"]), obstacles: [] });
    expect(again.size).toBe(0);
    expect(JSON.parse(JSON.stringify([...routes]))).toEqual(snapshot);
  });

  it("preplaced-собрат — легальный лидер (мини-проход: prev-контекст)", () => {
    const routes = new Map([["b", followerCur()]]);
    const welded = weldTrunks({
      routes,
      routableIds: new Set(["b"]),
      preplaced: [leader()],
      obstacles: [],
    });
    expect([...welded]).toEqual(["b"]);
    expect(routes.get("b")).toEqual(weldedShape);
  });

  it("входящий веер: follower перенимает СУФФИКС лидера через излом (E79)", () => {
    // зеркало сценария префиксов: общий порт-цель (0,0)
    const inLeader = [P(300, 100), P(150, 100), P(150, 0), P(0, 0)];
    const inFollower = [P(300, 140), P(0, 140), P(0, 0)];
    const routes = new Map([["a", inLeader], ["b", inFollower]]);
    const welded = weldTrunks({ routes, routableIds: new Set(["b"]), obstacles: [] });
    expect([...welded]).toEqual(["b"]);
    // слился на (150,140)→(150,0) и дошёл до хэндла вместе с лидером
    expect(routes.get("b")).toEqual([P(300, 140), P(150, 140), P(150, 0), P(0, 0)]);
    expect(routes.get("a")).toEqual(inLeader);
  });

  it("входящий веер: повторный прогон идемпотентен", () => {
    const routes = new Map([
      ["a", [P(300, 100), P(150, 100), P(150, 0), P(0, 0)]],
      ["b", [P(300, 140), P(0, 140), P(0, 0)]],
    ]);
    weldTrunks({ routes, routableIds: new Set(["a", "b"]), obstacles: [] });
    const snapshot = JSON.parse(JSON.stringify([...routes]));
    const again = weldTrunks({ routes, routableIds: new Set(["a", "b"]), obstacles: [] });
    expect(again.size).toBe(0);
    expect(JSON.parse(JSON.stringify([...routes]))).toEqual(snapshot);
  });

  it("детерминизм: два прогона на копиях дают одинаковый результат", () => {
    const mk = (): Map<string, EdgePoint[]> =>
      new Map([
        ["a", leader()],
        ["b", followerCur()],
        ["c", [P(0, 0), P(0, -80), P(260, -80)]],
      ]);
    const r1 = mk(), r2 = mk();
    weldTrunks({ routes: r1, routableIds: new Set(r1.keys()), obstacles: [] });
    weldTrunks({ routes: r2, routableIds: new Set(r2.keys()), obstacles: [] });
    expect(JSON.parse(JSON.stringify([...r1]))).toEqual(JSON.parse(JSON.stringify([...r2])));
  });
});

// Детектор ТРОЙНИКА: осевая прямая, где интервалы ≥ 3 маршрутов имеют общий
// пробел > 0.5px. Общее плечо легально только ПОПАРНО (E25) — тройник на одной
// линии означает, что какая-то пара едет вместе без общего порта.
function tripleLines(routes: Map<string, EdgePoint[]>): Array<{ line: string; ids: string[] }> {
  const lines = new Map<string, Array<{ lo: number; hi: number; id: string }>>();
  for (const [id, pts] of routes) {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const horiz = Math.abs(b.y - a.y) <= 0.5;
      const vert = Math.abs(b.x - a.x) <= 0.5;
      if (horiz === vert) continue;
      if (Math.abs(b.x - a.x) + Math.abs(b.y - a.y) <= 3) continue;
      const k = `${horiz ? "h" : "v"}|${Math.round((horiz ? a.y : a.x) * 2) / 2}`;
      const lo = horiz ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
      const hi = horiz ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
      (lines.get(k) ?? lines.set(k, []).get(k)!).push({ lo, hi, id });
    }
  }
  const out: Array<{ line: string; ids: string[] }> = [];
  for (const [line, segs] of lines) {
    const events: Array<[number, number, string]> = [];
    for (const s of segs) { events.push([s.lo, 1, s.id], [s.hi, -1, s.id]); }
    events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const active = new Set<string>();
    let prev: number | null = null;
    for (const [x, d, id] of events) {
      if (prev !== null && x - prev > 0.5 && active.size >= 3) out.push({ line, ids: [...active] });
      if (d === 1) active.add(id); else active.delete(id);
      prev = x;
    }
  }
  return out;
}

describe("weldTrunks — граница тройника (E25: общее плечо — попарно)", () => {
  // Диагноз 2026-08-01: носитель-прямая, чей «префикс от источника» и «суффикс к
  // цели» — один и тот же сегмент; два веера (исходящий и входящий) свариваются на
  // нём с перехлёстом → третья пара без общего порта едет вместе. Граница: перенятый
  // кусок не заходит в зону, где по носителю едет связь, не родственный follower-у.

  it("out-сварка укорачивается до зоны неродственного всадника", () => {
    // m — прямая (0,0)→(300,0). a (общая ЦЕЛЬ (300,0) с m) уже едет по суффиксу
    // [150,300]. c (общий ИСТОЧНИК (0,0) с m) перенимает префикс — но a и c не делят
    // ничего: кусок c обрывается на (150,0), тройник не возникает.
    const routes = new Map<string, EdgePoint[]>([
      ["m", [P(0, 0), P(300, 0)]],
      ["a", [P(150, -150), P(150, 0), P(300, 0)]],
      ["c", [P(0, 0), P(0, 150), P(250, 150)]],
    ]);
    const welded = weldTrunks({ routes, routableIds: new Set(["c", "a"]), obstacles: [] });
    expect(welded.has("c")).toBe(true);
    // расставание на границе зоны a — перпендикулярно стволу, без заезда в зону
    expect(routes.get("c")).toEqual([P(0, 0), P(150, 0), P(150, 150), P(250, 150)]);
    expect(tripleLines(routes)).toEqual([]);
  });

  it("in-сварка укорачивается до зоны неродственного всадника (зеркально)", () => {
    // c первым легально забирает весь префикс m (док напротив (250,0)); a сваривает
    // суффикс — но c и a не делят ничего: слияние a усекается к границе зоны c,
    // подходя к шву перпендикулярно (чистый T-стык в точке (250,0)).
    const routes = new Map<string, EdgePoint[]>([
      ["m", [P(0, 0), P(300, 0)]],
      ["c", [P(0, 0), P(0, 150), P(250, 150)]],
      ["a", [P(150, -150), P(150, -75), P(300, -75), P(300, 0)]],
    ]);
    const welded = weldTrunks({ routes, routableIds: new Set(["c", "a"]), obstacles: [] });
    expect(welded.has("c")).toBe(true);
    expect(welded.has("a")).toBe(true);
    expect(routes.get("c")).toEqual([P(0, 0), P(250, 0), P(250, 150)]);
    expect(routes.get("a")).toEqual([P(150, -150), P(250, -150), P(250, 0), P(300, 0)]);
    expect(tripleLines(routes)).toEqual([]);
  });

  it("легальная тройка веера из одного порта границей не режется", () => {
    // m, a, c делят ИСТОЧНИК (0,0): a едет по m легально относительно c (общий порт
    // — их собственный префикс покроет перекрытие) — границы нет, c перенимает
    // префикс целиком.
    const routes = new Map<string, EdgePoint[]>([
      ["m", [P(0, 0), P(300, 0), P(300, 200)]],
      ["a", [P(0, 0), P(300, 0)]],
      ["c", [P(0, 0), P(0, 150), P(250, 150)]],
    ]);
    const welded = weldTrunks({ routes, routableIds: new Set(["c"]), obstacles: [] });
    expect(welded.has("c")).toBe(true);
    expect(routes.get("c")).toEqual([P(0, 0), P(250, 0), P(250, 150)]);
  });
});
