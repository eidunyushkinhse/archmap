import { describe, it, expect } from "vitest";
import {
  measureQuality, compareQuality, MUST_BE_ZERO, type RouteDump,
} from "../graph/layout/routeQualityMetrics";

// Метрики качества маршрутов (Ф0 эпика «глубокая оптимизация роутера»). Проверяем
// на синтетических ломаных с ИЗВЕСТНЫМИ ответами — метрика, которой верят гейты
// классов Б и В, сама обязана быть проверена.

type Pt = { x: number; y: number };

const dump = (
  routes: Array<[string, Pt[]]>,
  rects: RouteDump["rects"] = [],
  labels: RouteDump["labels"] = [],
): RouteDump => ({ routes, rects, labels });

describe("measureQuality — кресты (E23)", () => {
  it("два перпендикулярных маршрута дают один крест", () => {
    const m = measureQuality(dump([
      ["h", [{ x: 0, y: 100 }, { x: 200, y: 100 }]],
      ["v", [{ x: 100, y: 0 }, { x: 100, y: 200 }]],
    ]));
    expect(m.crosses).toBe(1);
  });

  it("три совпадающих плеча в одной точке — всё ещё один крест (дедуп по точке)", () => {
    const m = measureQuality(dump([
      ["h1", [{ x: 0, y: 100 }, { x: 200, y: 100 }]],
      ["h2", [{ x: 0, y: 100 }, { x: 200, y: 100 }]],
      ["h3", [{ x: 0, y: 100 }, { x: 200, y: 100 }]],
      ["v", [{ x: 100, y: 0 }, { x: 100, y: 200 }]],
    ]));
    expect(m.crosses).toBe(1);
  });

  it("T-стык крестом не считается (точка на конце чужого сегмента)", () => {
    const m = measureQuality(dump([
      ["h", [{ x: 0, y: 100 }, { x: 100, y: 100 }]],
      ["v", [{ x: 100, y: 0 }, { x: 100, y: 200 }]],
    ]));
    expect(m.crosses).toBe(0);
  });

  it("сегменты одного маршрута крестом не считаются", () => {
    const m = measureQuality(dump([
      ["u", [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 100, y: 200 }, { x: 100, y: -100 }]],
    ]));
    expect(m.crosses).toBe(0);
  });
});

describe("measureQuality — езда и легальные стволы (E25)", () => {
  it("веер из общего порта: наложение в общем префиксе легально", () => {
    const m = measureQuality(dump([
      ["a", [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }]],
      ["b", [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: -50 }]],
    ]));
    expect(m.overlapPx).toBe(100);
    expect(m.illegalOverlapPx).toBe(0);
  });

  it("веер во общий док: наложение в общем суффиксе легально", () => {
    const m = measureQuality(dump([
      ["a", [{ x: 0, y: 50 }, { x: 0, y: 0 }, { x: 100, y: 0 }]],
      ["b", [{ x: 0, y: -50 }, { x: 0, y: 0 }, { x: 100, y: 0 }]],
    ]));
    expect(m.overlapPx).toBe(100);
    expect(m.illegalOverlapPx).toBe(0);
  });

  it("повторное схождение без общего конца — езда нелегальна целиком", () => {
    const m = measureQuality(dump([
      ["a", [{ x: 0, y: 0 }, { x: 300, y: 0 }]],
      ["b", [
        { x: 0, y: -50 }, { x: 100, y: -50 }, { x: 100, y: 0 },
        { x: 200, y: 0 }, { x: 200, y: 50 },
      ]],
    ]));
    expect(m.overlapPx).toBe(100);
    expect(m.illegalOverlapPx).toBe(100);
  });

  it("расхождение и повторное схождение при общем порте: легален только префикс", () => {
    // общий старт (0,0); обе идут вправо до x=100 (легальный префикс 100),
    // «b» ныряет вниз и возвращается на линию y=0 к x=200..300 — этот кусок вне
    // префикса и платит как чужая линия
    const m = measureQuality(dump([
      ["a", [{ x: 0, y: 0 }, { x: 300, y: 0 }]],
      ["b", [
        { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 },
        { x: 200, y: 40 }, { x: 200, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 60 },
      ]],
    ]));
    expect(m.overlapPx).toBe(200);       // 0..100 (префикс) + 200..300 (повторное схождение)
    expect(m.illegalOverlapPx).toBe(100);
  });

  it("касание концами наложением не считается", () => {
    const m = measureQuality(dump([
      ["a", [{ x: 0, y: 0 }, { x: 100, y: 0 }]],
      ["b", [{ x: 100, y: 0 }, { x: 200, y: 0 }]],
    ]));
    expect(m.overlapPx).toBe(0);
  });
});

describe("measureQuality — тела и плашки", () => {
  const body = { id: "n1", x: 100, y: 100, w: 100, h: 100 };

  it("сегмент сквозь тело — нарушение E19", () => {
    const m = measureQuality(dump([["a", [{ x: 0, y: 150 }, { x: 300, y: 150 }]]], [body]));
    expect(m.throughBodies).toBe(1);
  });

  it("ход вдоль грани тела нарушением не считается", () => {
    const m = measureQuality(dump([["a", [{ x: 0, y: 100 }, { x: 300, y: 100 }]]], [body]));
    expect(m.throughBodies).toBe(0);
  });

  it("чужая плашка считается, своя — нет", () => {
    const label: RouteDump["labels"] = [["a", { x: 100, y: 140, w: 60, h: 20 }]];
    const m = measureQuality(dump([
      ["a", [{ x: 0, y: 150 }, { x: 300, y: 150 }]],
      ["b", [{ x: 0, y: 145 }, { x: 300, y: 145 }]],
    ], [], label));
    expect(m.throughLabels).toBe(1); // «b» режет плашку «a»; сама «a» — не нарушение
  });
});

