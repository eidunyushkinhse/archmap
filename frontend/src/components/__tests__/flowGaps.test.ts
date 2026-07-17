import { describe, it, expect } from "vitest";
import { flowSpacing } from "../graph/layout/flowGaps";
import { NUDGE_CLEAR, NUDGE_GAP } from "../graph/layout/channelNudge";

// Спейсинги потоковой раскладки (коридоры горизонтальных плеч):
// nodeGap = 2·клиренс нуджинга + максимум высот wrapped-плашек + резерв
// интервалов канала под пачку до 4 плеч (по числу рёбер), кламп [60, 132];
// edgeNode = клиренс + полвысоты плашки; edgeEdge = шаг пачки канала.

const edge = (label: string | null): { label: string | null; technology: string | null } => ({
  label,
  technology: null,
});

describe("flowSpacing", () => {
  it("без рёбер — минимум 60 (прежний nodesep), edgeEdge всегда равен шагу канала", () => {
    const sp = flowSpacing([]);
    expect(sp.nodeGap).toBe(60);
    expect(sp.edgeEdgeGap).toBe(NUDGE_GAP);
  });

  it("одно ребро с короткой подписью — спрос ниже минимума, остаётся 60", () => {
    // одна строка (h=22): 16 + 22 + 0 интервалов = 38 → кламп снизу
    expect(flowSpacing([edge("REST")]).nodeGap).toBe(60);
  });

  it("пачка из 4+ рёбер с двухстрочной подписью — клиренсы + плашка + 3 интервала", () => {
    const edges = Array.from({ length: 5 }, () => edge("события изменения товаров"));
    // wrapLabel по ~20 симв. → 2 строки (h=38): 2·8 + 38 + 3·14 = 96
    expect(flowSpacing(edges).nodeGap).toBe(2 * NUDGE_CLEAR + 38 + 3 * NUDGE_GAP);
  });

  it("резерв интервалов растёт с числом рёбер до капа в 4 плеча", () => {
    const two = flowSpacing([edge("события изменения товаров"), edge("события изменения товаров")]);
    const five = flowSpacing(Array.from({ length: 5 }, () => edge("события изменения товаров")));
    const nine = flowSpacing(Array.from({ length: 9 }, () => edge("события изменения товаров")));
    expect(two.nodeGap).toBe(2 * NUDGE_CLEAR + 38 + NUDGE_GAP); // 1 интервал
    expect(five.nodeGap).toBeGreaterThan(two.nodeGap);
    expect(nine.nodeGap).toBe(five.nodeGap); // кап: больше 4 плеч не резервируем
  });

  it("гигантская многострочная плашка упирается в анти-ватман кламп 132", () => {
    const tall = edge("первая строка описания\nвторая строка\nтретья строка\nчетвёртая строка\nпятая строка");
    expect(flowSpacing([tall, tall, tall, tall]).nodeGap).toBe(132);
  });

  it("edgeNode = клиренс + полвысоты плашки (двухстрочная: 8 + 19 = 27), кап 48", () => {
    expect(flowSpacing([edge("события изменения товаров")]).edgeNodeGap).toBe(NUDGE_CLEAR + 19);
    const tall = edge("первая строка описания\nвторая строка\nтретья строка\nчетвёртая строка\nпятая строка");
    expect(flowSpacing([tall]).edgeNodeGap).toBe(48);
  });
});
