import { describe, it, expect } from "vitest";
import { spread1D } from "../graph/layout/pav";

// Изотоническое раздвижение точек (PAV). Проверяем: сохранение зазора, минимальность
// (симметрия вокруг центра масс), невмешательство в уже разнесённые, порядок входа.

describe("spread1D", () => {
  it("пустой и одиночный вход", () => {
    expect(spread1D([], 100)).toEqual([]);
    expect(spread1D([42], 100)).toEqual([42]);
  });

  it("уже разнесённые точки не двигаются", () => {
    expect(spread1D([0, 200, 400], 100)).toEqual([0, 200, 400]);
  });

  it("две совпадающие — симметрично вокруг общего desired (а не стопкой вниз)", () => {
    // d=[10,10], gap=100 → [10−50, 10+50]
    expect(spread1D([10, 10], 100)).toEqual([-40, 60]);
  });

  it("сохраняет зазор и центр масс при тесной группе", () => {
    const out = spread1D([0, 10, 20], 100);
    // зазоры ровно gap (всё слиплось → один пул)
    expect(out[1] - out[0]).toBeCloseTo(100);
    expect(out[2] - out[1]).toBeCloseTo(100);
    // центр масс сохранён (минимальность L2): mean(out) == mean(desired) == 10
    expect((out[0] + out[1] + out[2]) / 3).toBeCloseTo(10);
  });

  it("частичное слипание: дальняя точка не трогается", () => {
    // d=[0,10,200], gap=100: первые две слипаются вокруг 5, третья свободна
    const out = spread1D([0, 10, 200], 100);
    expect(out[0]).toBeCloseTo(-45);
    expect(out[1]).toBeCloseTo(55);
    expect(out[2]).toBeCloseTo(200);
  });

  it("возвращает координаты в ИСХОДНОМ порядке входа", () => {
    // вход не отсортирован: индексы 0,1,2 имеют desired 10,10,-300
    const out = spread1D([10, 10, -300], 100);
    // -300 — самый левый (порядок [2,0,1]); проверяем, что out[2] — наименьший
    expect(out[2]).toBeLessThan(out[0]);
    expect(out[2]).toBeLessThan(out[1]);
    // и зазоры соблюдены в отсортированном порядке
    const sorted = [...out].sort((a, b) => a - b);
    expect(sorted[1] - sorted[0]).toBeGreaterThanOrEqual(100 - 1e-9);
    expect(sorted[2] - sorted[1]).toBeGreaterThanOrEqual(100 - 1e-9);
  });

  it("нулевой зазор → точки остаются на месте (нет ограничения)", () => {
    expect(spread1D([5, 5, 5], 0)).toEqual([5, 5, 5]);
  });
});
