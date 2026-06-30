import { describe, it, expect } from "vitest";
import { labelDetour } from "../graph/layout/labelDetours";
import type { NodeRect } from "../graph/edgePath";
import type { Size } from "../graph/layout/labelBox";

const rect = (x: number, y: number, w = 190, h = 100): NodeRect => ({ x, y, w, h });
const box = (w: number, h: number): Size => ({ w, h });
const OPTS = { margin: 8, maxExtraLen: 10000 };
// есть ли в маршруте точка на заданной координате
const hasY = (route: { x: number; y: number }[], y: number): boolean => route.some((p) => Math.abs(p.y - y) < 0.5);
const hasX = (route: { x: number; y: number }[], x: number): boolean => route.some((p) => Math.abs(p.x - x) < 0.5);

describe("labelDetour (альт-маршрут грузного ребра, A12)", () => {
  it("горизонтальное плечо, низ свободен → детур вниз, плашка вмещается", () => {
    // ObsCore↔Объекты: соседние узлы на одной высоте, 5-строчная плашка
    const source = rect(164, 270);
    const target = rect(588, 270);
    const d = labelDetour({ source, target, obstacles: [], box: box(211, 96), ...OPTS });
    expect(d).not.toBeNull();
    expect(d!.sSide).toBe("bottom");
    expect(d!.tSide).toBe("bottom");
    // lane ниже ряда узлов: y = низ узла(370) + box.h/2(48) + margin(8) = 426
    expect(hasY(d!.route, 426)).toBe(true);
    expect(d!.center.y).toBeCloseTo(426, 0);
    expect(d!.preferredT).toBeGreaterThan(0);
    expect(d!.preferredT).toBeLessThan(1);
  });

  it("низ перекрыт узлом под источником → уходит ВВЕРХ", () => {
    const source = rect(164, 270);
    const target = rect(588, 270);
    const blocker = rect(164, 400); // прямо под источником — детур-вниз его прорежет
    const d = labelDetour({ source, target, obstacles: [blocker], box: box(211, 96), ...OPTS });
    expect(d).not.toBeNull();
    expect(d!.sSide).toBe("top");
    // lane выше ряда: y = верх узла(270) − 48 − 8 = 214
    expect(hasY(d!.route, 214)).toBe(true);
  });

  it("вертикальное плечо → детур вбок (вправо)", () => {
    const source = rect(0, 0);
    const target = rect(0, 300); // узлы друг под другом
    const d = labelDetour({ source, target, obstacles: [], box: box(120, 40), ...OPTS });
    expect(d).not.toBeNull();
    expect(d!.sSide).toBe("right");
    // lane правее: x = правый край(190) + box.w/2(60) + margin(8) = 258
    expect(hasX(d!.route, 258)).toBe(true);
  });

  it("минимальный из двух направлений: верх дешевле (низ отжат далёким узлом)", () => {
    const source = rect(164, 270);
    const target = rect(588, 270);
    // узел далеко внизу в пролёте (НЕ под коленами 259/683) → lane-вниз уезжает далеко
    const farBelow = rect(400, 520, 100, 100);
    const d = labelDetour({ source, target, obstacles: [farBelow], box: box(150, 40), ...OPTS });
    expect(d).not.toBeNull();
    expect(d!.sSide).toBe("top"); // вверх короче
  });

  it("кэп длины мал → детур отвергается (null → leader у вызывающего)", () => {
    const source = rect(164, 270);
    const target = rect(588, 270);
    const d = labelDetour({ source, target, obstacles: [], box: box(211, 96), margin: 8, maxExtraLen: 10 });
    expect(d).toBeNull();
  });

  it("плашка шире доступной lane → не вмещается → null", () => {
    const source = rect(164, 270);
    const target = rect(588, 270);
    // ширина плашки больше пролёта lane (≈424) → инлайн негде, даже на детуре
    const d = labelDetour({ source, target, obstacles: [], box: box(900, 40), ...OPTS });
    expect(d).toBeNull();
  });

  it("слоты хэндлов разводят встречную пару: idx 0 и idx 2 дают разные плечи (A12.4)", () => {
    const source = rect(164, 270);
    const target = rect(588, 270);
    // младшее ребро пары — слот 0 на обоих концах
    const lo = labelDetour({ source, target, obstacles: [], box: box(150, 40), sIdx: 0, tIdx: 0, ...OPTS });
    // старшее — слот 2
    const hi = labelDetour({ source, target, obstacles: [], box: box(150, 40), sIdx: 2, tIdx: 2, ...OPTS });
    expect(lo).not.toBeNull();
    expect(hi).not.toBeNull();
    // плечо (вертикальный спуск) выходит из разных x: слот 0 = x+0.25*W, слот 2 = x+0.75*W
    expect(lo!.route[0].x).toBeCloseTo(164 + 190 * 0.25, 0);
    expect(hi!.route[0].x).toBeCloseTo(164 + 190 * 0.75, 0);
    expect(lo!.route[0].x).not.toBeCloseTo(hi!.route[0].x, 0);
    // дефолт без слотов = центр (idx=1)
    const mid = labelDetour({ source, target, obstacles: [], box: box(150, 40), ...OPTS });
    expect(mid!.route[0].x).toBeCloseTo(164 + 190 * 0.5, 0);
  });

  it("чистая функция: вход не мутируется", () => {
    const source = rect(164, 270);
    const target = rect(588, 270);
    const obstacles = [rect(400, 600, 100, 100)];
    const snapshot = JSON.stringify({ source, target, obstacles });
    labelDetour({ source, target, obstacles, box: box(150, 40), ...OPTS });
    expect(JSON.stringify({ source, target, obstacles })).toBe(snapshot);
  });
});
