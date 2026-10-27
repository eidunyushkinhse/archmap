// Размещение хранится у объектов, контейнер — это его объекты (docs/specs/deployment.md
// D30): объекты узла (leavesOf), есть ли у узла размещение (hasPlacement) и чьё
// размещение внутри контейнера перезапишет размещение его целиком — объекты любой
// глубины с набором площадок, отличным от целевого (placementConflicts). Без размещения
// и с тем же набором — не конфликт; порядок — по имени.
import { describe, expect, it } from "vitest";
import {
  descendantsOf, hasPlacement, leavesOf, placementConflicts, placeQuestion, unplaceQuestion,
} from "../deployment/placementConflicts";
import type { Node } from "../../types";

type Placed = Pick<Node, "id" | "name" | "parent_id" | "sites">;
const site = (id: string, partial = false) => ({
  id, name: id === "cloud" ? "Облако" : id === "dc" ? "ЦОД резерв" : id, kind: "cloud" as const, partial,
});
function node(id: string, parent: string | null, sites: ReturnType<typeof site>[] = [], name = id): Placed {
  return { id, name, parent_id: parent, sites };
}

// Заказы ⊃ (Order API — Облако; Склад ⊃ БД заказов — Облако и ЦОД резерв; Каталог — без
// размещения); Платежи — вне контейнера. У контейнеров sites — площадки их объектов.
const NODES: Placed[] = [
  node("orders", null, [site("cloud", true), site("dc", true)], "Заказы"),
  node("api", "orders", [site("cloud")], "Order API"),
  node("store", "orders", [site("cloud"), site("dc")], "Склад"),
  node("db", "store", [site("cloud"), site("dc")], "БД заказов"),
  node("catalog", "orders", [], "Каталог"),
  node("pay", null, [site("dc")], "Платежи"),
];

describe("placementConflicts", () => {
  it("descendantsOf: потомки любой глубины без самого узла; цикл в данных не вешает", () => {
    expect(descendantsOf(NODES, "orders").map((n) => n.id).sort()).toEqual(["api", "catalog", "db", "store"]);
    expect(descendantsOf(NODES, "pay")).toEqual([]);
    const cyclic = [node("a", "b"), node("b", "a")];
    expect(descendantsOf(cyclic, "a").map((n) => n.id)).toEqual(["b"]);
  });

  it("leavesOf: объект — он сам, контейнер — объекты его поддерева", () => {
    expect(leavesOf(NODES, NODES[5]).map((n) => n.id)).toEqual(["pay"]);
    expect(leavesOf(NODES, NODES[0]).map((n) => n.id).sort()).toEqual(["api", "catalog", "db"]);
    expect(leavesOf(NODES, NODES[2]).map((n) => n.id)).toEqual(["db"]);
  });

  it("hasPlacement: у объекта — его площадки, у контейнера — хоть у кого-то внутри", () => {
    expect(hasPlacement(NODES, NODES[5])).toBe(true);
    expect(hasPlacement(NODES, NODES[4])).toBe(false);
    expect(hasPlacement(NODES, NODES[0])).toBe(true);
    expect(hasPlacement([node("c", null), node("l", "c")], node("c", null))).toBe(false);
  });

  it("конфликт — размещение объекта внутри, отличное от целевого; порядок по имени", () => {
    const got = placementConflicts(NODES, "orders", ["dc"]);
    expect(got.map((c) => [c.node.name, c.siteNames])).toEqual([
      ["БД заказов", ["Облако", "ЦОД резерв"]],
      ["Order API", ["Облако"]],
    ]);
  });

  it("равный набор (по множеству) — не конфликт; без размещения — тоже; контейнеры внутри не считаются", () => {
    expect(placementConflicts(NODES, "orders", ["dc", "cloud"]).map((c) => c.node.id)).toEqual(["api"]);
    expect(placementConflicts(NODES, "store", ["cloud", "dc"])).toEqual([]);
    expect(placementConflicts([node("c", null), node("l", "c")], "c", ["x"])).toEqual([]);
  });

  it("пустой целевой набор (снятие) — все размещённые объекты внутри", () => {
    expect(placementConflicts(NODES, "orders", []).map((c) => c.node.id)).toEqual(["db", "api"]);
  });

  it("вопросы подтверждения: имя объекта и площадки в кавычках", () => {
    expect(placeQuestion("Заказы", ["Облако"])).toBe("Разместить «Заказы» на «Облако»?");
    expect(placeQuestion("Заказы", ["Облако", "ЦОД"])).toBe("Разместить «Заказы» на «Облако», «ЦОД»?");
    expect(unplaceQuestion("Заказы")).toBe("Снять размещение «Заказы»?");
  });
});
