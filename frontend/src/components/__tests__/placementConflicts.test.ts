// Размещение хранится у единиц — контейнеров (docs/specs/deployment.md D30, D33): единицы
// узла (unitsOf: контейнер — сам, система — её единицы, компонент — никто), есть ли у
// узла размещение (hasPlacement) и чьё размещение внутри системы перезапишет размещение
// её целиком — единицы любой глубины с набором площадок, отличным от целевого
// (placementConflicts). Без размещения и с тем же набором — не конфликт; порядок — по
// имени. Элемент узла — из ответа сервера.
import { describe, expect, it } from "vitest";
import {
  hasPlacement, PLACE_LEAD, placementConflicts, placeQuestion, unitsOf, UNPLACE_LEAD, unplaceQuestion,
} from "../deployment/placementConflicts";
import type { Node } from "../../types";

type Placed = Pick<Node, "id" | "name" | "parent_id" | "sites" | "element_effective">;
const site = (id: string, partial = false) => ({
  id, name: id === "cloud" ? "Облако" : id === "dc" ? "ЦОД резерв" : id, kind: "cloud" as const, partial,
});
function node(
  id: string, parent: string | null, sites: ReturnType<typeof site>[] = [], name = id,
  element: Placed["element_effective"] = "container",
): Placed {
  return { id, name, parent_id: parent, sites, element_effective: element };
}

// Заказы ⊃ (Order API — Облако; Склад ⊃ БД заказов — Облако и ЦОД резерв; Каталог — без
// размещения); Платежи — вне системы. У систем sites — площадки их единиц.
const NODES: Placed[] = [
  node("orders", null, [site("cloud", true), site("dc", true)], "Заказы", "system"),
  node("api", "orders", [site("cloud")], "Order API"),
  node("store", "orders", [site("cloud"), site("dc")], "Склад", "system"),
  node("db", "store", [site("cloud"), site("dc")], "БД заказов"),
  node("catalog", "orders", [], "Каталог"),
  node("pay", null, [site("dc")], "Платежи"),
];

// Система shop: контейнер core с компонентами (у компонента — «спящие» площадки прежних
// данных: сервер отдаёт их пустыми, но и непустые не в счёт), лист mail рядом.
const C4: Placed[] = [
  node("shop", null, [site("cloud", true)], "Магазин", "system"),
  node("core", "shop", [site("cloud")], "Ядро"),
  node("handlers", "core", [site("dc")], "Обработчики", "component"),
  node("mail", "shop", [], "Почта"),
  node("buyer", "shop", [], "Покупатель", null),
];

describe("placementConflicts", () => {
  it("unitsOf: единица — она сама, система — её единицы сквозь вложенные системы", () => {
    expect(unitsOf(NODES, NODES[5]).map((n) => n.id)).toEqual(["pay"]);
    expect(unitsOf(NODES, NODES[0]).map((n) => n.id)).toEqual(["api", "db", "catalog"]);
    expect(unitsOf(NODES, NODES[2]).map((n) => n.id)).toEqual(["db"]);
  });

  it("unitsOf: контейнер с компонентами — сам, компоненты и «Пользователи» — не единицы", () => {
    expect(unitsOf(C4, C4[0]).map((n) => n.id)).toEqual(["core", "mail"]);
    expect(unitsOf(C4, C4[1]).map((n) => n.id)).toEqual(["core"]);
    expect(unitsOf(C4, C4[2])).toEqual([]);
    expect(unitsOf(C4, C4[4])).toEqual([]);
  });

  it("unitsOf: цикл в данных не вешает", () => {
    const cyclic = [node("a", "b", [], "a", "system"), node("b", "a", [], "b", "system"), node("c", "a")];
    expect(unitsOf(cyclic, cyclic[0]).map((n) => n.id)).toEqual(["c"]);
  });

  it("hasPlacement: у единицы — её площадки, у системы — хоть у одной единицы внутри", () => {
    expect(hasPlacement(NODES, NODES[5])).toBe(true);
    expect(hasPlacement(NODES, NODES[4])).toBe(false);
    expect(hasPlacement(NODES, NODES[0])).toBe(true);
    expect(hasPlacement([node("c", null, [], "c", "system"), node("l", "c")], node("c", null, [], "c", "system"))).toBe(false);
    // площадки компонента — не размещение
    expect(hasPlacement(C4, C4[2])).toBe(false);
  });

  it("конфликт — размещение объекта внутри, отличное от целевого; порядок по имени", () => {
    const got = placementConflicts(NODES, "orders", ["dc"]);
    expect(got.map((c) => [c.node.name, c.siteNames])).toEqual([
      ["БД заказов", ["Облако", "ЦОД резерв"]],
      ["Order API", ["Облако"]],
    ]);
  });

  it("равный набор (по множеству) — не конфликт; без размещения — тоже; системы внутри не считаются", () => {
    expect(placementConflicts(NODES, "orders", ["dc", "cloud"]).map((c) => c.node.id)).toEqual(["api"]);
    expect(placementConflicts(NODES, "store", ["cloud", "dc"])).toEqual([]);
    expect(placementConflicts([node("c", null, [], "c", "system"), node("l", "c")], "c", ["x"])).toEqual([]);
  });

  it("конфликты — по единицам: контейнер целиком, его компоненты не в счёт; у единицы конфликтов нет", () => {
    expect(placementConflicts(C4, "shop", ["dc"]).map((c) => [c.node.name, c.siteNames])).toEqual([
      ["Ядро", ["Облако"]],
    ]);
    expect(placementConflicts(C4, "core", ["dc"])).toEqual([]);
  });

  it("пустой целевой набор (снятие) — все размещённые объекты внутри", () => {
    expect(placementConflicts(NODES, "orders", []).map((c) => c.node.id)).toEqual(["db", "api"]);
  });

  it("вопросы подтверждения: имя объекта и площадки в кавычках", () => {
    expect(placeQuestion("Заказы", ["Облако"])).toBe("Разместить «Заказы» на «Облако»?");
    expect(placeQuestion("Заказы", ["Облако", "ЦОД"])).toBe("Разместить «Заказы» на «Облако», «ЦОД»?");
    expect(unplaceQuestion("Заказы")).toBe("Снять размещение «Заказы»?");
  });

  it("пояснения подтверждения говорят о контейнерах системы (её единицах размещения)", () => {
    expect(PLACE_LEAD).toBe("Все контейнеры системы будут размещены там же, включая те, что сейчас стоят на других площадках:");
    expect(UNPLACE_LEAD).toBe("Размещение всех контейнеров системы будет снято:");
  });
});
