// Ф5 эпика arrow-trunks (E80): хит-тест общего плеча для двойного клика.
import { describe, expect, it } from "vitest";
import { trunkHitAt } from "../graph/trunkHit";
import type { EdgePoint } from "../../types";

const P = (x: number, y: number): EdgePoint => ({ x, y });

// исходящий веер: A и B делят префикс (0,0)→(150,0)→(150,100), расходятся на изломе
const A = { id: "A", pts: [P(0, 0), P(150, 0), P(150, 100), P(300, 100)] };
const B = { id: "B", pts: [P(0, 0), P(150, 0), P(150, 100), P(150, 220)] };
// входящий веер: C и D сливаются на (400,50)→(400,200)→(260,200)
const C = { id: "C", pts: [P(500, -40), P(400, -40), P(400, 200), P(260, 200)] };
const D = { id: "D", pts: [P(460, 50), P(400, 50), P(400, 200), P(260, 200)] };
const scene = [A, B, C, D];

describe("trunkHitAt", () => {
  it("клик на общем префиксе (в т.ч. за изломом) → исходящий ствол", () => {
    const h1 = trunkHitAt(scene, "A", P(80, 2)); // первый сегмент префикса
    expect(h1).toEqual({ kind: "out", memberIds: ["A", "B"] });
    const h2 = trunkHitAt(scene, "B", P(151, 60)); // второй сегмент, после общего излома
    expect(h2).toEqual({ kind: "out", memberIds: ["B", "A"] });
  });

  it("клик на уникальном хвосте после расхождения → не ствол", () => {
    expect(trunkHitAt(scene, "A", P(240, 100))).toBeNull();
    expect(trunkHitAt(scene, "B", P(150, 180))).toBeNull();
  });

  it("клик на общем суффиксе → входящий ствол", () => {
    const h = trunkHitAt(scene, "C", P(400, 120));
    expect(h).toEqual({ kind: "in", memberIds: ["C", "D"] });
    expect(trunkHitAt(scene, "D", P(300, 199))).toEqual({ kind: "in", memberIds: ["D", "C"] });
  });

  it("клик на уникальном подходе до слияния → не ствол", () => {
    expect(trunkHitAt(scene, "C", P(450, -40))).toBeNull();
    expect(trunkHitAt(scene, "D", P(430, 50))).toBeNull();
  });

  it("промах мимо линии (за допуском) → null", () => {
    expect(trunkHitAt(scene, "A", P(80, 30))).toBeNull();
  });

  it("одиночное ребро без собратьев → null", () => {
    const solo = [{ id: "S", pts: [P(0, 300), P(200, 300)] }];
    expect(trunkHitAt(solo, "S", P(100, 300))).toBeNull();
  });
});
