// Чистые хелперы страничных схем (components/pageSchema.ts): маппинг графа
// уровня, предикаты пустого состояния, формулы высот блоков.
import { describe, it, expect } from "vitest";
import {
  toLevelEdges,
  outerGuests,
  hasNoNeighbors,
  visibleEntityGuess,
  schemaSectionHeight,
  componentsSectionHeight,
  projectSchemaHeight,
  responsiveCanvasHeight,
} from "../pageSchema";
import type { GraphResponse } from "../../types";

// Минимальные фикстуры — только поля, которые функции реально читают.
const node = (id: string, name = id) => ({ id, name });
const endpoint = (id: string, ancestors: string[] = [], name = id) => ({
  id,
  name,
  ancestors: ancestors.map((a) => ({ id: a, name: a, is_external: false })),
});
const edge = (id: string, source_id: string, target_id: string) => ({
  id, label: id, technology: null, source_id, target_id, version: 1,
});
const graph = (g: { nodes?: unknown[]; endpoints?: unknown[]; edges?: unknown[] }): GraphResponse =>
  ({
    nodes: g.nodes ?? [],
    endpoints: g.endpoints ?? [],
    edges: g.edges ?? [],
  }) as unknown as GraphResponse;

describe("toLevelEdges", () => {
  it("имена концов — из локалов и реестра; промах — пустая строка", () => {
    const g = graph({
      nodes: [node("a", "Сервис A")],
      endpoints: [endpoint("x", [], "Гость X")],
      edges: [edge("e1", "a", "x"), edge("e2", "a", "missing")],
    });
    const edges = toLevelEdges(g);
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({
      id: "e1",
      label: "e1",
      source_id: "a",
      target_id: "x",
      original_source_id: "a",
      original_target_id: "x",
      original_source_name: "Сервис A",
      original_target_name: "Гость X",
      version: 1,
      created_at: "",
    });
    // конец вне локалов и реестра — имя-фолбэк ""
    expect(edges[1].original_target_name).toBe("");
  });

  it("пустой граф — пустой список", () => {
    expect(toLevelEdges(graph({}))).toEqual([]);
  });
});

describe("outerGuests / hasNoNeighbors", () => {
  it("глубокие концы внутри поддерева фокуса — не внешние гости", () => {
    const g = graph({
      nodes: [node("f")],
      endpoints: [endpoint("inner", ["f"]), endpoint("outer", ["other"])],
    });
    expect(outerGuests(g, "f").map((e) => e.id)).toEqual(["outer"]);
  });

  it("hasNoNeighbors: голый фокус без внешних концов", () => {
    // только фокус + внутренний глубокий конец → связей наружу нет
    expect(hasNoNeighbors(
      graph({ nodes: [node("f")], endpoints: [endpoint("inner", ["f"])] }),
      "f",
    )).toBe(true);
    // лишний локал-представитель → уже не пусто
    expect(hasNoNeighbors(graph({ nodes: [node("f"), node("sib")] }), "f")).toBe(false);
    // внешний гость → не пусто
    expect(hasNoNeighbors(
      graph({ nodes: [node("f")], endpoints: [endpoint("outer")] }),
      "f",
    )).toBe(false);
  });
});

describe("visibleEntityGuess", () => {
  it("локалы + полностью внешние гости (без внутренних и внутрирамочных)", () => {
    const g = graph({
      nodes: [node("f"), node("rep")],
      endpoints: [
        endpoint("deep-in-rep", ["rep"]), // внутри рамки локала — отдельно не виден
        endpoint("inner", ["f"]),         // внутри поддерева фокуса — не в счёт
        endpoint("outer"),                // полностью внешний — виден
      ],
    });
    expect(visibleEntityGuess(g)).toBe(3); // f + rep + outer
  });
});

describe("формулы высот блоков", () => {
  it("schemaSectionHeight: 90px/сущность, коридор 300–560", () => {
    expect(schemaSectionHeight(0)).toBe(300);
    expect(schemaSectionHeight(4)).toBe(360);
    expect(schemaSectionHeight(10)).toBe(560);
  });

  it("componentsSectionHeight: 62px/узел, коридор 280–430", () => {
    expect(componentsSectionHeight(0)).toBe(280);
    expect(componentsSectionHeight(5)).toBe(310);
    expect(componentsSectionHeight(50)).toBe(430);
  });

  it("projectSchemaHeight: 62px/узел, коридор 300–440", () => {
    expect(projectSchemaHeight(0)).toBe(300);
    expect(projectSchemaHeight(5)).toBe(310);
    expect(projectSchemaHeight(50)).toBe(440);
  });

  it("responsiveCanvasHeight: ширина × 0.52, коридор 320–680", () => {
    expect(responsiveCanvasHeight(100)).toBe(320);
    expect(responsiveCanvasHeight(1000)).toBe(520);
    expect(responsiveCanvasHeight(2000)).toBe(680);
  });
});
