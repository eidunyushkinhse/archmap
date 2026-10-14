// Путь от корня до узла (pages/ancestorPath): порядок, неизвестный узел и цикл в данных.
import { describe, expect, it } from "vitest";
import { ancestorRef, chainTo } from "../ancestorPath";
import type { Node } from "../../types";

const node = (id: string, parent_id: string | null): Node =>
  ({ id, name: `узел ${id}`, parent_id, is_external: false }) as Node;

describe("chainTo", () => {
  const all = [node("api", "orders"), node("shop", null), node("orders", "shop")];

  it("от корня к узлу включительно, порядок входа неважен", () => {
    expect(chainTo(all, "api").map((n) => n.id)).toEqual(["shop", "orders", "api"]);
  });

  it("null и неизвестный узел — пустой путь", () => {
    expect(chainTo(all, null)).toEqual([]);
    expect(chainTo(all, "нет такого")).toEqual([]);
  });

  it("цикл в данных обрывается, а не вешает вкладку", () => {
    const cyclic = [node("a", "b"), node("b", "a")];
    expect(chainTo(cyclic, "a").map((n) => n.id)).toEqual(["b", "a"]);
  });

  it("звено крошек — id, имя и признак внешнего", () => {
    expect(ancestorRef(node("shop", null))).toEqual({ id: "shop", name: "узел shop", is_external: false });
  });
});
