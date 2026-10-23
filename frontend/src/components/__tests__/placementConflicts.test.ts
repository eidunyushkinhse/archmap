// Контейнер размещается целиком (docs/specs/deployment.md D30): чьё СВОЁ размещение
// внутри контейнера перезапишет его размещение — потомки любой глубины со своим набором
// площадок, отличным от целевого. Без своего («не указано», унаследованное) и с тем же
// набором — не конфликт; порядок — по имени.
import { describe, expect, it } from "vitest";
import {
  descendantsOf, ownSites, placementConflicts, placeQuestion,
} from "../deployment/placementConflicts";
import type { Node } from "../../types";

type Placed = Pick<Node, "id" | "name" | "parent_id" | "sites">;
const site = (id: string, inheritedFrom: string | null = null) => ({
  id, name: id === "cloud" ? "Облако" : id === "dc" ? "ЦОД резерв" : id, kind: "cloud" as const,
  inherited_from_id: inheritedFrom,
});
function node(id: string, parent: string | null, sites: ReturnType<typeof site>[] = [], name = id): Placed {
  return { id, name, parent_id: parent, sites };
}

// Заказы ⊃ (Order API — своё на Облаке; Склад ⊃ БД заказов — своё на Облаке и ЦОД резерв);
// Каталог — без своего (унаследованное от Заказов); Платежи — вне контейнера.
const NODES: Placed[] = [
  node("orders", null, [site("cloud")], "Заказы"),
  node("api", "orders", [site("cloud")], "Order API"),
  node("store", "orders", [site("cloud", "orders")], "Склад"),
  node("db", "store", [site("cloud"), site("dc")], "БД заказов"),
  node("catalog", "orders", [site("cloud", "orders")], "Каталог"),
  node("pay", null, [site("dc")], "Платежи"),
];

describe("placementConflicts", () => {
  it("descendantsOf: потомки любой глубины без самого узла; цикл в данных не вешает", () => {
    expect(descendantsOf(NODES, "orders").map((n) => n.id).sort()).toEqual(["api", "catalog", "db", "store"]);
    expect(descendantsOf(NODES, "pay")).toEqual([]);
    const cyclic = [node("a", "b"), node("b", "a")];
    expect(descendantsOf(cyclic, "a").map((n) => n.id)).toEqual(["b"]);
  });

  it("ownSites: только своё размещение, унаследованное — нет", () => {
    expect(ownSites(NODES[3])).toEqual(["cloud", "dc"]);
    expect(ownSites(NODES[2])).toEqual([]);
  });

  it("конфликт — своё размещение внутри, отличное от целевого; порядок по имени", () => {
    const got = placementConflicts(NODES, "orders", ["dc"]);
    expect(got.map((c) => [c.node.name, c.siteNames])).toEqual([
      ["БД заказов", ["Облако", "ЦОД резерв"]],
      ["Order API", ["Облако"]],
    ]);
  });

  it("равный набор (по множеству) — не конфликт; без своего («не указано», унаследованное) — тоже", () => {
    expect(placementConflicts(NODES, "orders", ["dc", "cloud"]).map((c) => c.node.id)).toEqual(["api"]);
    expect(placementConflicts(NODES, "store", ["cloud", "dc"])).toEqual([]);
    expect(placementConflicts([node("c", null), node("l", "c")], "c", ["x"])).toEqual([]);
  });

  it("вопрос подтверждения: имя объекта и площадки в кавычках", () => {
    expect(placeQuestion("Заказы", ["Облако"])).toBe("Разместить «Заказы» на «Облако»?");
    expect(placeQuestion("Заказы", ["Облако", "ЦОД"])).toBe("Разместить «Заказы» на «Облако», «ЦОД»?");
  });
});