describe("measureQuality — порты (E12)", () => {
  it("выход в точке чужого входа — конфликт", () => {
    const m = measureQuality(dump([
      ["a", [{ x: 0, y: 0 }, { x: 100, y: 0 }]],   // вход в (100,0)
      ["b", [{ x: 100, y: 0 }, { x: 200, y: 0 }]], // выход из (100,0)
    ]));
    expect(m.portConflicts).toBe(1);
  });

  it("веер одной роли (out-out) конфликтом не считается", () => {
    const m = measureQuality(dump([
      ["a", [{ x: 0, y: 0 }, { x: 100, y: 0 }]],
      ["b", [{ x: 0, y: 0 }, { x: 0, y: 100 }]],
    ]));
    expect(m.portConflicts).toBe(0);
  });
});

describe("measureQuality — развороты и шпильки (E15)", () => {
  it("узкий разворот ловится шпилькой", () => {
    const m = measureQuality(dump([
      ["a", [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 20 }, { x: 0, y: 20 }]],
    ]));
    expect(m.reversals).toBe(1);
    expect(m.hairpins).toBe(1);
  });

  it("широкая «П» — разворот, но не шпилька", () => {
    const m = measureQuality(dump([
      ["a", [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }]],
    ]));
    expect(m.reversals).toBe(1);
    expect(m.hairpins).toBe(0);
  });
});

describe("measureQuality — длина и изломы", () => {
  it("считает манхэттен и изломы, коллинеарные точки не плодят изломов", () => {
    const m = measureQuality(dump([
      ["a", [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 30 }]],
    ]));
    expect(m.totalLen).toBe(130);
    expect(m.bends).toBe(1);
  });
});

describe("compareQuality", () => {
  const clean = measureQuality(dump([["a", [{ x: 0, y: 150 }, { x: 300, y: 150 }]]]));
  const cut = measureQuality(dump(
    [["a", [{ x: 0, y: 150 }, { x: 300, y: 150 }]]],
    [{ id: "n1", x: 100, y: 100, w: 100, h: 100 }],
  ));

  it("даёт знаковые дельты и поднимает флаг НОВОГО нарушения «обязано 0»", () => {
    const cmp = compareQuality(clean, cut);
    const bodies = cmp.rows.find((r) => r.metric === "throughBodies");
    expect(bodies?.delta).toBe(1);
    expect(bodies?.violated).toBe(true);
    expect(cmp.violations).toHaveLength(1);
    // метрика без изменений — дельта 0 и никаких флагов
    const len = cmp.rows.find((r) => r.metric === "totalLen");
    expect(len?.delta).toBe(0);
    expect(len?.worse).toBe(false);
    // починили — тем более не нарушение
    expect(compareQuality(cut, clean).violations).toHaveLength(0);
  });

  it("ИЗВЕСТНОЕ нарушение базлайна не флажится, а рост — флажится", () => {
    // Мотив (находка Ф0): на живой сцене Zabbix-корня уже есть 1 вход маршрута в
    // чужое тело. С правилом «after > 0» гейт сравнения был бы вечно красным и
    // перестал бы различать регрессию — считаем нарушением только НОВОЕ.
    const same = compareQuality(cut, cut);
    expect(same.rows.find((r) => r.metric === "throughBodies")?.after).toBe(1);
    expect(same.rows.find((r) => r.metric === "throughBodies")?.violated).toBe(false);
    expect(same.violations).toHaveLength(0);

    const worse = measureQuality(dump(
      [
        ["a", [{ x: 0, y: 150 }, { x: 300, y: 150 }]],
        ["b", [{ x: 0, y: 160 }, { x: 300, y: 160 }]],
      ],
      [{ id: "n1", x: 100, y: 100, w: 100, h: 100 }],
    ));
    const grown = compareQuality(cut, worse);
    expect(grown.rows.find((r) => r.metric === "throughBodies")?.delta).toBe(1);
    expect(grown.violations).toHaveLength(1);
    expect(grown.violations[0]).toContain("было 1, стало 2");
  });

  it("шпильки — обычная метрика «меньше лучше», не инвариант", () => {
    expect(MUST_BE_ZERO).toEqual(["throughBodies"]);
    const straight = measureQuality(dump([["a", [{ x: 0, y: 0 }, { x: 100, y: 0 }]]]));
    const hairpin = measureQuality(dump([
      ["a", [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 20 }, { x: 0, y: 20 }]],
    ]));
    const cmp = compareQuality(straight, hairpin);
    const row = cmp.rows.find((r) => r.metric === "hairpins");
    expect(row?.after).toBe(1);
    expect(row?.worse).toBe(true);       // в отчёте видно, что стало хуже
    expect(row?.mustBeZero).toBe(false); // но гейтом «обязано 0» не является
    expect(row?.violated).toBe(false);
    expect(cmp.violations).toHaveLength(0);
  });
});
