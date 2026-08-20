import { describe, it, expect } from "vitest";
import { pickLevelForm } from "../graph/layout/levelForm";

// Правило формы уровня (N30): звезда → force, поток → layered.
// Данные-обоснование — docs/review-layout-rule-response.md.

const e = (a: string, b: string) => ({ source_id: a, target_id: b });
const star = (hub: string, leaves: string[]) => leaves.map((l) => e(hub, l));

describe("pickLevelForm (форма уровня по топологии, N30)", () => {
  it("звезда хаб+5 листьев → force (доля хаба 1.0)", () => {
    expect(pickLevelForm(star("hub", ["a", "b", "c", "d", "f"]))).toBe("force");
  });

  it("цепочка-поток из 6 узлов → layered (guard: у хаба < 3 соседей)", () => {
    expect(pickLevelForm([e("a", "b"), e("b", "c"), e("c", "d"), e("d", "f"), e("f", "g")])).toBe("layered");
  });

  it("цикл C5 → layered (диаметр 2, но guard соседей хаба спасает)", () => {
    expect(pickLevelForm([e("a", "b"), e("b", "c"), e("c", "d"), e("d", "f"), e("f", "a")])).toBe("layered");
  });

  it("двухабовая звезда с общими листьями (федеративный корень) → force по диаметру ≤ 2", () => {
    // hub1 и hub2 делят 4 листа + связаны между собой: доля хаба 5/9 < 0.75,
    // но всё в двух шагах — диаметр 2
    const edges = [
      ...star("h1", ["a", "b", "c", "d"]),
      ...star("h2", ["a", "b", "c", "d"]),
      e("h1", "h2"),
    ];
    expect(pickLevelForm(edges)).toBe("force");
  });

  it("поток с ветвлениями (диаметр 4, хаб 0.5) → layered", () => {
    // a→b→c→d→f + боковые ветки у c: доля хаба c = 4/8, диаметр 4
    const edges = [
      e("a", "b"), e("b", "c"), e("c", "d"), e("d", "f"),
      e("c", "x"), e("c", "y"), e("x", "z"), e("g", "a"),
    ];
    expect(pickLevelForm(edges)).toBe("layered");
  });

  it("встречные пары мастер-рёбер — одна спица: двунаправленная звезда → force", () => {
    // 5 листьев × 2 направления = 10 направленных мастеров, но спиц 5
    const edges = [
      ...star("hub", ["a", "b", "c", "d", "f"]),
      ...["a", "b", "c", "d", "f"].map((l) => e(l, "hub")),
    ];
    expect(pickLevelForm(edges)).toBe("force");
  });

  it("меньше 5 спиц → layered (форма неразличима)", () => {
    expect(pickLevelForm(star("hub", ["a", "b", "c", "d"]))).toBe("layered");
  });

  it("петли игнорируются", () => {
    expect(pickLevelForm([e("a", "a"), ...star("hub", ["a", "b", "c", "d"])])).toBe("layered");
  });

  it("несвязные компоненты: две звезды → force (диаметр компоненты ≤ 2)", () => {
    const edges = [...star("h1", ["a", "b", "c"]), ...star("h2", ["x", "y", "z"])];
    expect(pickLevelForm(edges)).toBe("force");
  });
});
