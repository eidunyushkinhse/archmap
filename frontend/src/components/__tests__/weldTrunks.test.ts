// Ф2 эпика «общие плечи v2» (docs/plan-arrow-trunks.md): сварка исходящих стволов.
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
  it("follower перенимает префикс лидера через излом при строгом выигрыше чернил", () => {
    const routes = new Map([["a", leader()], ["b", followerCur()]]);
    const welded = weldTrunks({
      routes,
      routableIds: new Set(["a", "b"]),
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
    const welded = weldTrunks({ routes, routableIds: new Set(["a", "b"]), obstacles: [] });
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
      routableIds: new Set(["a", "b"]),
      obstacles: [{ x: 100, y: 120, w: 260, h: 40 }],
    });
    expect(welded.size).toBe(0);
    expect(JSON.parse(JSON.stringify([...routes]))).toEqual(before);
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
