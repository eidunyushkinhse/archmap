// Куда переносить можно — зеркало серверных запретов (app/reparent.py) в дереве: отказ
// виден ДО броска. Р6 эпика элементов: база и брокер не входят в состав контейнера.
import { renderHook } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import type { Node } from "../../types";
import { useTreeReparent } from "../nodeTree.useReparent";

function node(id: string, over: Partial<Node> = {}): Node {
  return {
    id, name: id, parent_id: null, shape: "service", has_children: false, child_count: 0,
    // Тип выбран всегда (решение владельца 2026-11-01): лист-сервис хранит «контейнер».
    element: "container", element_effective: "container", ...over,
  } as Node;
}

const shop = node("shop", { has_children: true, element: "system", element_effective: "system" });
const orders = node("orders", { parent_id: "shop", has_children: true });
const api = node("api", { parent_id: "orders", element: null, element_effective: "component" });
const leaf = node("billing", { parent_id: "shop" });
const empty = node("payments", { parent_id: "shop", element: "system", element_effective: "system" });
const db = node("orders-db", { shape: "database", element: null });
const events = node("events", { shape: "broker", element: null });
const worker = node("worker");

function canDrop(n: Node, target: Node | null): boolean {
  const all = new Map([shop, orders, api, leaf, empty, db, events, worker].map((x) => [x.id, x]));
  const pathTo = (t: Node): Node[] => {
    const out: Node[] = [];
    let cur: Node | undefined = t;
    while (cur) { out.unshift(cur); cur = cur.parent_id ? all.get(cur.parent_id) : undefined; }
    return out;
  };
  const { result } = renderHook(() => useTreeReparent(all, pathTo, undefined));
  return result.current.canDropInto(n, target ? target.id : null);
}

describe("canDropInto: база и брокер не входят в контейнер", () => {
  it("в контейнер, в компонент и в лист-контейнер — нельзя", () => {
    for (const store of [db, events]) {
      expect(canDrop(store, orders)).toBe(false);
      expect(canDrop(store, api)).toBe(false);
      expect(canDrop(store, leaf)).toBe(false);
    }
  });
  it("в систему и в пустую систему — можно; сервис — куда угодно", () => {
    expect(canDrop(db, shop)).toBe(true);
    expect(canDrop(events, empty)).toBe(true);
    expect(canDrop(worker, orders)).toBe(true);
    expect(canDrop(worker, api)).toBe(true);
    expect(canDrop(worker, leaf)).toBe(true);
  });
});
