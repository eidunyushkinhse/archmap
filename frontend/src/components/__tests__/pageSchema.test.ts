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
  withOwnEdits,
} from "../pageSchema";
import type { GraphResponse, Node } from "../../types";

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

  it("канал брокера едет с ребром: инспектор правит его прямо на уровне", () => {
    // Без переноса поле «Канал» показывало бы пустоту у заполненной связи, а первый
    // же коммит соседнего поля затёр бы канал null'ом.
    const g = graph({
      nodes: [node("a", "orders"), node("k", "Kafka")],
      edges: [{ ...edge("e1", "a", "k"), channel: "orders.created" }],
    });

    expect(toLevelEdges(g)[0].channel).toBe("orders.created");
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

// Свои правки меты в данных схемы страницы (context.md X20). Схема держит свой
// снимок контекст-графа, поэтому свежий узел страницы вливается в него точечно —
// иначе смена типа/имени/статуса видна только после перезагрузки.
describe("withOwnEdits", () => {
  // Узел схемы и узел страницы — одна строка БД в разных снимках: свежесть решает
  // version (CAS-счётчик), счётчики детей на странице считаются по релевантным.
  const full = (over: Partial<Node>): Node => ({
    id: "n1", name: "Сервис оплаты", description: null, role: null, technology: null,
    parent_id: null, shape: "service", is_external: false, status: "existing",
    openapi_spec: null, docs: [], version: 1, child_count: 0, has_children: false,
    created_at: "", updated_at: "",
    ...over,
  } as Node);

  it("своя свежая правка вливается в узел схемы", () => {
    const g = graph({ nodes: [full({ shape: "service", version: 1 })] });
    const out = withOwnEdits(g, full({ shape: "database", status: "planned", version: 2 }));
    expect(out.nodes[0]).toMatchObject({ id: "n1", shape: "database", status: "planned" });
  });

  it("чужая правка, приехавшая рефетчем, устаревшим узлом страницы не затирается", () => {
    // Чужая сессия сменила тип → graph_rev → рефетч контекста принёс version 5.
    // Локальный узел страницы (version 1) о ней ещё не знает и молчать обязан.
    const g = graph({ nodes: [full({ shape: "broker", version: 5 })] });
    const out = withOwnEdits(g, full({ shape: "service", version: 1 }));
    expect(out.nodes[0]).toMatchObject({ shape: "broker", version: 5 });
  });

  it("счётчики детей остаются схемными (релевантные, X16 v2)", () => {
    const g = graph({ nodes: [full({ version: 1, child_count: 1, has_children: true })] });
    const out = withOwnEdits(g, full({ name: "Новое имя", version: 2, child_count: 7, has_children: true }));
    expect(out.nodes[0]).toMatchObject({ name: "Новое имя", child_count: 1, has_children: true });
  });

  it("соседей не трогает и исходный граф не мутирует", () => {
    const сосед = full({ id: "x", name: "Шлюз" });
    const g = graph({ nodes: [full({ version: 1 }), сосед] });
    const out = withOwnEdits(g, full({ name: "Новое имя", version: 2 }));
    expect(out.nodes[1]).toBe(сосед);
    expect(g.nodes[0]).toMatchObject({ name: "Сервис оплаты" });
  });
});
