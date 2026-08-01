import { describe, it, expect } from "vitest";
import { compareByRank } from "../../types";
import type { Node, NodeShape } from "../../types";

// Порядок сиблингов в дереве: ранг формы (сервисы с детьми → атомарные сервисы →
// БД → брокеры → персоны), внутри ранга — внутренние раньше внешних, затем по
// имени. См. types/index.ts.

function n(
  name: string,
  opts: { external?: boolean; kids?: number; shape?: NodeShape } = {},
): Node {
  const kids = opts.kids ?? 0;
  return {
    id: name, name, description: null, role: null, technology: null,
    parent_id: null, openapi_spec: null, docs: [],
    is_external: opts.external ?? false, shape: opts.shape ?? "service",
    status: "existing",
    child_count: kids, has_children: kids > 0,
    version: 1,
    created_at: "2026-07-13T00:00:00Z", updated_at: "2026-07-13T00:00:00Z",
  };
}

const order = (ns: Node[]): string[] => [...ns].sort(compareByRank).map((x) => x.name);

describe("compareByRank", () => {
  it("ранг формы: сервисы с детьми → атомарные → БД → брокеры → персоны", () => {
    const rich = n("Ядро", { kids: 5 });
    const atomic = n("Атомарный");
    const db = n("База", { shape: "database" });
    const broker = n("Брокер", { shape: "broker" });
    const person = n("Пользователь", { shape: "person" });
    expect(order([person, broker, db, atomic, rich]))
      .toEqual(["Ядро", "Атомарный", "База", "Брокер", "Пользователь"]);
  });

  it("число детей внутри ранга не влияет — только алфавит", () => {
    const a = n("a", { kids: 1 });
    const b = n("b", { kids: 9 });
    const c = n("c", { kids: 3 });
    expect(order([c, b, a])).toEqual(["a", "b", "c"]);
  });

  it("ранг формы первичнее is_external: внешний контейнер — после внутренних контейнеров, но перед атомарными", () => {
    const inRich = n("in-core", { kids: 10 });
    const exRich = n("ex-core", { kids: 2, external: true });
    const inAtomic = n("in-atomic");
    expect(order([inAtomic, exRich, inRich])).toEqual(["in-core", "ex-core", "in-atomic"]);
  });

  it("внутри ранга — внутренние раньше внешних, затем по имени", () => {
    const exApi = n("Api", { external: true });
    const inCore = n("Core");
    const exCore = n("Core", { external: true });
    const inApi = n("Api");
    expect(order([exApi, exCore, inCore, inApi])).toEqual(["Api", "Core", "Api", "Core"]);
  });

  it("персоны — всегда в конце, между собой по алфавиту", () => {
    const p2 = n("Покупатель", { shape: "person" });
    const p1 = n("Админ", { shape: "person" });
    const svc = n("Сервис", { kids: 1 });
    expect(order([p2, p1, svc])).toEqual(["Сервис", "Админ", "Покупатель"]);
  });
});
