// Релевантные дети раскрытого контейнера на read-only странице (X16 v2):
// «отображаемое = связанное рёбрами» — обобщение гостевой проекции на локалов.
import { describe, it, expect } from "vitest";
import { relevantChildren, relevantChildCounts } from "../graph/relevantChildren";
import type { GhostNode } from "../../types";

// Конец из реестра с цепочкой предков.
const g = (id: string, ancestors: string[] = []): GhostNode => ({
  id,
  name: id,
  role: null,
  technology: null,
  is_external: false,
  shape: "service",
  status: "existing",
  node_depth: ancestors.length,
  has_children: false,
  child_count: 0,
  is_ghost: true,
  ancestors: ancestors.map((a) => ({ id: a, name: a, is_external: false })),
});

const kid = (id: string) => ({ id });

// Сцена: контейнер m раскрывается; дети k1..k6:
//  k1 — глубокая граничная связь (d1 внутри k1 → X снаружи);
//  k2 — связь только в раскрываемый родитель m;
//  k3 — изолирован (рёбер нет);
//  k4 — связь с другим ребёнком (k4 → k1);
//  k5 — только ВНУТРЕННЯЯ связь (d5a → d5b, оба внутри k5);
//  k6 — связь только в раскрытый контейнер-сиблинг s.
const endpoints = [
  g("d1", ["m", "k1"]),
  g("x"),
  g("k2", ["m"]),
  g("k4", ["m"]),
  g("d5a", ["m", "k5"]),
  g("d5b", ["m", "k5"]),
  g("k6", ["m"]),
];
const edges = [
  { source_id: "d1", target_id: "x" },   // граница k1
  { source_id: "k2", target_id: "m" },   // в родителя (раскрыт)
  { source_id: "k4", target_id: "d1" },  // ребёнок→ребёнок (k4 → глубокий внутри k1)
  { source_id: "d5a", target_id: "d5b" },// внутреннее k5
  { source_id: "k6", target_id: "s" },   // в раскрытый сиблинг
];
const expandedWithM = new Set(["m", "s"]);

describe("relevantChildren", () => {
  it("оставляет только детей с граничным ребром (глубокие концы — по реестру)", () => {
    const kids = ["k1", "k2", "k3", "k4", "k5", "k6"].map(kid);
    const fit = relevantChildren(kids, edges, endpoints, expandedWithM);
    // k1 (глубокая граница d1→x) и k4 (ребро в глубокое k1); порядок сохранён
    expect(fit.map((k) => k.id)).toEqual(["k1", "k4"]);
  });

  it("ребро «в рамку» раскрытого родителя границу не образует", () => {
    // k2 связан только с m; m раскрыт → ребро дропается проекцией → k2 нерелевантен
    const fit = relevantChildren([kid("k2")], edges, endpoints, expandedWithM);
    expect(fit).toEqual([]);
  });

  it("при нераскрытом родителе то же ребро — граница (честная семантика модуля)", () => {
    const fit = relevantChildren([kid("k2")], edges, endpoints, new Set());
    expect(fit.map((k) => k.id)).toEqual(["k2"]);
  });

  it("изолированный ребёнок и ребёнок только с внутренней связью — нерелевантны", () => {
    const fit = relevantChildren([kid("k3"), kid("k5")], edges, endpoints, expandedWithM);
    expect(fit).toEqual([]);
  });

  it("ребро только в раскрытый контейнер-сиблинг — нерелевантен", () => {
    const fit = relevantChildren([kid("k6")], edges, endpoints, expandedWithM);
    expect(fit).toEqual([]);
  });
});

describe("relevantChildCounts", () => {
  it("счётчик по контейнеру сходится с фильтром детей", () => {
    const counts = relevantChildCounts(edges, endpoints, expandedWithM);
    expect(counts.get("m")).toBe(2); // k1, k4
    const kids = ["k1", "k2", "k3", "k4", "k5", "k6"].map(kid);
    expect(counts.get("m")).toBe(relevantChildren(kids, edges, endpoints, expandedWithM).length);
  });

  it("внутренние дети релевантны своему контейнеру (рекурсивная консистентность)", () => {
    // d5a/d5b нерелевантны для m, но релевантны для k5: при раскрытии k5 их
    // связь станет видимой границей каждого
    const counts = relevantChildCounts(edges, endpoints, expandedWithM);
    expect(counts.get("k5")).toBe(2);
  });

  it("пустые рёбра — счётчиков нет (все дети нерелевантны)", () => {
    expect(relevantChildCounts([], endpoints, expandedWithM).size).toBe(0);
  });
});
